const TARGET_SAMPLE_RATE = 16000;
const FETCH_TIMEOUT_MS = 30000;

function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    const merged = { ...opts, signal: controller.signal };
    return fetch(url, merged).finally(() => clearTimeout(timer));
}

/**
 * Fetch a single segment with retry. The HLS transcoder processes segments
 * sequentially, so early requests for a segment may fail with 500 if ffmpeg
 * hasn't reached that point yet. Retrying after a short delay lets the
 * transcoder catch up.
 */
async function fetchSegmentWithRetry(url, maxRetries) {
    const retries = maxRetries || 3;
    for (let attempt = 0; attempt < retries; attempt++) {
        const r = await fetchWithTimeout(url, {}, 90000);
        if (r.ok) return r.arrayBuffer();

        const body = await r.text().catch(() => '');
        const isTranscoderBehind = body.includes('Segment is canceled') || body.includes('stream ended');

        // If the transcoder just hasn't caught up, wait and retry
        if (isTranscoderBehind && attempt < retries - 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
            continue;
        }

        throw new Error(`Segment failed (${r.status}): ${body.substring(0, 100)}`);
    }
}

/**
 * Creates a reusable audio session backed by the streaming server's HLS
 * transcoder. Fetches the playlist and init segment once, then individual
 * segments can be requested at any offset.
 */
async function createAudioSession(streamingServerUrl, streamContent) {
    const ssUrl = streamingServerUrl.replace(/\/$/, '');
    const fetchBase = getFetchBase(ssUrl);
    const mediaUrl = buildMediaUrl(ssUrl, streamContent);

    const id = 'whisper_' + Math.random().toString(36).slice(2);
    const qp = new URLSearchParams();
    qp.set('mediaURL', mediaUrl);
    qp.append('audioCodecs', 'aac');
    qp.set('maxAudioChannels', '1');

    const masterUrl = `${fetchBase}/hlsv2/${id}/master.m3u8?${qp}`;

    // ── Master playlist ──
    const masterResp = await fetchWithTimeout(masterUrl, {}, 60000);
    if (!masterResp.ok) throw new Error(`Transcode failed (${masterResp.status})`);
    const masterText = await masterResp.text();

    // Extract audio playlist URI
    const masterLines = masterText.split('\n').map((l) => l.trim());
    let playlistRel = null;
    for (const line of masterLines) {
        const m = line.match(/#EXT-X-MEDIA:TYPE=AUDIO.*URI="([^"]+)"/);
        if (m) { playlistRel = m[1]; break; }
    }
    if (!playlistRel) {
        playlistRel = masterLines.find((l) => l && !l.startsWith('#'));
    }
    if (!playlistRel) throw new Error('No audio playlist in HLS manifest');
    const playlistUrl = resolveHlsUrl(playlistRel, masterUrl, fetchBase);

    // ── Audio media playlist ──
    const plResp = await fetchWithTimeout(playlistUrl, {}, 90000);
    if (!plResp.ok) throw new Error(`Audio playlist failed (${plResp.status})`);
    const plText = await plResp.text();

    const { initUrl, segments } = parsePlaylist(plText, playlistUrl, fetchBase);

    // ── Pre-fetch init segment ──
    let initBuf = null;
    if (initUrl) {
        const r = await fetchWithTimeout(initUrl, {}, 60000);
        if (r.ok) initBuf = await r.arrayBuffer();
    }

    return {
        duration: segments.length > 0
            ? segments[segments.length - 1].time + segments[segments.length - 1].duration
            : 0,

        async getChunk(startSec, durationSec) {
            const endSec = startSec + durationSec;
            const selected = segments.filter(
                (s) => (s.time + s.duration) > startSec && s.time < endSec,
            );
            if (selected.length === 0) {
                throw new Error('No audio segments in requested time range');
            }

            // Fetch segments one at a time with retry — gives the transcoder
            // time to catch up if it hasn't processed this far yet.
            const segBufs = [];
            for (const seg of selected) {
                segBufs.push(await fetchSegmentWithRetry(seg.url, 4));
            }

            // Concatenate: init + segments
            const parts = initBuf ? [initBuf, ...segBufs] : segBufs;
            const totalLen = parts.reduce((s, b) => s + b.byteLength, 0);
            const combined = new Uint8Array(totalLen);
            let off = 0;
            for (const buf of parts) {
                combined.set(new Uint8Array(buf), off);
                off += buf.byteLength;
            }

            // Decode audio
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            let audioBuffer;
            try {
                audioBuffer = await ctx.decodeAudioData(combined.buffer.slice(0));
            } catch (_) {
                await ctx.close();
                throw new Error('Could not decode audio segment');
            }

            // Resample to 16 kHz mono
            const outLen = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE);
            const offCtx = new OfflineAudioContext(1, outLen, TARGET_SAMPLE_RATE);
            const src = offCtx.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(offCtx.destination);
            src.start();
            const resampled = await offCtx.startRendering();
            await ctx.close();

            const pcm = new Float32Array(resampled.getChannelData(0));

            return {
                audio: pcm,
                sampleRate: TARGET_SAMPLE_RATE,
                startTime: selected[0].time,
                duration: audioBuffer.duration,
            };
        },

        close() { },
    };
}

