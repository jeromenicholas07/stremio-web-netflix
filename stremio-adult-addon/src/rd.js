// Real-Debrid resolver.
//
// Two-phase API so the web client can show a file picker when a torrent
// contains multiple playable videos:
//
//   1. POST /rd/files   { infoHash, title, token }
//        → { files: [{ id, path, bytes, isVideo }] }
//      Adds the magnet, waits briefly for RD to enumerate files, returns
//      the full list so the UI can render a picker. Cached per infoHash.
//
//   2. POST /rd/resolve { infoHash, title, token, fileId? }
//        → { url, filename, filesize, mimeType }
//      Selects the chosen file (or the largest video if fileId omitted),
//      polls until ready, and unrestricts the link. Cached per
//      (infoHash, fileId).
//
// The old single-call /rd/resolve behaviour is preserved: if the client
// doesn't call /rd/files first, resolve still picks the biggest video
// automatically — so older callers and the main Search torrent row
// continue to work unchanged.

const fetch = require('node-fetch');
const { LRUCache } = require('lru-cache');
const { resolveInfoHashFromDownloadUrl, getIndexerColdInfo } = require('./prowlarr');

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

// Cache the final unrestricted link per (token-prefix, infoHash, fileId).
const resolveCache = new LRUCache({ max: 500, ttl: 45 * 60 * 1000 });

// Cache the magnet→files listing per (token-prefix, infoHash) — this also
// gives us the torrentId so subsequent /rd/resolve calls don't have to
// re-add the magnet.
const listingCache = new LRUCache({ max: 500, ttl: 30 * 60 * 1000 });

const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce',
];

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|m2ts|vob|ogv|3gp|divx|xvid)$/i;
const NON_VIDEO_EXT_RE = /\.(txt|nfo|jpg|jpeg|png|gif|srt|ass|idx|sub|url|html|htm|md5|sfv|par2|rar|zip|7z)$/i;

function magnetFor(infoHash, title) {
    const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
    const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

function isVideoFile(path, bytes) {
    const p = String(path || '').toLowerCase();
    if (NON_VIDEO_EXT_RE.test(p)) return false;
    if (VIDEO_EXT_RE.test(p)) return true;
    // Some releases ship videos without an extension. Treat files > 50 MB
    // without a known non-video extension as probable videos — RD's
    // transcoder will reject them later if we're wrong, but in practice
    // this catches many niche releases.
    return Number(bytes) > 50 * 1024 * 1024;
}

function pickLargestVideoIdx(files) {
    if (!Array.isArray(files) || files.length === 0) return null;
    let bestIdx = -1;
    let bestSize = -1;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f) continue;
        if (!isVideoFile(f.path, f.bytes)) continue;
        const size = Number(f.bytes) || 0;
        if (size > bestSize) {
            bestSize = size;
            bestIdx = i;
        }
    }
    // Fall back to the largest file overall if no video passed the filter.
    if (bestIdx < 0) {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (!f) continue;
            const size = Number(f.bytes) || 0;
            if (size > bestSize) { bestSize = size; bestIdx = i; }
        }
    }
    return bestIdx >= 0 ? bestIdx : 0;
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
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('timeout waiting for RD torrent to be ready');
}

// Add the magnet (if not already added) and return the torrentId + file list.
async function getOrCreateListing({ infoHash, title, token }) {
    if (!token) throw new Error('no RD token');
    if (!infoHash || !/^[a-f0-9]{40}$/i.test(infoHash)) throw new Error('invalid infoHash');
    const normalized = infoHash.toLowerCase();

    const cacheKey = `${token.slice(0, 8)}:${normalized}`;
    const cached = listingCache.get(cacheKey);
    if (cached) return cached;

    const addRes = await rdFetch(token, 'POST', '/torrents/addMagnet', { magnet: magnetFor(normalized, title) });
    if (!addRes.ok || !addRes.body?.id) {
        throw new Error(`addMagnet failed: ${addRes.status} ${addRes.raw?.slice(0, 200)}`);
    }
    const torrentId = addRes.body.id;

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

    const entry = { torrentId, files: info.files, infoHash: normalized };
    listingCache.set(cacheKey, entry);
    return entry;
}

async function resolveWithRD({ infoHash, title, token, fileId }) {
    const listing = await getOrCreateListing({ infoHash, title, token });

    // Pick the file to resolve. If fileId is provided and matches a listed
    // file, use that; otherwise fall back to largest video.
    let targetIdx = -1;
    if (fileId !== undefined && fileId !== null && fileId !== '') {
        const wantId = String(fileId);
        targetIdx = listing.files.findIndex(f => f && String(f.id) === wantId);
    }
    if (targetIdx < 0) targetIdx = pickLargestVideoIdx(listing.files);
    const targetFile = listing.files[targetIdx];
    if (!targetFile) throw new Error('no resolvable file in torrent');

    const cacheKey = `${token.slice(0, 8)}:${listing.infoHash}:${targetFile.id}`;
    const cached = resolveCache.get(cacheKey);
    if (cached) return cached;

    const selRes = await rdFetch(
        token, 'POST', `/torrents/selectFiles/${listing.torrentId}`,
        { files: String(targetFile.id) }
    );
    if (!selRes.ok && selRes.status !== 204) {
        throw new Error(`selectFiles failed: ${selRes.status}`);
    }

    const ready = await pollTorrentReady(token, listing.torrentId);
    if (!Array.isArray(ready.links) || ready.links.length === 0) {
        throw new Error('RD torrent downloaded but has no links');
    }

    // After selecting a single file, links[0] is that file's RD link.
    const rdLink = ready.links[0];
    const unRes = await rdFetch(token, 'POST', '/unrestrict/link', { link: rdLink });
    if (!unRes.ok || !unRes.body?.download) {
        throw new Error(`unrestrict failed: ${unRes.status}`);
    }

    const result = {
        url: unRes.body.download,
        filename: unRes.body.filename || targetFile.path,
        filesize: unRes.body.filesize || targetFile.bytes || 0,
        mimeType: unRes.body.mimeType || '',
    };
    resolveCache.set(cacheKey, result);
    return result;
}

