// Convert logo to PNG at multiple sizes with a subtle border for dark-background visibility
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Source-of-truth for the dark icon is now icon/POTACAT-icon-1024-AppStore.png
// (the same master used for the iOS App Store submission). The legacy
// potacat-logo.jpg is kept as a fallback for older clones.
const newMaster = path.join(__dirname, '..', 'icon', 'POTACAT-icon-1024-AppStore.png');
const legacyDark = path.join(__dirname, '..', 'potacat-logo.jpg');
const srcDark = fs.existsSync(newMaster) ? newMaster : legacyDark;
const srcLight = path.join(__dirname, '..', 'potacat-logo_light.jpg');
const outDir = path.join(__dirname, '..', 'assets');

/**
 * Create an SVG rounded-rect border ring overlay.
 * The ring is drawn just inside the edges so it doesn't get clipped.
 */
function borderRing(size, strokeWidth, radius, color) {
  const half = strokeWidth / 2;
  return Buffer.from(`<svg width="${size}" height="${size}">
    <rect x="${half}" y="${half}" width="${size - strokeWidth}" height="${size - strokeWidth}"
          rx="${radius}" ry="${radius}"
          fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>
  </svg>`);
}

async function buildVariant(src, suffix, borderColor) {
  // The new master (icon/POTACAT-icon-1024-AppStore.png) has its own
  // visual treatment baked in — no border overlay needed. Skip the
  // border ring when running off the new master so we don't paint
  // over the artwork.
  const skipBorder = src === newMaster;

  // 512x512 PNG — used by electron-builder and as the app icon
  let s512 = sharp(src).resize(512, 512).png();
  if (!skipBorder) {
    const buf = await s512.toBuffer();
    s512 = sharp(buf).composite([{ input: borderRing(512, 4, 12, borderColor), top: 0, left: 0 }]).png();
  }
  await s512.toFile(path.join(outDir, `icon${suffix}.png`));
  console.log(`Created assets/icon${suffix}.png (512x512)`);

  // 256x256 PNG — Windows taskbar / BrowserWindow icon
  let s256 = sharp(src).resize(256, 256).png();
  if (!skipBorder) {
    const buf = await s256.toBuffer();
    s256 = sharp(buf).composite([{ input: borderRing(256, 3, 8, borderColor), top: 0, left: 0 }]).png();
  }
  await s256.toFile(path.join(outDir, `icon${suffix}-256.png`));
  console.log(`Created assets/icon${suffix}-256.png (256x256)`);
}

async function buildIco(src) {
  // Multi-resolution .ico for the Windows .exe + installer. electron-builder
  // picks this up via build.win.icon in package.json. png-to-ico bundles
  // the per-size PNGs Windows needs (16-256).
  let pngToIco;
  try { pngToIco = require('png-to-ico').default || require('png-to-ico'); }
  catch (err) {
    console.warn('Skipping icon.ico (png-to-ico not installed):', err.message);
    return;
  }
  const sizes = [16, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(sizes.map(s => sharp(src).resize(s, s).png().toBuffer()));
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log(`Created assets/icon.ico (${sizes.join(',')})`);
}

async function main() {
  // Dark icon (default) — light border on legacy master, none on new master
  await buildVariant(srcDark, '', 'rgba(255,255,255,0.25)');

  // Light icon — dark border on legacy master. No new-master light variant
  // exists yet, so this still uses potacat-logo_light.jpg.
  if (fs.existsSync(srcLight)) {
    await buildVariant(srcLight, '-light', 'rgba(0,0,0,0.15)');
  } else {
    console.log('Skipping light variant — potacat-logo_light.jpg not found');
  }

  // Windows .ico — only meaningful when building from the new master.
  // (The old .ico was hand-built with electron-icon-builder.)
  await buildIco(srcDark);
}

main().catch((err) => { console.error(err); process.exit(1); });
