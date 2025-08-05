const puppeteer = require('puppeteer');
const express = require('express');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const STREAM_DIR = path.join(__dirname, 'hls-stream');
const PORT = 3000;
const TARGET_DIV_SELECTOR = '#container';  // <<< Change this to your div's CSS selector

async function startStream() {
  // Clean up previous stream files
  if (fs.existsSync(STREAM_DIR)) {
    fs.rmSync(STREAM_DIR, { recursive: true });
  }
  fs.mkdirSync(STREAM_DIR);

  // Write minimal empty playlist for immediate client load
  fs.writeFileSync(
    path.join(STREAM_DIR, 'stream.m3u8'),
    `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0
`
  );

  // Launch Puppeteer browser & page
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://mwood77.github.io/ws4kp-international/?hazards-checkbox=false&current-weather-checkbox=true&latest-observations-checkbox=false&hourly-checkbox=true&hourly-graph-checkbox=true&travel-checkbox=false&regional-forecast-checkbox=false&local-forecast-checkbox=true&extended-forecast-checkbox=true&almanac-checkbox=true&radar-checkbox=false&marine-forecast-checkbox=true&aqi-forecast-checkbox=true&settings-experimentalFeatures-checkbox=false&settings-hideWebamp-checkbox=false&settings-kiosk-checkbox=false&settings-scanLines-checkbox=false&settings-wide-checkbox=false&chkAutoRefresh=true&settings-windUnits-select=2.00&settings-marineWindUnits-select=1.00&settings-marineWaveHeightUnits-select=1.00&settings-temperatureUnits-select=1.00&settings-distanceUnits-select=1.00&settings-pressureUnits-select=1.00&settings-hoursFormat-select=2.00&settings-speed-select=1.00&latLonQuery=Paris%2C+%C3%8Ele-de-France%2C+FRA&latLon=%7B%22lat%22%3A48.8563%2C%22lon%22%3A2.3525%7D', { waitUntil: 'domcontentloaded' });

  // Get bounding box of the target div
  const element = await page.$(TARGET_DIV_SELECTOR);
  if (!element) {
    throw new Error(`Element not found for selector: ${TARGET_DIV_SELECTOR}`);
  }
  const boundingBox = await element.boundingBox();
  if (!boundingBox) {
    throw new Error('Bounding box not found (element might be hidden)');
  }

  const screenshotStream = new PassThrough();

  // Start FFmpeg process
  ffmpeg()
    .input(screenshotStream)
    .inputFormat('image2pipe')
    .inputOptions('-framerate 10')
    .outputOptions([
      '-c:v libx264',
      '-preset ultrafast',
      '-tune zerolatency',
      '-pix_fmt yuv420p',
      '-g 10', // keyframe every 1 second (at 10fps)
      '-f hls',
      '-hls_time 0.5',
      '-hls_list_size 3',
      '-hls_flags delete_segments+append_list+omit_endlist',
      '-hls_allow_cache 0',
    ])
    .output(path.join(STREAM_DIR, 'stream.m3u8'))
    .on('start', cmd => console.log('FFmpeg started:', cmd))
    .on('error', err => console.error('FFmpeg error:', err.message))
    .on('end', () => console.log('FFmpeg ended'))
    .run();

  // Send a few initial clipped screenshots quickly to prime FFmpeg & playlist
  for (let i = 0; i < 5; i++) {
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      clip: {
        x: boundingBox.x,
        y: boundingBox.y,
        width: Math.min(boundingBox.width, page.viewport().width - boundingBox.x),
        height: Math.min(boundingBox.height, page.viewport().height - boundingBox.y),
      },
    });
    screenshotStream.write(buffer);
  }

  // Continue capturing clipped screenshots at 10fps
  (async function captureLoop() {
    while (true) {
      await new Promise(res => setTimeout(res, 100));
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 80,
        clip: {
          x: boundingBox.x,
          y: boundingBox.y,
          width: Math.min(boundingBox.width, page.viewport().width - boundingBox.x),
          height: Math.min(boundingBox.height, page.viewport().height - boundingBox.y),
        },
      });
      screenshotStream.write(buffer);
    }
  })();
}

const app = express();

// Serve HLS stream folder statically
app.use('/', express.static(STREAM_DIR));

app.listen(PORT, () => {
  console.log(`HTTP server running on http://localhost:${PORT}`);
  startStream().catch(console.error);
});
