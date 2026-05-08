// Renders assets/images/stremio_custom_logo.svg into all the PNG / ICO
// sizes the app needs (favicon, PWA manifest icons, in-app logos, and the
// .exe icon used by /win32icon at compile time).
//
// Run with:
//   node scripts/generate-icons.js
//
// Idempotent — safe to re-run after editing the source SVG.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'assets', 'images', 'stremio_custom_logo.svg');
const IMAGES_DIR = path.join(ROOT, 'assets', 'images');
const FAVICONS_DIR = path.join(ROOT, 'assets', 'favicons');

// Maskable icons need a "safe area": the visible content must stay within
// the inner 80% (40% radius) circle so OS launchers can crop it freely.
// Our diamond is comfortably inside that bound, but we add 10% padding to
// be safe across Android adaptive-icon shapes.
async function renderPng(size, { padPercent = 0 } = {}) {
    const inner = Math.round(size * (1 - padPercent / 100));
    const offset = Math.round((size - inner) / 2);
    const inner_buf = await sharp(SVG_PATH, { density: 384 })
        .resize(inner, inner)
        .png()
        .toBuffer();
    return sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: inner_buf, top: offset, left: offset }])
        .png()
        .toBuffer();
}

async function writeFile(filePath, buf) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    console.log(`  ${path.relative(ROOT, filePath)}  (${buf.length} bytes)`);
}

(async () => {
    if (!fs.existsSync(SVG_PATH)) {
        console.error(`Missing source SVG: ${SVG_PATH}`);
        process.exit(1);
    }

    console.log('Rendering app PNGs...');
    // In-app logos (used by NavBar and Intro components)
    await writeFile(path.join(IMAGES_DIR, 'logo.png'), await renderPng(512));
    await writeFile(path.join(IMAGES_DIR, 'stremio_symbol.png'), await renderPng(256));
    await writeFile(path.join(IMAGES_DIR, 'icon.png'), await renderPng(256));

    // PWA "any" icons — full-bleed
    await writeFile(path.join(IMAGES_DIR, 'icon_196x196.png'), await renderPng(196));
    await writeFile(path.join(IMAGES_DIR, 'icon_512x512.png'), await renderPng(512));

    // PWA "maskable" icons — 10% safe-area padding
    await writeFile(path.join(IMAGES_DIR, 'maskable_icon.png'), await renderPng(512, { padPercent: 10 }));
    await writeFile(path.join(IMAGES_DIR, 'maskable_icon_196x196.png'), await renderPng(196, { padPercent: 10 }));
    await writeFile(path.join(IMAGES_DIR, 'maskable_icon_512x512.png'), await renderPng(512, { padPercent: 10 }));

    console.log('Rendering ICO sources...');
    // Browser favicon — multi-size for sharp rendering at every common scale
    const faviconSizes = [16, 24, 32, 48, 64];
    const faviconPngs = await Promise.all(faviconSizes.map((s) => renderPng(s)));
    const faviconIco = await pngToIco(faviconPngs);
    await writeFile(path.join(FAVICONS_DIR, 'favicon.ico'), faviconIco);

    // PWA manifest references favicons/icon_256x256.ico
    const ico256 = await pngToIco([await renderPng(256)]);
    await writeFile(path.join(FAVICONS_DIR, 'icon_256x256.ico'), ico256);

    // Launcher .exe icon — embedded via /win32icon at csc.exe compile time.
    // Windows uses 16/24/32/48 in Explorer + tray, 64/128/256 for large views.
    const launcherSizes = [16, 24, 32, 48, 64, 128, 256];
    const launcherPngs = await Promise.all(launcherSizes.map((s) => renderPng(s)));
    const launcherIco = await pngToIco(launcherPngs);
    await writeFile(path.join(ROOT, 'StremioLauncher.ico'), launcherIco);

    console.log('Done.');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