// Parse request body with a 10 KB limit to avoid runaway payloads.
function readJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 10 * 1024) req.destroy();
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}

/** POST /rd/resolve — { infoHash, title, token, fileId? } → { url, ... } */
async function handleResolve(req, res) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return; }
    const payload = await readJsonBody(req);
    if (!payload || typeof payload !== 'object') { sendJson(res, 400, { error: 'invalid body' }); return; }
    try {
        const result = await resolveWithRD({
            infoHash: payload.infoHash,
            title: payload.title,
            token: payload.token,
            fileId: payload.fileId,
        });
        sendJson(res, 200, result);
    } catch (err) {
        console.error('[rd] resolve failed:', err.message);
        sendJson(res, 502, { error: err.message || 'RD resolution failed' });
    }
}

/**
 * POST /rd/resolve-url — { downloadUrl, magnetUrl? } → { infoHash }
 *
 * Lazy resolver used when a catalog item came through without an
 * enriched infoHash (enrichment commonly fails on adult indexers that
 * return HTML instead of .torrent bytes). Torrent.js calls this on click,
 * then re-invokes /rd/files or /rd/resolve with the freshly resolved hash.
 * No RD token required — this is purely a hash-extraction step.
 */
async function handleResolveUrl(req, res) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return; }
    const payload = await readJsonBody(req);
    if (!payload || typeof payload !== 'object') { sendJson(res, 400, { error: 'invalid body' }); return; }

    // Shortcut: magnet already carries the hash.
    const magnet = typeof payload.magnetUrl === 'string' ? payload.magnetUrl : '';
    const magnetMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
    if (magnetMatch) {
        sendJson(res, 200, { infoHash: magnetMatch[1].toLowerCase() });
        return;
    }

    const downloadUrl = typeof payload.downloadUrl === 'string' ? payload.downloadUrl : '';
    if (!downloadUrl) { sendJson(res, 400, { error: 'downloadUrl required' }); return; }

    const indexer = typeof payload.indexer === 'string' ? payload.indexer : '';

    // Short-circuit BEFORE making a network call: if the indexer is already
    // cold (recent quota/auth block), surface quota_exceeded immediately so
    // the user doesn't spend another quota slot just to see the same error.
    const coldInfo = getIndexerColdInfo(indexer);
    if (coldInfo) {
        sendJson(res, 429, {
            error: 'quota_exceeded',
            indexer: indexer || 'this indexer',
            cold: true,
            minutesRemaining: coldInfo.minutesRemaining,
            message: indexer
                ? `${indexer} daily limit reached — try another indexer (retries in ~${coldInfo.minutesRemaining}min)`
                : `Daily download limit reached on this indexer — try another (retries in ~${coldInfo.minutesRemaining}min)`,
        });
        return;
    }

    try {
        const resolved = await resolveInfoHashFromDownloadUrl(downloadUrl, { indexer });
        if (resolved.infoHash) {
            sendJson(res, 200, { infoHash: resolved.infoHash });
            return;
        }
        // Quota is special — surface it with a distinct status + code so the
        // frontend can show a tailored message ("PornoLab daily limit reached")
        // instead of a generic "could not resolve" error.
        if (resolved.reason === 'quota_exceeded') {
            const minsRemaining = resolved.coldMinutesRemaining || 60;
            sendJson(res, 429, {
                error: 'quota_exceeded',
                indexer: indexer || 'this indexer',
                cold: true,
                minutesRemaining: minsRemaining,
                message: indexer
                    ? `${indexer} daily limit reached — try another indexer (retries in ~${minsRemaining}min)`
                    : `Daily download limit reached on this indexer — try another (retries in ~${minsRemaining}min)`,
            });
            return;
        }
        sendJson(res, 404, {
            error: 'not_resolvable',
            reason: resolved.reason,
            message: 'Could not resolve this release — try another result',
        });
    } catch (err) {
        console.error('[rd] resolve-url failed:', err.message);
        sendJson(res, 502, { error: err.message || 'resolve-url failed' });
    }
}

/** POST /rd/files — { infoHash, title, token } → { files: [{id, path, bytes, isVideo}] } */
async function handleFiles(req, res) {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return; }
    const payload = await readJsonBody(req);
    if (!payload || typeof payload !== 'object') { sendJson(res, 400, { error: 'invalid body' }); return; }
    try {
        const listing = await getOrCreateListing({
            infoHash: payload.infoHash,
            title: payload.title,
            token: payload.token,
        });
        const files = listing.files.map(f => ({
            id: String(f.id),
            path: f.path || '',
            bytes: Number(f.bytes) || 0,
            isVideo: isVideoFile(f.path, f.bytes),
        }));
        sendJson(res, 200, { files });
    } catch (err) {
        console.error('[rd] files failed:', err.message);
        sendJson(res, 502, { error: err.message || 'RD file listing failed' });
    }
}

module.exports = { handleResolve, handleFiles, handleResolveUrl, resolveWithRD };
