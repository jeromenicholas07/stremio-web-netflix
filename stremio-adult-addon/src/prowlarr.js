const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { parseString } = require('xml2js');
const { LRUCache } = require('lru-cache');
const parseTorrent = require('parse-torrent');
const { getConfig, invalidateApiKeyCache, getCacheDir } = require('./config');

// Cache resolved infoHashes keyed by downloadUrl — the HTTP 302 redirect
// from Prowlarr's /download endpoint is deterministic per release.
// No TTL: once a downloadUrl maps to an infoHash, the mapping never changes
// (the infoHash IS the content identity). Capped at 20k entries (~4MB on
// disk) so a year of casual browsing doesn't explode the cache file.
const infoHashCache = new LRUCache({ max: 20000 });

// Persistent mirror of infoHashCache. A single JSON file under the addon's
// cache dir — survives launcher restarts so we never re-spend a quota slot
// on the same PornoLab release twice. Writes are throttled.
const INFOHASH_CACHE_FILE = (() => {
    const dir = getCacheDir();
    return dir ? path.join(dir, 'infohashes.json') : null;
})();

function loadInfoHashCacheFromDisk() {
    if (!INFOHASH_CACHE_FILE) return;
    try {
        if (!fs.existsSync(INFOHASH_CACHE_FILE)) return;
        const raw = fs.readFileSync(INFOHASH_CACHE_FILE, 'utf8');
        const obj = JSON.parse(raw);
        let loaded = 0, skipped = 0;
        for (const [k, v] of Object.entries(obj)) {
            // Only load POSITIVE entries (real 40-hex infoHashes). Previous
            // versions of this addon negative-cached `null` for failures —
            // but those failures were often quota/transient, not permanent,
            // and keeping them across restarts meant users never recovered.
            // The indexer-state cache handles "don't hit X right now"
            // correctly; per-URL nulls here are obsolete.
            if (typeof v === 'string' && /^[a-f0-9]{40}$/.test(v)) {
                infoHashCache.set(k, v);
                loaded++;
            } else {
                skipped++;
            }
        }
        console.log(`[prowlarr] loaded ${loaded} infohash entries from disk (skipped ${skipped} stale negatives)`);
    } catch (err) {
        console.warn('[prowlarr] infohash cache load failed:', err.message);
    }
}

let _saveTimer = null;
function scheduleInfoHashCacheSave() {
    if (!INFOHASH_CACHE_FILE) return;
    if (_saveTimer) return;
    // Coalesce bursts of writes (e.g. 50 enrichments from one search) into a
    // single disk write 3s later.
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            const obj = {};
            // Persist only positive entries — negatives are either transient
            // (retry next time) or handled by indexer-level cold state.
            for (const [k, v] of infoHashCache.entries()) {
                if (typeof v === 'string' && /^[a-f0-9]{40}$/.test(v)) obj[k] = v;
            }
            const tmp = INFOHASH_CACHE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(obj));
            fs.renameSync(tmp, INFOHASH_CACHE_FILE);
        } catch (err) {
            console.warn('[prowlarr] infohash cache save failed:', err.message);
        }
    }, 3000);
    // Don't hold the event loop open for this.
    if (_saveTimer.unref) _saveTimer.unref();
}

loadInfoHashCacheFromDisk();

// Adaptive per-indexer cold-state. When an indexer returns repeated EXPLICIT
// quota/auth signals in a short window, we flag it cold and stop eagerly
// enriching its items for the next `COLD_MS` minutes. Lazy-resolve at click
// time short-circuits to the cached cold-state so users don't burn more
// quota on items we already know will fail.
//
// IMPORTANT: a single torrent failing to enrich (Prowlarr 500 "Invalid
// torrent file contents", random parse errors, network blips) is NOT enough
// to mark an indexer cold. Those failures are common on every indexer and
// don't mean the indexer is rate-limited. Only EXPLICIT signals — HTTP 429,
// HTTP 403, or response bodies containing literal "X torrents per day" /
// "daily download limit" wording — count toward cold-state. This was the
// source of bug reports where every indexer wrongly showed "daily limit
// reached" after a single bad release.
//
// Schema is versioned via the file name. Bumping `indexer-state-v2.json`
// to `-v3` etc. discards stale cold flags carried over from prior buggy
// versions of this code.
const COLD_FAILURE_THRESHOLD = 3;        // 3 explicit signals → cold
const COLD_FAILURE_WINDOW_MS = 10 * 60 * 1000; // within 10 minutes
const COLD_MS = 60 * 60 * 1000;          // cold for 1 hour
const indexerState = new Map();          // name → { failures: [ts], coldUntil, reason }

