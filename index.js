const puppeteer = require('puppeteer');
const express = require('express');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const STREAM_DIR = path.join(__dirname, 'hls-stream');
const PORT = 3000;
const TARGET_DIV_SELECTOR = '#container';
const INACTIVITY_TIMEOUT_MS = 10000;

let browser, page, boundingBox;
let streamStarted = false;
let screenshotStream;
let ffmpegProcess;
let inactivityTimer;
let restartingPage = false;



// ─── Puppeteer setup ────────────────────────────────────────────────
async function initializeBrowser() {
  if (browser) await browser.close();
  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();

  page.on('error', err => { console.error('Puppeteer page error:', err); safeRestartPage(); });
  page.on('close', () => { console.error('Puppeteer page closed unexpectedly'); safeRestartPage(); });
  page.on('disconnect', () => { console.error('Puppeteer disconnected'); safeRestartPage(); });

  await loadTargetPage();
}

async function loadTargetPage() {
  try {
    await page.goto('https://mwood77.github.io/ws4kp-international/?hazards-checkbox=false&current-weather-checkbox=true&latest-observations-checkbox=false&hourly-checkbox=true&hourly-graph-checkbox=true&travel-checkbox=false&regional-forecast-checkbox=false&local-forecast-checkbox=true&extended-forecast-checkbox=true&almanac-checkbox=true&radar-checkbox=false&marine-forecast-checkbox=true&aqi-forecast-checkbox=true&settings-experimentalFeatures-checkbox=false&settings-hideWebamp-checkbox=false&settings-kiosk-checkbox=false&settings-scanLines-checkbox=false&settings-wide-checkbox=false&chkAutoRefresh=true&settings-windUnits-select=2.00&settings-marineWindUnits-select=1.00&settings-marineWaveHeightUnits-select=1.00&settings-temperatureUnits-select=1.00&settings-distanceUnits-select=1.00&settings-pressureUnits-select=1.00&settings-hoursFormat-select=2.00&settings-speed-select=1.00&latLonQuery=Paris%2C+%C3%8Ele-de-France%2C+FRA&latLon=%7B%22lat%22%3A48.8563%2C%22lon%22%3A2.3525%7D', { waitUntil: 'domcontentloaded' });

    const element = await page.$(TARGET_DIV_SELECTOR);
    if (!element) throw new Error(`Element not found: ${TARGET_DIV_SELECTOR}`);
    boundingBox = await element.boundingBox();
    if (!boundingBox) throw new Error('Bounding box not found');
  } catch (err) {
    console.error('Failed to load target page:', err);
  }
}

function safeRestartPage() {
  if (restartingPage) return;
  restartingPage = true;
  setTimeout(async () => {
    try {
      console.log('Restarting Puppeteer page...');
      if (page && !page.isClosed()) await page.close();
      page = await browser.newPage();
      restartingPage = false;
      await loadTargetPage();
    } catch (err) {
      console.error('Failed to restart Puppeteer page:', err);
      restartingPage = false;
    }
  }, 1000);
}

// ─── Streaming ──────────────────────────────────────────────────────
async function startStream() {
  if (streamStarted) return;
  streamStarted = true;

  if (fs.existsSync(STREAM_DIR)) {
    fs.readdirSync(STREAM_DIR).forEach(f => {
      fs.unlinkSync(path.join(STREAM_DIR, f));
    });
  }

  screenshotStream = new PassThrough();

  ffmpegProcess = ffmpeg()
  .input(screenshotStream)
  .inputFormat('image2pipe')
  .inputOptions(['-framerate 30', '-use_wallclock_as_timestamps 1'])
  .input(path.join(__dirname, 'music.mp3'))
  .inputOptions(['-stream_loop -1'])
  .outputOptions([
    '-vf fps=10',
    '-c:v libx264',
    '-preset ultrafast',
    '-tune zerolatency',
    '-pix_fmt yuv420p',
    '-r 10',
    '-g 11',
    '-hls_time 0.5',
    '-hls_list_size 20',
    '-hls_flags delete_segments+append_list+program_date_time',
    '-hls_allow_cache 0'
  ])
  .output(path.join(STREAM_DIR, 'stream.m3u8'))
  .on('start', cmd => console.log('FFmpeg started:', cmd))
  .on('error', err => { console.error('FFmpeg error:', err.message); stopStream(); })
  .on('end', () => { console.log('FFmpeg ended'); streamStarted = false; })
  .run();



  // Prime screenshots fast
  for (let i = 0; i < 100 && streamStarted; i++) {
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80, clip: boundingBox });
      if (streamStarted && screenshotStream) {
        screenshotStream.write(buffer);
      }
    } catch (err) {
      console.error('Initial screenshot error:', err);
      break;
    }
  }

  // Fast capture loop
  (async function captureLoop() {
    while (streamStarted) {
      try {
        const buffer = await page.screenshot({ type: 'jpeg', quality: 80, clip: boundingBox });
        if (streamStarted && screenshotStream) screenshotStream.write(buffer);
        await new Promise(res => setImmediate(res)); // virtually no delay
      } catch (err) {
        console.error('Screenshot error:', err.message);
        safeRestartPage();
      }
    }
  })();
}

//}

function stopStream() {
  if (!streamStarted) return;
  console.log('Stopping stream due to inactivity');
  streamStarted = false;

  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGINT');
    ffmpegProcess = null;
  }
  if (screenshotStream) {
    screenshotStream.end();
    screenshotStream = null;
  }
}

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(stopStream, INACTIVITY_TIMEOUT_MS);
}

// ─── Express server ───────────────────────────────────────────────
const app = express();

app.get('/*.ts', (req, res, next) => {
  console.log(`TS segment requested: ${req.path}`);
  resetInactivityTimer();
  next();
});

app.get('/stream.m3u8', async (req, res) => {
  try {
    resetInactivityTimer();


    await startStream();

    // Wait for at least 3 real segments to exist
    const maxWait = 1000;
    const pollInterval = 100;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const files = fs.readdirSync(STREAM_DIR).filter(f => f.endsWith('.ts') && f !== 'stream0.ts');
      if (files.length >= 3) break;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    res.sendFile(path.join(STREAM_DIR, 'stream.m3u8'));
  } catch (err) {
    console.error('Error sending stream:', err);
    res.status(500).send('Failed to start stream');
  }
});

app.use('/', express.static(STREAM_DIR));

// Optional test page
app.get('/', (req, res) => {
  res.send(`
    <html>
    <body>
      <h1>HLS Test Stream</h1>
      <video id="video" controls autoplay width="600"></video>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <script>
        const video = document.getElementById('video');
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource('/stream.m3u8');
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
        } else {
          video.src = '/stream.m3u8';
        }
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, async () => {
  await initializeBrowser();
  console.log(`Browser ready. HTTP server running on http://localhost:${PORT}`);
});
