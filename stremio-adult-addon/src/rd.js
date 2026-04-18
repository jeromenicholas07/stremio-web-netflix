// Real-Debrid resolver.
//
// Stremio's built-in magnet-to-RD swap is unreliable for non-indexed content
// (adult, niche trackers), so we do the full RD flow ourselves:
//
//   1. addMagnet(magnet)                → { id }
//   2. selectFiles(id, "all")           → torrent now downloading / cached
//   3. poll torrents/info/{id} until status === "downloaded"
//      (cached torrents jump straight to "downloaded")
//   4. unrestrict/link(links[biggestVideoIdx]) → { download: "https://..." }
//
// We expose POST /rd/resolve { infoHash, title, token } → { url } for the
// web client. Results cached per (infoHash, token) for 45 minutes (RD links
// stay valid ~7 days but caching shorter is safer if a file was removed).

const fetch = require('node-fetch');
const { LRUCache } = require('lru-cache');

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

const cache = new LRUCache({ max: 500, ttl: 45 * 60 * 1000 });

const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce',
];

function magnetFor(infoHash, title) {
    const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
    const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

// The largest file in a torrent is almost always the main video. We pick it
// by size rather than trying to parse extensions because adult releases
// often ship in containers without a canonical extension.
function pickMainFileIdx(files) {
    if (!Array.isArray(files) || files.length === 0) return null;
    let bestIdx = 0;
    let bestSize = -1;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f) continue;
        const size = Number(f.bytes) || 0;
        const path = String(f.path || '').toLowerCase();
        // Skip obvious non-video containers
        if (/\.(txt|nfo|jpg|jpeg|png|srt|ass|idx|sub|url)$/i.test(path)) continue;
        if (size > bestSize) {
            bestSize = size;
            bestIdx = i;
        }
    }
    return bestIdx;
}

async function rdFetch(token, method, path, body) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
        },
        timeout: 15000,
    };
    if (body) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    }
    const res = await fetch(`${RD_BASE}${path}`, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, body: json, raw: text };
}

async function pollTorrentReady(token, torrentId, { timeoutMs = 25000, intervalMs = 1500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await rdFetch(token, 'GET', `/torrents/info/${torrentId}`);
        if (!r.ok || !r.body) throw new Error(`torrents/info failed: ${r.status}`);
        const status = r.body.status;
        if (status === 'downloaded') return r.body;
        if (status === 'error' || status === 'virus' || status === 'dead') {
            throw new Error(`RD torrent status: ${status}`);
        }
        // Other statuses: "magnet_conversion", "waiting_files_selection",
        // "queued", "downloading", "compressing", "uploading". Keep polling.
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('timeout waiting for RD torrent to be ready');
}

async function resolveWithRD({ infoHash, title, token }) {
    if (!token) throw new Error('no RD token');
    if (!infoHash || !/^[a-f0-9]{40}$/i.test(infoHash)) throw new Error('invalid infoHash');
    const normalized = infoHash.toLowerCase();

    const cacheKey = `${token.slice(0, 8)}:${normalized}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // 1. addMagnet
    const addRes = await rdFetch(token, 'POST', '/torrents/addMagnet', { magnet: magnetFor(normalized, title) });
    if (!addRes.ok || !addRes.body?.id) {
        throw new Error(`addMagnet failed: ${addRes.status} ${addRes.raw?.slice(0, 200)}`);
    }
    const torrentId = addRes.body.id;

    // 2. Fetch info so we know the files list
    let info = null;
    for (let i = 0; i < 6; i++) {
        const r = await rdFetch(token, 'GET', `/torrents/info/${torrentId}`);
        if (r.ok && r.body && Array.isArray(r.body.files) && r.body.files.length > 0) {
            info = r.body;
            break;
        }
        await new Promise(r => setTimeout(r, 800));
    }
    if (!info) throw new Error('RD never returned a file list for this magnet');

    // 3. selectFiles — pick the main video. "all" also works but gives us
    // multiple links to choose from; picking one is simpler.
    const mainIdx = pickMainFileIdx(info.files);
    const mainFile = info.files[mainIdx];
    const selectId = String(mainFile.id);
    const selRes = await rdFetch(token, 'POST', `/torrents/selectFiles/${torrentId}`, { files: selectId });
    if (!selRes.ok && selRes.status !== 204) {
        throw new Error(`selectFiles failed: ${selRes.status}`);
    }

    // 4. Wait until the torrent is ready (cached torrents complete instantly).
    const ready = await pollTorrentReady(token, torrentId);
    if (!Array.isArray(ready.links) || ready.links.length === 0) {
        throw new Error('RD torrent downloaded but has no links');
    }

    // The links[] array corresponds to the selected files in original file
    // order. We selected one file, so links[0] is our file.
    const rdLink = ready.links[0];
    const unRes = await rdFetch(token, 'POST', '/unrestrict/link', { link: rdLink });
    if (!unRes.ok || !unRes.body?.download) {
        throw new Error(`unrestrict failed: ${unRes.status}`);
    }

    const result = {
        url: unRes.body.download,
        filename: unRes.body.filename || mainFile.path,
        filesize: unRes.body.filesize || mainFile.bytes || 0,
        mimeType: unRes.body.mimeType || '',
    };
    cache.set(cacheKey, result);
    return result;
}

/**
 * HTTP handler for POST /rd/resolve.
 * Body JSON: { infoHash, title, token }
 * Response: { url, filename, filesize, mimeType } or { error }
 */
async function handleResolve(req, res) {
    if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'POST required' }));
        return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10 * 1024) req.destroy(); });
    req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch { payload = null; }
        if (!payload || typeof payload !== 'object') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'invalid body' }));
            return;
        }
        try {
            const result = await resolveWithRD({
                infoHash: payload.infoHash,
                title: payload.title,
                token: payload.token,
            });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[rd] resolve failed:', err.message);
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'RD resolution failed' }));
        }
    });
}

module.exports = { handleResolve, resolveWithRD };
