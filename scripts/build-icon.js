// Convert SVG icon to PNG at multiple sizes
const sharp = require('sharp');
const path = require('path');

const src = path.join(__dirname, '..', 'assets', 'icon.svg');
const outDir = path.join(__dirname, '..', 'assets');

async function main() {
  // 512x512 PNG — used by electron-builder and as the app icon
  await sharp(src).resize(512, 512).png().toFile(path.join(outDir, 'icon.png'));
  console.log('Created assets/icon.png (512x512)');

  // 256x256 PNG — Windows taskbar / BrowserWindow icon
  await sharp(src).resize(256, 256).png().toFile(path.join(outDir, 'icon-256.png'));
  console.log('Created assets/icon-256.png (256x256)');
}

main().catch((err) => { console.error(err); process.exit(1); });