// ── URL helpers ──

/**
 * Builds the mediaURL for the HLS transcoder.
 *
 * For torrents: streaming server's own torrent endpoint.
 * For HTTP streams: route through the streaming server's proxy so ffmpeg
 * reads from localhost. This avoids redirect/auth issues with debrid URLs
 * and lets the streaming server reuse its existing connection to the CDN.
 */
function buildMediaUrl(ssUrl, streamContent) {
    if (streamContent && typeof streamContent.infoHash === 'string') {
        const idx = streamContent.fileIdx != null && isFinite(streamContent.fileIdx)
            ? streamContent.fileIdx : 0;
        return `${ssUrl}/${encodeURIComponent(streamContent.infoHash)}/${encodeURIComponent(idx)}`;
    }

    if (streamContent && typeof streamContent.url === 'string') {
        if (streamContent.url.startsWith('magnet:')) {
            const m = streamContent.url.match(/btih:([a-fA-F0-9]{40})/i)
                || streamContent.url.match(/btih:([a-zA-Z2-7]{32})/i);
            if (m) return `${ssUrl}/${encodeURIComponent(m[1].toLowerCase())}/0`;
        }
        if (streamContent.url.startsWith('http')) {
            const parsed = new URL(streamContent.url);
            return `${ssUrl}/proxy/d=${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`;
        }
    }

    throw new Error('Could not determine media URL for audio extraction');
}

function getFetchBase(ssUrl) {
    try {
        const ssOrigin = new URL(ssUrl).origin;
        // Same origin — no prefix needed (e.g. dev mode where SS is the page origin)
        if (ssOrigin === window.location.origin) return '';
        // Check if the webpack dev server proxy is available by seeing if we're
        // on localhost (dev). Otherwise use the streaming server URL directly
        // (e.g. GitHub Pages or Stremio Shell with remote webui-url).
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return '/streaming-server';
        }
        // Direct access — used by Stremio Shell / hosted deployments
        return ssUrl.replace(/\/$/, '');
    } catch (_) { /* */ }
    return '/streaming-server';
}

function resolveHlsUrl(href, baseManifestUrl, fetchBase) {
    const trimmed = href.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            const u = new URL(trimmed);
            return fetchBase + u.pathname + u.search;
        } catch (_) {
            return trimmed;
        }
    }
    if (trimmed.startsWith('/')) return fetchBase + trimmed;
    const dir = baseManifestUrl.substring(0, baseManifestUrl.lastIndexOf('/') + 1);
    return dir + trimmed;
}

function parsePlaylist(text, playlistUrl, fetchBase) {
    const lines = text.split('\n').map((l) => l.trim());
    let initUrl = null;
    const segments = [];
    let time = 0;

    for (let i = 0; i < lines.length; i++) {
        const mapMatch = lines[i].match(/#EXT-X-MAP:URI="([^"]+)"/);
        if (mapMatch) {
            initUrl = resolveHlsUrl(mapMatch[1], playlistUrl, fetchBase);
            continue;
        }

        if (!lines[i].startsWith('#EXTINF:')) continue;
        const durMatch = lines[i].match(/#EXTINF:([\d.]+)/);
        const segDur = durMatch ? parseFloat(durMatch[1]) : 0;

        for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] && !lines[j].startsWith('#')) {
                segments.push({
                    url: resolveHlsUrl(lines[j], playlistUrl, fetchBase),
                    time,
                    duration: segDur,
                });
                break;
            }
        }
        time += segDur;
    }

    return { initUrl, segments };
}

module.exports = { createAudioSession, TARGET_SAMPLE_RATE };
