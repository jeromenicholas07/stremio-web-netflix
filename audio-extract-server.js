#!/usr/bin/env node
// ============================================================
//  Audio Extraction Sidecar for WhisperSync
//  Provides fast, seekable audio extraction via FFmpeg.
//  Run: node audio-extract-server.js
//
//  GET /health                              → { status: 'ok' }
//  GET /audio-extract?mediaURL=...&start=0&duration=5  → raw f32le PCM
// ============================================================

const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const PORT = 12471;

// ── Find FFmpeg ──

function findFFmpeg() {
    const candidates = [];

    // 1. ffmpeg-static npm package (bundled binary — most reliable)
    try {
        const ffmpegStatic = require('ffmpeg-static');
        if (ffmpegStatic) candidates.push(ffmpegStatic);
    } catch (_) { /* not installed */ }

    // 2. System PATH
    candidates.push('ffmpeg');

    // 3. Stremio install directories (Windows)
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        if (local) {
            candidates.push(
                path.join(local, 'Programs', 'LNV', 'Stremio-4', 'stremio-runtime', 'ffmpeg.exe'),
                path.join(local, 'Programs', 'Stremio', 'ffmpeg.exe'),
                path.join(local, 'Programs', 'Stremio', 'stremio-runtime', 'ffmpeg.exe'),
            );
        }
        const prog = process.env.ProgramFiles || '';
        if (prog) candidates.push(path.join(prog, 'Stremio', 'ffmpeg.exe'));
    }

    for (const bin of candidates) {
        try {
            execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 });
            return bin;
        } catch (_) { /* try next */ }
    }
    return null;
}

const ffmpegPath = findFFmpeg();
if (!ffmpegPath) {
    console.error('ERROR: FFmpeg not found. Install FFmpeg or add it to PATH.');
    process.exit(1);
}
console.log('Using FFmpeg:', ffmpegPath);

// ── CORS helpers ──

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

// ── Downmix variants ──
//
// Dialogue lives in the centre channel of a 5.1 mix. FFmpeg's default mono
// downmix (-ac 1) folds every channel together, so music and effects from
// L/R/LFE/surrounds arrive at full strength while speech is attenuated.
// Whisper's error rate on a cinematic mix climbs accordingly — and garbage
// transcription is exactly what produces spurious subtitle matches. So take
// the centre channel alone wherever there is one.
const AUDIO_FILTERS = {
    surround: 'pan=mono|c0=FC,dynaudnorm=f=200',
    stereo: 'pan=mono|c0=0.5*FL+0.5*FR,dynaudnorm=f=200',
};

// Which variant a given media URL needs. Probed once, then reused.
const layoutCache = new Map();

// Asking `pan` for FC on a stereo source does NOT fail — it returns a
// perfectly valid buffer of pure silence, exit code 0. So the layout has to
// be established up front rather than inferred from a failure. `ffmpeg -i`
// with no output prints the stream table and exits; that is enough, and it
// avoids shipping an ffprobe binary next to ffmpeg-static.
function detectVariant(mediaURL, headers, callback) {
    if (layoutCache.has(mediaURL)) {
        return callback(layoutCache.get(mediaURL));
    }

    const args = [];
    if (headers) args.push('-headers', headers + '\r\n');
    args.push('-i', mediaURL);

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => ffmpeg.kill('SIGKILL'), 15000);

    const finish = (variant) => {
        clearTimeout(timeout);
        layoutCache.set(mediaURL, variant);
        console.log(`[Extract] Detected ${variant} audio layout`);
        callback(variant);
    };

    ffmpeg.on('close', () => {
        const audioLines = stderr.match(/Audio:[^\r\n]*/g) || [];
        const surround = audioLines.some((line) => /(^|[\s,(])(5\.[01]|6\.1|7\.1|quad)([\s,)]|$)/i.test(line));
        finish(surround ? 'surround' : 'stereo');
    });

    // Probe failed outright — stereo is the safe default, it works on any layout.
    ffmpeg.on('error', () => finish('stereo'));
}