const INDEXER_STATE_FILE = (() => {
    const dir = getCacheDir();
    // v3: previous versions over-eagerly marked indexers cold on generic 5xx
    // "Invalid torrent file contents" responses, which are common harmless
    // failures. Renaming the file forces a clean slate so users upgrading
    // past this commit don't carry over wrong cold flags.
    return dir ? path.join(dir, 'indexer-state-v3.json') : null;
})();

function loadIndexerStateFromDisk() {
    if (!INDEXER_STATE_FILE) return;
    try {
        if (!fs.existsSync(INDEXER_STATE_FILE)) return;
        const raw = fs.readFileSync(INDEXER_STATE_FILE, 'utf8');
        const obj = JSON.parse(raw);
        const now = Date.now();
        for (const [name, s] of Object.entries(obj)) {
            if (!s || typeof s !== 'object') continue;
            // Drop expired cold states — they only matter while within window.
            if (s.coldUntil && s.coldUntil > now) {
                indexerState.set(name, {
                    failures: Array.isArray(s.failures) ? s.failures.filter(ts => now - ts < COLD_FAILURE_WINDOW_MS) : [],
                    coldUntil: s.coldUntil,
                    reason: s.reason || 'unknown',
                });
            }
        }
        const coldList = [...indexerState.entries()]
            .filter(([, v]) => v.coldUntil > now)
            .map(([k, v]) => `${k}(${Math.round((v.coldUntil - now) / 60000)}min,${v.reason})`);
        if (coldList.length) {
            console.log(`[prowlarr] restored cold indexer state from disk: ${coldList.join(', ')}`);
        }
    } catch (err) {
        console.warn('[prowlarr] indexer state load failed:', err.message);
    }
}

let _indexerStateSaveTimer = null;
function scheduleIndexerStateSave() {
    if (!INDEXER_STATE_FILE) return;
    if (_indexerStateSaveTimer) return;
    _indexerStateSaveTimer = setTimeout(() => {
        _indexerStateSaveTimer = null;
        try {
            const obj = {};
            const now = Date.now();
            for (const [name, s] of indexerState.entries()) {
                if (s.coldUntil && s.coldUntil > now) {
                    obj[name] = {
                        failures: s.failures,
                        coldUntil: s.coldUntil,
                        reason: s.reason,
                    };
                }
            }
            const tmp = INDEXER_STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(obj));
            fs.renameSync(tmp, INDEXER_STATE_FILE);
        } catch (err) {
            console.warn('[prowlarr] indexer state save failed:', err.message);
        }
    }, 1000);
    if (_indexerStateSaveTimer.unref) _indexerStateSaveTimer.unref();
}

loadIndexerStateFromDisk();

function getIndexerColdInfo(name) {
    if (!name) return null;
    const s = indexerState.get(name);
    if (!s) return null;
    const now = Date.now();
    if (s.coldUntil && s.coldUntil > now) {
        return { coldUntil: s.coldUntil, reason: s.reason || 'unknown', minutesRemaining: Math.ceil((s.coldUntil - now) / 60000) };
    }
    return null;
}

function isIndexerCold(name) {
    return getIndexerColdInfo(name) !== null;
}

function markIndexerColdNow(name, reason) {
    if (!name) return;
    let s = indexerState.get(name);
    if (!s) { s = { failures: [], coldUntil: 0, reason: 'unknown' }; indexerState.set(name, s); }
    const now = Date.now();
    // Set a full COLD_MS window. Any existing coldUntil gets extended, not shrunk.
    const newColdUntil = now + COLD_MS;
    if (newColdUntil > s.coldUntil) {
        s.coldUntil = newColdUntil;
        s.reason = reason;
        console.warn(`[prowlarr] indexer ${name} IMMEDIATELY cold (reason=${reason}); skipping ${COLD_MS / 60000}min`);
        scheduleIndexerStateSave();
    }
}

