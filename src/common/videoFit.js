// Copyright (C) 2017-2024 Smart code 203358507
// Shared helpers for fitting a YouTube trailer into a container without
// visible black bars. Extracted from MetaItem so HeroBanner can reuse the
// same letterbox-detection + noembed AR logic.
//
//   fetchVideoAR(ytId)       -> Promise<number>   (real video aspect ratio, fallback 16:9)
//   detectLetterboxing(ytId) -> Promise<{top,bottom}>   (fractions of iframe height)

const CARD_AR = 16 / 9;

const letterboxCache = {};
const arCache = {};

function analyzeFrame(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);

    const w = canvas.width;
    const h = canvas.height;
    const threshold = 30;
    const sampleLeft = Math.floor(w * 0.1);
    const sampleWidth = Math.floor(w * 0.8);

    const isRowBlack = (y) => {
        const row = ctx.getImageData(sampleLeft, y, sampleWidth, 1).data;
        let dark = 0;
        let total = 0;
        for (let x = 0; x < row.length; x += 16) {
            total++;
            if (row[x] <= threshold && row[x + 1] <= threshold && row[x + 2] <= threshold) {
                dark++;
            }
        }
        return dark / total >= 0.80;
    };

    let topBar = 0;
    for (let y = 0; y < h * 0.35; y++) {
        if (!isRowBlack(y)) break;
        topBar = y + 1;
    }

    let bottomBar = 0;
    for (let y = h - 1; y > h * 0.65; y--) {
        if (!isRowBlack(y)) break;
        bottomBar = h - y;
    }

    // YouTube thumbnails are sometimes 4:3 with padding on a 16:9 video, so
    // subtract that baked padding before reporting bars relative to the video.
    const thumbAR = w / h;
    const VIDEO_AR = 16 / 9;
    if (Math.abs(thumbAR - VIDEO_AR) < 0.1) {
        return { top: topBar / h, bottom: bottomBar / h };
    }
    const paddingPerSide = (1 - (thumbAR / VIDEO_AR)) / 2;
    const contentFrac = 1 - 2 * paddingPerSide;
    return {
        top: Math.max(0, (topBar / h - paddingPerSide) / contentFrac),
        bottom: Math.max(0, (bottomBar / h - paddingPerSide) / contentFrac),
    };
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject();
        img.src = url;
    });
}

async function detectLetterboxing(ytId) {
    if (!ytId) return { top: 0, bottom: 0 };
    if (letterboxCache[ytId]) return letterboxCache[ytId];
    const noBars = { top: 0, bottom: 0 };

    try {
        const frames = await Promise.allSettled([
            loadImage(`https://i.ytimg.com/vi/${ytId}/1.jpg`),
            loadImage(`https://i.ytimg.com/vi/${ytId}/2.jpg`),
            loadImage(`https://i.ytimg.com/vi/${ytId}/3.jpg`),
        ]);

        const analyses = frames
            .filter((f) => f.status === 'fulfilled')
            .map((f) => analyzeFrame(f.value));

        if (analyses.length === 0) {
            letterboxCache[ytId] = noBars;
            return noBars;
        }

        // Use the smallest bar across sampled frames — if any frame is full-frame,
        // the source video doesn't have baked-in letterboxing.
        const topFrac = Math.min(...analyses.map((a) => a.top));
        const bottomFrac = Math.min(...analyses.map((a) => a.bottom));

        const result = {
            top: topFrac > 0.03 ? topFrac : 0,
            bottom: bottomFrac > 0.03 ? bottomFrac : 0,
        };

        // Sanity clamp — unusually huge bars are probably a detection error.
        if (result.top > 0.25 || result.bottom > 0.25) {
            letterboxCache[ytId] = noBars;
            return noBars;
        }

        letterboxCache[ytId] = result;
        return result;
    } catch (e) {
        letterboxCache[ytId] = noBars;
        return noBars;
    }
}

async function fetchVideoAR(ytId) {
    if (!ytId) return CARD_AR;
    if (arCache[ytId]) return arCache[ytId];
    try {
        const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}`);
        const data = await res.json();
        if (data && data.width && data.height > 0) {
            const ar = data.width / data.height;
            if (ar >= 1.2 && ar <= 3.5) {
                arCache[ytId] = ar;
                return ar;
            }
        }
    } catch { /* silent */ }
    arCache[ytId] = CARD_AR;
    return CARD_AR;
}

module.exports = {
    CARD_AR,
    detectLetterboxing,
    fetchVideoAR,
};