// A centre channel that turns out to carry no dialogue (an unusual mix, or a
// genuinely silent passage) would hand Whisper five seconds of nothing. Cheap
// to check, and the difference between a working sync and a total failure.
function isSilent(buffer) {
    const samples = Math.floor(buffer.length / 4);
    for (let i = 0; i < samples; i++) {
        if (Math.abs(buffer.readFloatLE(i * 4)) > 1e-6) return false;
    }
    return true;
}

// ── Server ──

http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // ── Health check ──
    if (url.pathname === '/health') {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', ffmpeg: ffmpegPath }));
    }

    // ── Audio extraction ──
    if (url.pathname === '/audio-extract') {
        const mediaURL = url.searchParams.get('mediaURL');
        const start = url.searchParams.get('start') || '0';
        const duration = url.searchParams.get('duration') || '5';

        if (!mediaURL) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
            return res.end('Missing mediaURL parameter');
        }

        // Optional custom headers (for debrid auth tokens etc.)
        const headers = url.searchParams.get('headers');

        console.log(`[Extract] start=${start}s duration=${duration}s url=${mediaURL.substring(0, 80)}...`);

        const attempt = (variants, index) => {
            const variant = variants[index];

            // Build FFmpeg arguments
            // -ss BEFORE -i = input seeking (keyframe-based, near-instant at any offset)
            const args = [
                '-ss', start,
                '-i', mediaURL,
                '-t', duration,
                '-vn',                          // no video
                '-af', AUDIO_FILTERS[variant],  // dialogue-focused mono downmix
                '-ac', '1',                     // mono
                '-ar', '16000',                 // 16 kHz for Whisper
                '-f', 'f32le',                  // raw 32-bit float PCM (no header — client wraps directly)
                '-y',
                'pipe:1',
            ];

            if (headers) {
                // Insert -headers before -i
                args.splice(0, 0, '-headers', headers + '\r\n');
            }

            const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

            const chunks = [];
            ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

            let stderr = '';
            ffmpeg.stderr.on('data', (data) => { stderr += data.toString().slice(-500); });

            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                if (!res.headersSent) {
                    res.writeHead(504, { ...CORS, 'Content-Type': 'text/plain' });
                    res.end('FFmpeg extraction timed out (30s)');
                }
            }, 30000);

            ffmpeg.on('close', (code) => {
                clearTimeout(timeout);
                const buffer = Buffer.concat(chunks);
                const unusable = code !== 0 || buffer.length === 0 || isSilent(buffer);

                if (unusable) {
                    if (index + 1 < variants.length) {
                        console.log(`[Extract] ${variant} downmix gave nothing usable — retrying as ${variants[index + 1]}`);
                        return attempt(variants, index + 1);
                    }
                    console.error(`[Extract] FFmpeg exit code ${code}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                        res.end(`FFmpeg error (code ${code}): ${stderr.slice(-200)}`);
                    }
                    return;
                }

                console.log(`[Extract] Done — ${buffer.length} bytes (${(buffer.length / 4 / 16000).toFixed(1)}s of audio, ${variant})`);
                res.writeHead(200, {
                    ...CORS,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': buffer.length,
                });
                res.end(buffer);
            });

            ffmpeg.on('error', (err) => {
                clearTimeout(timeout);
                if (!res.headersSent) {
                    res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                    res.end(`FFmpeg spawn error: ${err.message}`);
                }
            });
        };

        // Surround keeps stereo as a safety net in case the centre channel is
        // empty; a stereo downmix already works on any layout.
        detectVariant(mediaURL, headers, (variant) => {
            attempt(variant === 'surround' ? ['surround', 'stereo'] : ['stereo'], 0);
        });

        return;
    }

    // ── 404 ──
    res.writeHead(404, CORS);
    res.end('Not found');

}).listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Audio Extract Server running on http://127.0.0.1:${PORT}`);
    console.log('  Endpoints:');
    console.log('    GET /health');
    console.log('    GET /audio-extract?mediaURL=...&start=0&duration=5\n');
});