function recordIndexerFailure(name, reason) {
    if (!name) return;
    let s = indexerState.get(name);
    if (!s) { s = { failures: [], coldUntil: 0, reason: 'unknown' }; indexerState.set(name, s); }
    const now = Date.now();
    s.failures = s.failures.filter(ts => now - ts < COLD_FAILURE_WINDOW_MS);
    s.failures.push(now);
    if (s.failures.length >= COLD_FAILURE_THRESHOLD && !(s.coldUntil > now)) {
        s.coldUntil = now + COLD_MS;
        s.reason = reason;
        console.warn(`[prowlarr] indexer ${name} went cold (${s.failures.length} failures, reason=${reason}); skipping ${COLD_MS / 60000}min`);
        scheduleIndexerStateSave();
    }
}

function recordIndexerSuccess(name) {
    if (!name) return;
    const s = indexerState.get(name);
    if (!s) return;
    const wasCold = s.coldUntil && s.coldUntil > Date.now();
    s.failures = [];
    s.coldUntil = 0;
    s.reason = 'unknown';
    if (wasCold) {
        console.log(`[prowlarr] indexer ${name} warmed up (success after cold)`);
        scheduleIndexerStateSave();
    }
}

// Expose a snapshot of currently-cold indexers for the catalog layer, which
// uses it to flag items in the meta so the frontend can short-circuit clicks.
function getColdIndexers() {
    const now = Date.now();
    const out = {};
    for (const [name, s] of indexerState.entries()) {
        if (s.coldUntil && s.coldUntil > now) {
            out[name] = { reason: s.reason || 'unknown', minutesRemaining: Math.ceil((s.coldUntil - now) / 60000) };
        }
    }
    return out;
}

// Wipe all cold-state. Wired to /cache/clear so users can recover from a
// stale wrong-cold flag without restarting the launcher. Also clears the
// on-disk persistence so the bad state doesn't come back next boot.
function clearAllColdState() {
    const cleared = indexerState.size;
    indexerState.clear();
    if (INDEXER_STATE_FILE) {
        try { fs.unlinkSync(INDEXER_STATE_FILE); } catch { /* not present is fine */ }
    }
    if (cleared > 0) {
        console.log(`[prowlarr] cleared ${cleared} indexer cold-state entries`);
    }
    return cleared;
}

/**
 * Resolve a Prowlarr downloadUrl to an infoHash.
 *
 * Prowlarr's /download endpoint can either:
 *   (a) 302-redirect to a magnet URI (handled via Location header), or
 *   (b) return the raw .torrent bytes (bencode-parsed for info-dict SHA-1).
 *
 * Case (b) is common for HTTP-tracker indexers (MyPornClub, OneJAV): Prowlarr
 * fetches the .torrent from upstream and streams it back. On private
 * quota-limited trackers (PornoLab), the upstream returns an HTML quota page
 * once the daily cap is hit — Prowlarr wraps that as HTTP 500 "Invalid torrent
 * file contents." We detect that specifically and report `quota_exceeded` so
 * the frontend can show a meaningful message.
 *
 * Returns `{ infoHash, reason }`:
 *   - reason 'cache'           — served from cache (may or may not have hash)
 *   - reason 'cold'            — indexer is cold; skipped without network I/O
 *   - reason 'magnet_redirect' — 301/302 to magnet, hash extracted from Location
 *   - reason 'bencode'         — raw .torrent bytes parsed successfully
 *   - reason 'quota_exceeded'  — upstream tracker rate-limited us (PornoLab 5/day)
 *   - reason 'bad_bytes'       — response wasn't a .torrent and wasn't a magnet redirect
 *   - reason 'http_error'      — non-2xx/3xx response
 *   - reason 'network'         — fetch threw (DNS/TCP/timeout)
 */

