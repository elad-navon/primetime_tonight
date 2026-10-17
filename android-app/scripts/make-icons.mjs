// Every Prime Time icon from one drawing: a bookmark outline in white, on a transparent background.
// Rendered with the browser Playwright installs (no image library).
//
//   npm run icons        (from android-app/)
//
// Writes, overwriting:
//  - the website (repository root): icons/icon-{16,32,64,96,180,192,512}.png (white, transparent - no maskable
//    icon on purpose, see the README), icons/apple-touch-icon.png (white on the site's #0a0d16: iOS turns
//    transparent pixels black anyway), icons/favicon.svg (the browser tab: white on a dark tab, #0a0d16 on a
//    light one) and icons/favicon-32.png (white on a dark square, for browsers without SVG icons);
//  - the Android app (android/app/src/main/res): the launcher icon (white, transparent background, as large
//    as a launcher shows safely), the launch screens (white on #0a0d16) and the small status-bar icon of the
//    reminders (ic_stat_pt, white - Android tints it).
// After changing the icons, raise ?v= in index.html and manifest.json (see the README).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', '..');
const RES = join(HERE, '..', 'android', 'app', 'src', 'main', 'res');
const DARK = '#0a0d16';
const WHITE = '#ffffff';

/** The bookmark on a 64-unit grid; BOX frames just the drawing, stroke included. */
const glyph = (color) =>
  `<path d="M18 9.5h28a2 2 0 0 1 2 2V55l-16-11.5L16 55V11.5a2 2 0 0 1 2-2z" fill="none" stroke="${color}" stroke-width="3.8" stroke-linejoin="round"/>`;
const BOX = { x: 14, y: 7.5, w: 36, h: 49.5 };

/** width x height, the drawing centred at `size` x the shorter side tall; background: none, 'full' or 'rounded'. */
function svg({ width, height = width, size, color = WHITE, background = null }) {
  const side = Math.min(width, height);
  const h = side * size;
  const w = (h * BOX.w) / BOX.h;
  const bg = {
    full: `<rect width="${width}" height="${height}" fill="${DARK}"/>`,
    rounded: `<rect width="${width}" height="${height}" rx="${side * 0.22}" fill="${DARK}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${background ? bg[background] : ''}
  <svg x="${(width - w) / 2}" y="${(height - h) / 2}" width="${w}" height="${h}" viewBox="${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}">${glyph(color)}</svg>
</svg>
`;
}

const jobs = [];
const png = (file, options) => jobs.push({ file, options });

// Website
for (const size of [16, 32, 64, 96, 180, 192, 512]) png(join(SITE, 'icons', `icon-${size}.png`), { width: size, size: size <= 32 ? 0.96 : 0.9 });
png(join(SITE, 'icons', 'apple-touch-icon.png'), { width: 180, size: 0.62, background: 'full' });
png(join(SITE, 'icons', 'favicon-32.png'), { width: 32, size: 0.78, background: 'rounded' });
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${BOX.x - 7.25} ${BOX.y} ${BOX.h} ${BOX.h}">
  <style>
    path { stroke: ${DARK}; }
    @media (prefers-color-scheme: dark) { path { stroke: ${WHITE}; } }
  </style>
  ${glyph(DARK)}
</svg>
`;

// Android app
if (existsSync(RES)) {
  for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    // Adaptive (Android 8+): the drawing alone on the 108dp canvas over a transparent background.
    png(join(RES, `mipmap-${density}`, 'ic_launcher_foreground.png'), { width: 108 * scale, size: 0.6 });
    // Older launchers: the drawing alone.
    png(join(RES, `mipmap-${density}`, 'ic_launcher.png'), { width: 48 * scale, size: 0.88 });
    png(join(RES, `mipmap-${density}`, 'ic_launcher_round.png'), { width: 48 * scale, size: 0.84 });
    // The reminders' status-bar icon (24dp, white; Android draws it in the system colour).
    png(join(RES, `drawable-${density}`, 'ic_stat_pt.png'), { width: 24 * scale, size: 0.86 });
  }
  const splashes = {
    drawable: [480, 320],
    'drawable-land-mdpi': [480, 320],
    'drawable-land-hdpi': [800, 480],
    'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960],
    'drawable-land-xxxhdpi': [1920, 1280],
    'drawable-port-mdpi': [320, 480],
    'drawable-port-hdpi': [480, 800],
    'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600],
    'drawable-port-xxxhdpi': [1280, 1920],
  };
  for (const [dir, [width, height]] of Object.entries(splashes)) png(join(RES, dir, 'splash.png'), { width, height, size: 0.3, background: 'full' });
  writeFileSync(
    join(RES, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#00000000</color>
    <color name="splash_background">${DARK}</color>
</resources>
`,
  );
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, options } of jobs) {
  const width = options.width;
  const height = options.height ?? width;
  await page.setViewportSize({ width, height });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(options)}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await page.screenshot({ omitBackground: true }));
}
await browser.close();
writeFileSync(join(SITE, 'icons', 'favicon.svg'), favicon);
console.log(`icons written (${jobs.length} images + favicon.svg)`);