// STRICT quota body patterns — only match unambiguous, indexer-specific
// quota wording. Generic phrases like "Invalid torrent file" or "rate
// limit" used to be in this list but produced false positives on harmless
// transient failures (Prowlarr wraps every .torrent fetch error as 500
// "Invalid torrent file contents", which made every dead release look
// like a quota block). These patterns must be narrow enough that matching
// them is overwhelming evidence the upstream tracker is rate-limiting us.
const STRONG_QUOTA_BODY_PATTERNS = [
    // PornoLab exact wording: "Your current limit is 5 per day"
    /current\s+limit\s+is\s+\d+\s+per\s+day/i,
    // "you've reached your daily torrent download limit"
    /(?:reached|exceeded)\s+(?:your\s+)?daily\s+(?:torrent\s+)?download\s+limit/i,
    // "X torrents per day"
    /\d+\s+torrents?\s+per\s+day/i,
    // "daily quota of N"
    /daily\s+quota\s+of\s+\d+/i,
    // very explicit "quota exceeded" — tracker UI strings often phrase it this way
    /(?:download\s+)?quota\s+(?:has\s+been\s+)?exceeded/i,
];

function bodyLooksLikeStrictQuota(body) {
    if (!body) return false;
    return STRONG_QUOTA_BODY_PATTERNS.some(re => re.test(body));
}

// STRICT auth-redirect patterns. A 3xx Location header pointing at one of
// these is overwhelming evidence the tracker is gating us behind a login
// or quota wall. Bare /login/ in a path is too generic — matches things
// like "/login-help" docs — so we anchor the patterns to known URL shapes.
const STRONG_AUTH_REDIRECT_PATTERNS = [
    /\?(?:redirect|return)=.*login/i,
    /\/(?:login|signin|sign-in)(?:[/?#]|$)/i,
    /\/account\/login(?:[/?#]|$)/i,
    /\/(?:captcha|recaptcha)(?:[/?#]|$)/i,
    /quota[_-]?exceeded/i,
    /daily[_-]?limit/i,
];

function locationLooksLikeAuthWall(loc) {
    if (!loc) return false;
    return STRONG_AUTH_REDIRECT_PATTERNS.some(re => re.test(loc));
}

async function resolveInfoHashFromDownloadUrl(downloadUrl, { indexer = '' } = {}) {
    if (!downloadUrl) return { infoHash: null, reason: 'network' };

    // Short-circuit 1: infoHash cache (positive or negative).
    const cached = infoHashCache.get(downloadUrl);
    if (cached !== undefined) return { infoHash: cached, reason: 'cache' };

    // Short-circuit 2: indexer is currently cold. Don't spend a network round
    // trip (and possibly another quota slot) on something we already know will
    // fail. Report quota_exceeded to callers so the UI can show the same
    // error it would have shown after a real failed resolve.
    const coldInfo = getIndexerColdInfo(indexer);
    if (coldInfo) {
        return { infoHash: null, reason: 'quota_exceeded', coldMinutesRemaining: coldInfo.minutesRemaining, coldReason: coldInfo.reason };
    }

    try {
        // Manual redirect: node-fetch errors ("Only absolute URLs are supported")
        // when trying to follow a magnet: URI. Intercept the 3xx ourselves.
        const res = await fetch(downloadUrl, { redirect: 'manual', timeout: 7000 });

        // ----- HARD signals: definitive proof the indexer is rate-limiting us
        // 429 with explicit Retry-After or "rate limit" semantics — RFC-defined.
        if (res.status === 429) {
            markIndexerColdNow(indexer, 'http_429');
            return { infoHash: null, reason: 'quota_exceeded' };
        }

        // ----- Redirects (3xx)
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location') || '';
            const magnetMatch = loc.match(/btih:([a-fA-F0-9]{40})/i);
            if (magnetMatch) {
                const hash = magnetMatch[1].toLowerCase();
                infoHashCache.set(downloadUrl, hash);
                scheduleInfoHashCacheSave();
                recordIndexerSuccess(indexer);
                return { infoHash: hash, reason: 'magnet_redirect' };
            }
            // Strict auth-wall redirect → mark cold. Generic 3xx (e.g. CDN
            // redirect that just doesn't carry a magnet) is treated as a
            // soft failure — we shouldn't punish a whole indexer for one
            // weird release.
            if (locationLooksLikeAuthWall(loc)) {
                markIndexerColdNow(indexer, 'auth_redirect');
                return { infoHash: null, reason: 'quota_exceeded' };
            }
            // Soft failure — don't count toward cold-state. Just report
            // bad_bytes so the frontend shows "could not resolve, try
            // another result".
            return { infoHash: null, reason: 'bad_bytes' };
        }

        if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            // Bencoded dicts start with ASCII 'd' (0x64). Parse to extract SHA-1.
            if (buf.length > 0 && buf[0] === 0x64) {
                try {
                    const parsed = parseTorrent(buf);
                    if (parsed && typeof parsed.infoHash === 'string' && /^[a-f0-9]{40}$/i.test(parsed.infoHash)) {
                        const hash = parsed.infoHash.toLowerCase();
                        infoHashCache.set(downloadUrl, hash);
                        scheduleInfoHashCacheSave();
                        recordIndexerSuccess(indexer);
                        return { infoHash: hash, reason: 'bencode' };
                    }
                } catch { /* fall through to bad_bytes */ }
            }
            // 2xx non-bencode → upstream served HTML. Only treat as quota
            // when the body contains explicit "X per day" / "daily download
            // limit" wording. A bare HTML page with no such markers might
            // be a CDN error page, a 200-disguised "release deleted" notice,
            // or a captcha challenge that doesn't say "limit" — none of
            // those should poison the indexer for an hour.
            const text = buf.toString('utf8', 0, Math.min(buf.length, 4096));
            if (bodyLooksLikeStrictQuota(text)) {
                markIndexerColdNow(indexer, 'quota_body_2xx');
                return { infoHash: null, reason: 'quota_exceeded' };
            }
            // Soft failure — try again next time, don't penalise the indexer.
            return { infoHash: null, reason: 'bad_bytes' };
        }

        // 5xx — Prowlarr wraps every upstream .torrent fetch failure as
        // "Invalid torrent file contents" (HTTP 500). That generic wrapper
        // does NOT mean quota; it means Prowlarr couldn't parse the bytes
        // it got back, which happens for many reasons (release deleted,
        // tracker hiccup, transient network blip). We ONLY mark cold when
        // the wrapped body contains explicit per-day quota wording.
        if (res.status >= 500 && res.status < 600) {
            let body = '';
            try { body = await res.text(); } catch { /* ignore */ }
            if (bodyLooksLikeStrictQuota(body)) {
                markIndexerColdNow(indexer, `http_${res.status}_quota`);
                return { infoHash: null, reason: 'quota_exceeded' };
            }
            // Soft failure — random 5xx is a routine occurrence; don't
            // penalise the indexer just for serving a stale release.
            return { infoHash: null, reason: 'bad_bytes' };
        }

        // 403 Forbidden — could be auth/ratio block, but on public adult
        // indexers it's also commonly returned for region-blocked or stale
        // releases. Count it as a hard failure that contributes to the
        // 3-in-10-min cold threshold but DOESN'T immediately mark cold on
        // a single occurrence.
        if (res.status === 403) {
            recordIndexerFailure(indexer, 'http_403');
            return { infoHash: null, reason: 'bad_bytes' };
        }

        // Other 4xx (404, 410 etc) — release is gone, indexer is fine.
        // Soft failure.
        return { infoHash: null, reason: 'bad_bytes' };
    } catch (err) {
        // Network error — DON'T penalise the indexer; the user's connection
        // might be flaky, or the indexer might just be slow today. The
        // aggregate timeout in searchProwlarr already protects us.
        return { infoHash: null, reason: 'network' };
    }
}

/**
 * Enrich items missing infoHash/magnetUrl by following their downloadUrl
 * redirect. Runs in parallel with a small concurrency cap.
 *
 * Skips items whose indexer is currently "cold" (see indexerState above).
 * A cold indexer has returned enough quota/auth failures recently that
 * eager enrichment would be wasteful and actively counterproductive — each
 * call counts against the user's daily quota on private trackers like
 * PornoLab. Cold items still enter the catalog carrying `downloadUrl`; we
 * lazy-resolve them at click time via /rd/resolve-url, so the user only
 * spends a quota slot on items they actually intend to play.
 */
async function enrichMissingInfoHashes(items) {
    // IMPORTANT: do NOT filter by seeders here. Real-Debrid's cache often has
    // a copy even when public trackers show 0 seeders, so pre-filtering
    // destroys genuinely playable content.
    const needsResolution = items.filter(it => {
        if (it.infoHash) return false;
        if (it.magnetUrl && /btih:/i.test(it.magnetUrl)) return false;
        if (!it.downloadUrl) return false;
        // Skip indexers currently flagged as ratio/quota-limited.
        if (isIndexerCold(it.indexer)) return false;
        return true;
    });

    if (items.some(it => isIndexerCold(it.indexer))) {
        const coldNames = [...new Set(items.filter(it => isIndexerCold(it.indexer)).map(it => it.indexer))];
        console.log(`[prowlarr] skipping eager enrichment for cold indexers: ${coldNames.join(', ')} (will lazy-resolve at click time)`);
    }

    // 10 concurrent resolves. Going higher risks 429s from ratio-limited indexers;
    // the cold-state tracker will back off anyway if failures pile up.
    const CONCURRENCY = 10;
    let idx = 0;
    async function worker() {
        while (idx < needsResolution.length) {
            const it = needsResolution[idx++];
            const { infoHash } = await resolveInfoHashFromDownloadUrl(it.downloadUrl, { indexer: it.indexer });
            if (infoHash) it.infoHash = infoHash;
            // If an indexer went cold mid-batch, bail out early — no point
            // burning more attempts at it.
            if (isIndexerCold(it.indexer)) break;
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function parseXml(xml) {
    return new Promise((resolve, reject) => {
        parseString(xml, { explicitArray: false, ignoreAttrs: false }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

function extractTorznabAttrs(item) {
    const attrs = {};
    const torznabAttrs = item['torznab:attr'];
    if (!torznabAttrs) return attrs;
    const list = Array.isArray(torznabAttrs) ? torznabAttrs : [torznabAttrs];
    for (const attr of list) {
        const name = attr?.$ ?.name;
        const value = attr?.$ ?.value;
        if (name && value !== undefined) {
            attrs[name] = value;
        }
    }
    return attrs;
}

function parseItem(item) {
    const attrs = extractTorznabAttrs(item);
    return {
        title: item.title || '',
        link: item.link || '',
        guid: typeof item.guid === 'object' ? item.guid._ || item.guid : item.guid || '',
        pubDate: item.pubDate || '',
        size: parseInt(item.size || attrs.size || '0', 10),
        seeders: parseInt(attrs.seeders || '0', 10),
        peers: parseInt(attrs.peers || '0', 10),
        infoHash: attrs.infohash || '',
        magnetUrl: attrs.magneturl || '',
        downloadUrl: item.link || '',
        category: attrs.category || '',
        poster: attrs.poster || attrs.coverurl || '',
    };
}

/**
 * Search Prowlarr via its API for adult content.
 * @param {object} options
 * @param {string} [options.query] - Search query (empty for latest/browse)
 * @param {number} [options.offset] - Result offset for pagination
 * @param {number} [options.limit] - Max results to return
 * @param {string} [options.sortBy] - 'seeders' or 'date' (default: date)
 * @returns {Promise<Array>} Array of parsed torrent items
 */
async function searchProwlarr({ query = '', offset = 0, limit, sortBy = 'date', categories: categoriesOpt } = {}) {
    let config = getConfig();
    if (!config.prowlarrApiKey) {
        // Force-reload once in case Prowlarr only just wrote config.xml
        invalidateApiKeyCache();
        config = getConfig();
        if (!config.prowlarrApiKey) {
            throw new Error('Prowlarr API key not configured');
        }
    }

    limit = limit || config.pageSize;
    const categoryList = Array.isArray(categoriesOpt) && categoriesOpt.length > 0
        ? categoriesOpt
        : config.adultCategories;

    // Prowlarr accepts X-Api-Key header OR apikey query param. Sending both
    // is belt-and-braces: works even when AuthenticationRequired=Enabled and
    // the header gets dropped by an intermediary.
    //
    // IMPORTANT: Prowlarr 1.28+ rejects `categories=6000,6010,...` as a
    // single comma-separated string (HTTP 400 "not a valid value"). It
    // expects `categories` to be a repeated query parameter — one entry
    // per category. Hence the explicit append loop below instead of a
    // single `categories: list.join(',')` entry in the initial map.
    async function doFetch(apiKey) {
        const params = new URLSearchParams({
            query: query,
            offset: String(offset),
            limit: String(limit),
            type: 'search',
            apikey: apiKey,
        });
        for (const cat of categoryList) params.append('categories', String(cat));
        const url = `${config.prowlarrUrl}/api/v1/search?${params}`;
        // 12s aggregate timeout — generous enough to let the faster indexers
        // (MyPornClub ~1s, PornoLab ~2.5s, OneJAV ~3s) finish even under
        // load, while still capping worst-case on a completely dead indexer
        // (TorrentGalaxyClone DNS timeouts can run 30s+). On timeout we fall
        // through to per-indexer Torznab, which uses Promise.allSettled so a
        // single dead indexer never breaks the row.
        return fetch(url, {
            headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
            timeout: 12000,
        });
    }

    let response;
    try {
        response = await doFetch(config.prowlarrApiKey);
    } catch (err) {
        console.warn('[prowlarr] aggregate /search failed, falling through to Torznab:', err.message);
        return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
    }

    // On 401, the on-disk key may have rotated (first-run Prowlarr writes a
    // fresh key on boot, possibly after we cached an earlier stub). Bust the
    // cache, re-read, retry once.
    if (response.status === 401) {
        console.warn('[prowlarr] 401 — re-reading API key from config.xml and retrying');
        invalidateApiKeyCache();
        config = getConfig();
        if (config.prowlarrApiKey) {
            try {
                response = await doFetch(config.prowlarrApiKey);
            } catch (err) {
                console.warn('[prowlarr] retry failed, falling through to Torznab:', err.message);
                return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
            }
        }
    }

    if (!response.ok) {
        // Fallback: try Torznab API directly via indexers
        return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
    }

    const data = await response.json();

    // Prowlarr JSON API returns array of release objects
    const items = data.map(release => {
        let infoHash = (release.infoHash || '').toLowerCase();
        const magnetUrl = release.magnetUrl || '';
        // Extract from magnet if infoHash is missing but magnet is present
        if (!infoHash && magnetUrl) {
            const m = magnetUrl.match(/btih:([a-fA-F0-9]{40})/);
            if (m) infoHash = m[1].toLowerCase();
        }
        return {
            title: release.title || '',
            link: release.downloadUrl || release.magnetUrl || '',
            guid: release.guid || release.title || '',
            pubDate: release.publishDate || '',
            size: release.size || 0,
            seeders: release.seeders || 0,
            peers: release.leechers || 0,
            infoHash,
            magnetUrl,
            downloadUrl: release.downloadUrl || '',
            category: String(release.categories?.[0]?.id || '6000'),
            poster: release.posterUrl || '',
            indexer: release.indexer || '',
        };
    });

    // Sort FIRST so we only enrich the top-N we'd actually return. The
    // aggregate /search often comes back with 100+ items; we can sort on raw
    // seeders/pubDate before enrichment because those fields ship in the
    // original Prowlarr response.
    if (sortBy === 'seeders') {
        items.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    } else {
        items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }

    // Enrich up to `limit` items. We want the full requested page to be
    // playable, not a subset — the IncognitoCard grid can scroll far beyond
    // the first 20, and we don't want the tail to silently drop.
    const head = items.slice(0, limit);
    await enrichMissingInfoHashes(head);

    // If aggregate came back empty (common when every indexer timed out
    // inside Prowlarr's own 30s budget but the HTTP call itself succeeded),
    // try the per-indexer Torznab path — it uses Promise.allSettled so it's
    // immune to single-indexer failures and often returns something.
    if (items.length === 0) {
        try {
            return await searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
        } catch (err) {
            console.warn('[prowlarr] empty aggregate, Torznab fallback also failed:', err.message);
        }
    }

    return items;
}

/**
 * Fallback: search via Torznab XML API on individual indexers
 */
async function searchViaTorznab({ query = '', offset = 0, limit = 50, sortBy = 'date', categories: categoriesOpt } = {}) {
    const config = getConfig();
    const categoryList = Array.isArray(categoriesOpt) && categoriesOpt.length > 0
        ? categoriesOpt
        : config.adultCategories;

    // Get list of indexers from Prowlarr. Send key in header AND query-string.
    async function fetchIndexers(apiKey) {
        return fetch(`${config.prowlarrUrl}/api/v1/indexer?apikey=${encodeURIComponent(apiKey)}`, {
            headers: { 'X-Api-Key': apiKey },
        });
    }
    let indexersRes = await fetchIndexers(config.prowlarrApiKey);

    if (indexersRes.status === 401) {
        console.warn('[prowlarr/torznab] 401 on /indexer — re-reading key and retrying');
        invalidateApiKeyCache();
        const reloaded = getConfig();
        if (reloaded.prowlarrApiKey) {
            indexersRes = await fetchIndexers(reloaded.prowlarrApiKey);
        }
    }

    if (!indexersRes.ok) {
        throw new Error(`Failed to fetch Prowlarr indexers: ${indexersRes.status}`);
    }

    const indexers = await indexersRes.json();

    // Filter to indexers that support the requested categories
    const matchingIndexers = indexers.filter(idx => {
        const caps = idx.capabilities?.categories || [];
        return caps.some(cat => categoryList.includes(cat.id));
    });

    if (matchingIndexers.length === 0) {
        return [];
    }

    // Query each indexer via Torznab
    const allItems = [];
    const fetchPromises = matchingIndexers.map(async (indexer) => {
        try {
            const torznabUrl = `${config.prowlarrUrl}/${indexer.id}/api?apikey=${config.prowlarrApiKey}&t=search&cat=${categoryList.join(',')}&q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`;

            // 15s per-indexer. One slow indexer never blocks the others
            // because fetchPromises runs under Promise.allSettled below.
            const res = await fetch(torznabUrl, { timeout: 15000 });
            if (!res.ok) return [];

            const xml = await res.text();
            const parsed = await parseXml(xml);
            const channel = parsed?.rss?.channel;
            if (!channel?.item) return [];

            const items = Array.isArray(channel.item) ? channel.item : [channel.item];
            return items.map(item => ({
                ...parseItem(item),
                indexer: indexer.name || '',
            }));
        } catch {
            return [];
        }
    });

    const results = await Promise.allSettled(fetchPromises);
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            allItems.push(...result.value);
        } else if (result.status === 'rejected') {
            // Log per-indexer failure so we can see which indexer is sick
            // without killing the whole fallback path.
            console.warn('[prowlarr/torznab] indexer failed:', result.reason?.message || result.reason);
        }
    }

    // Sort FIRST so we enrich only the top-N we actually return. Torznab
    // can aggregate hundreds of items across indexers and enriching all of
    // them (each a 302 redirect fetch) would take 30s+. We sort on the raw
    // seeders/pubDate fields which are always present from Torznab.
    if (sortBy === 'seeders') {
        allItems.sort((a, b) => b.seeders - a.seeders);
    } else {
        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }

    const sliced = allItems.slice(0, limit);

    // Torznab responses usually expose only a downloadUrl that 302-redirects
    // to a magnet — the `infohash`/`magneturl` torznab:attr fields are often
    // missing. Without enrichment, every such item gets dropped downstream
    // by the hex-regex filter in itemToMeta (which in turn leaves catalogs
    // showing 0 cards even when Torznab returned hundreds of results).
    await enrichMissingInfoHashes(sliced);

    return sliced;
}

module.exports = {
    searchProwlarr,
    resolveInfoHashFromDownloadUrl,
    isIndexerCold,
    getIndexerColdInfo,
    getColdIndexers,
    clearAllColdState,
};
