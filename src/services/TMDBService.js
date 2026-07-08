// Copyright (C) 2017-2024 Smart code 203358507

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour (in-memory API responses)

// Persistent (localStorage) cache for stable lookups: imdb→tmdb resolution and logo URLs.
// These results don't change for a given title, so we keep them across page reloads.
const PERSIST_KEY = 'tmdb_persist_cache_v1';
const PERSIST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (default; per-entry override supported)
// Default TTL for raw API responses (trending/popular/recommendations/etc.).
// 6h balances freshness (trending changes daily) against not slamming TMDB
// every page load.
const API_RESPONSE_TTL = 6 * 60 * 60 * 1000;
// Lowered from 2000 — entries now include full API payloads (a row of 20
// TMDB items is ~15-20 KB) so we need to be more conservative to stay
// under the browser's ~5 MB localStorage quota.
const PERSIST_MAX_ENTRIES = 1000;
// Hard byte budget for the serialized cache. The entry-count cap alone is not
// enough: 1000 full-payload rows (~18 KB each) is ~18 MB, which blows the
// shared ~5 MB localStorage quota and starves stremio-core's own writes
// (library_recent) plus small settings (auto-pick, debug). We keep the TMDB
// cache well under budget so the rest of the app always has room.
const PERSIST_MAX_BYTES = 2 * 1024 * 1024; // 2 MB of serialized JSON

// Patterns that indicate a bad trailer (sign language, behind-the-scenes, etc.)
const BAD_TRAILER_PATTERNS = /sign\s*language|behind\s*the\s*scenes|bloopers|featurette|making\s*of|sneak\s*peek|clip\s*\d|opening\s*credits|recap|interview/i;

// TMDB genre ID → name mapping
const GENRE_MAP = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
    10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
    10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
    10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

// ── IndexedDB-backed blob store ──────────────────────────────────────────
// The persistent cache lives in IndexedDB (hundreds-of-MB quota), NOT in the
// shared ~5 MB localStorage that stremio-core needs for its `library`,
// `streaming_server_urls`, etc. Keeping a multi-MB TMDB blob in localStorage
// repeatedly blew that quota and broke core's writes. We store the whole cache
// as a single structured-clone value under one key. Falls back to a
// size-budgeted localStorage blob only when IndexedDB is unavailable.
const IDB_NAME = 'tmdb_cache';
const IDB_STORE = 'kv';
const IDB_BLOB_KEY = 'persist_v1';

function idbAvailable() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
}

function idbOpen() {
    return new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

async function idbGet(key) {
    const db = await idbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally { db.close(); }
}

async function idbSet(key, value) {
    const db = await idbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

class TMDBService {
    constructor() {
        this._cache = new Map();
        this._imdbCache = new Map(); // tmdbId → imdbId (mirrors persistent cache)
        // In-memory cache starts empty and is hydrated asynchronously from
        // IndexedDB (migrating any legacy localStorage blob). Lookups before
        // hydration completes simply miss and refetch — correct, just colder.
        this._persist = {};
        this._useIdb = idbAvailable();
        this._persistDirty = false;
        this._persistFlushTimer = null;
        this._persistReady = this._hydratePersist();

        // ─── Request flow control ────────────────────────────────
        // In-flight deduplication: coalesce concurrent callers for the same
        // cache key into a single HTTP request.
        this._inflight = new Map(); // cacheKey → Promise

        // Semaphore: cap concurrent TMDB fetches so a 100-card home-screen
        // mount doesn't fire 100 simultaneous requests and trip 429.
        // 4 slots × ~100ms RTT ≈ 40 req/s — well under TMDB's ~50/s limit.
        this._maxConcurrent = 4;
        this._activeFetches = 0;
        this._waitQueue = []; // [resolve, ...] for slot acquisition

        // Global pause until <ms timestamp>. Set by 429 responses; every
        // outgoing fetch waits past this point before hitting the network.
        this._pauseUntil = 0;
    }

    // ── Concurrency semaphore ──
    async _acquireSlot() {
        // Respect any active 429 pause first.
        const wait = this._pauseUntil - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        if (this._activeFetches < this._maxConcurrent) {
            this._activeFetches++;
            return;
        }
        await new Promise((r) => this._waitQueue.push(r));
        this._activeFetches++;
    }

    _releaseSlot() {
        this._activeFetches--;
        if (this._waitQueue.length > 0) {
            const next = this._waitQueue.shift();
            // Defer with setTimeout(0) so the next slot acquisition doesn't
            // happen inside the current microtask and re-enter immediately.
            setTimeout(next, 0);
        }
    }

    // --- Persistent cache (IndexedDB, with a localStorage fallback) ---

    _loadPersistFromLocalStorage() {
        try {
            const raw = localStorage.getItem(PERSIST_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch {
            return {};
        }
    }

    // Load the cache from IndexedDB, migrating the legacy localStorage blob once
    // and then deleting it so its space is returned to stremio-core. Anything
    // written into this._persist before hydration finishes is preserved.
    async _hydratePersist() {
        if (this._useIdb) {
            try {
                let blob = await idbGet(IDB_BLOB_KEY);
                if (!blob || typeof blob !== 'object') {
                    // First run on IDB — import the legacy localStorage cache.
                    const legacy = this._loadPersistFromLocalStorage();
                    if (legacy && Object.keys(legacy).length > 0) {
                        blob = legacy;
                        try { await idbSet(IDB_BLOB_KEY, blob); } catch { /* keep going */ }
                    }
                }
                // The legacy localStorage blob is the quota hog — drop it whether
                // or not it had data, now that IndexedDB owns the cache.
                try { localStorage.removeItem(PERSIST_KEY); } catch { /* */ }
                if (blob && typeof blob === 'object') {
                    this._persist = Object.assign(blob, this._persist);
                }
                return;
            } catch {
                this._useIdb = false; // IndexedDB unusable — fall back below.
            }
        }
        const ls = this._loadPersistFromLocalStorage();
        this._persist = Object.assign(ls, this._persist);
    }

    // Drop the oldest entries until the callback reports we're within budget.
    _evictOldestUntil(withinBudget) {
        let serialized = JSON.stringify(this._persist);
        while (!withinBudget(serialized)) {
            const keys = Object.keys(this._persist);
            if (keys.length === 0) break;
            // Drop in 10% batches so we don't re-serialize once per entry.
            const batch = Math.max(1, Math.ceil(keys.length * 0.1));
            const sorted = keys
                .map((k) => ({ k, t: this._persist[k].time || 0 }))
                .sort((a, b) => a.t - b.t);
            for (let i = 0; i < batch; i++) delete this._persist[sorted[i].k];
            serialized = JSON.stringify(this._persist);
        }
        return serialized;
    }

    _savePersist() {
        // Cap entry count via LRU regardless of backend.
        const keys = Object.keys(this._persist);
        if (keys.length > PERSIST_MAX_ENTRIES) {
            const sorted = keys
                .map((k) => ({ k, t: this._persist[k].time || 0 }))
                .sort((a, b) => a.t - b.t);
            const toRemove = sorted.slice(0, keys.length - PERSIST_MAX_ENTRIES);
            for (const { k } of toRemove) delete this._persist[k];
        }

        if (this._useIdb) {
            // IndexedDB has a large quota — persist the whole cache as one blob.
            // On any runtime failure, fall back to the size-budgeted
            // localStorage path so we never lose the cache entirely.
            idbSet(IDB_BLOB_KEY, this._persist).catch(() => {
                this._useIdb = false;
                this._savePersistToLocalStorage();
            });
            return;
        }
        this._savePersistToLocalStorage();
    }

    _savePersistToLocalStorage() {
        // Cap the serialized SIZE so the cache can't crowd out stremio-core's
        // writes and blow the shared quota — an entry-count cap can't bound bytes.
        const serialized = this._evictOldestUntil((s) => s.length <= PERSIST_MAX_BYTES);
        try {
            localStorage.setItem(PERSIST_KEY, serialized);
            return;
        } catch { /* fall through to graceful eviction */ }

        // Quota error: drop the oldest 25% and retry once before nuking.
        try {
            const remaining = Object.keys(this._persist)
                .map((k) => ({ k, t: this._persist[k].time || 0 }))
                .sort((a, b) => a.t - b.t);
            const dropCount = Math.max(1, Math.ceil(remaining.length * 0.25));
            for (let i = 0; i < dropCount; i++) delete this._persist[remaining[i].k];
            localStorage.setItem(PERSIST_KEY, JSON.stringify(this._persist));
            return;
        } catch { /* still failing — last resort below */ }

        try {
            this._persist = {};
            localStorage.removeItem(PERSIST_KEY);
        } catch { /* silent */ }
    }

    _persistGet(key) {
        const entry = this._persist[key];
        if (!entry) return undefined;
        const ttl = entry.ttl || PERSIST_TTL;
        if (Date.now() - (entry.time || 0) > ttl) {
            delete this._persist[key];
            return undefined;
        }
        return entry.value;
    }

    _persistSet(key, value, ttl) {
        const entry = { value, time: Date.now() };
        if (ttl) entry.ttl = ttl;
        this._persist[key] = entry;
        // Throttle disk writes — bursty home-screen mounts can write dozens
        // of entries in a few hundred ms, and serializing the entire cache
        // every time becomes the bottleneck.
        this._persistDirty = true;
        if (this._persistFlushTimer) return;
        this._persistFlushTimer = setTimeout(() => {
            this._persistFlushTimer = null;
            if (this._persistDirty) {
                this._persistDirty = false;
                this._savePersist();
            }
        }, 500);
    }

    // --- Settings stored in localStorage ---

    getApiKey() {
        try {
            return localStorage.getItem('tmdb_api_key') || 'b06102636e7efd95cfc1676d0d78c70a';
        } catch {
            return 'b06102636e7efd95cfc1676d0d78c70a';
        }
    }

    setApiKey(key) {
        try {
            localStorage.setItem('tmdb_api_key', key);
        } catch {
            // silent fail
        }
    }

    getTrailerSource() {
        try {
            return localStorage.getItem('netflix_ui_trailer_source') || 'tmdb';
        } catch {
            return 'tmdb';
        }
    }

    setTrailerSource(source) {
        try {
            localStorage.setItem('netflix_ui_trailer_source', source);
        } catch {
            // silent fail
        }
    }

    getTrailerLanguage() {
        try {
            return localStorage.getItem('netflix_ui_trailer_lang') || 'en';
        } catch {
            return 'en';
        }
    }

    setTrailerLanguage(lang) {
        try {
            localStorage.setItem('netflix_ui_trailer_lang', lang);
        } catch {
            // silent fail
        }
    }

    getRecommendationSource() {
        try {
            return localStorage.getItem('netflix_ui_rec_source') || 'tmdb';
        } catch {
            return 'tmdb';
        }
    }

    setRecommendationSource(source) {
        try {
            localStorage.setItem('netflix_ui_rec_source', source);
        } catch {
            // silent fail
        }
    }

    // --- Cache ---

    _getCached(key) {
        const entry = this._cache.get(key);
        if (entry && Date.now() - entry.time < CACHE_TTL) {
            return entry.data;
        }
        this._cache.delete(key);
        return null;
    }

    _setCache(key, data) {
        this._cache.set(key, { data, time: Date.now() });
    }

    async _fetch(path, params = {}) {
        const apiKey = this.getApiKey();
        if (!apiKey) return null;

        const cacheKey = `${path}?${JSON.stringify(params)}`;
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        // Persistent cache (localStorage, 6h default) — keeps row data alive
        // across reloads so trending/popular/recommendations/etc. don't all
        // re-fetch every time the page loads.
        const persistKey = `api:${cacheKey}`;
        const persisted = this._persistGet(persistKey);
        if (persisted !== undefined) {
            // Hydrate the in-memory cache so subsequent same-session calls
            // skip the localStorage round-trip too.
            this._setCache(cacheKey, persisted);
            return persisted;
        }

        // Dedup: if an identical request is already in-flight, ride that one
        // instead of issuing a second. Crucial for home-screen mounts where
        // multiple components can independently request the same item.
        if (this._inflight.has(cacheKey)) return this._inflight.get(cacheKey);

        const promise = this._doFetchWithBackoff(path, params, apiKey, cacheKey, 3);
        this._inflight.set(cacheKey, promise);
        try {
            return await promise;
        } finally {
            this._inflight.delete(cacheKey);
        }
    }

    async _doFetchWithBackoff(path, params, apiKey, cacheKey, retries) {
        const url = new URL(`${TMDB_BASE}${path}`);
        url.searchParams.set('api_key', apiKey);
        // Always include language for localized results
        if (!params.language) {
            url.searchParams.set('language', this.getTrailerLanguage());
        }
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

        await this._acquireSlot();
        let releaseInFinally = true;
        try {
            const res = await fetch(url.toString());
            if (res.status === 429) {
                // Honor Retry-After (seconds). TMDB also sometimes sets the
                // ms-based `x-ratelimit-reset` header; either works as a hint.
                const retryAfterSec = parseInt(res.headers.get('Retry-After') || '', 10);
                const pauseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
                    ? retryAfterSec * 1000
                    : 10000;
                // Global pause — every in-flight + queued request will honor this.
                this._pauseUntil = Math.max(this._pauseUntil, Date.now() + pauseMs);
                if (retries > 0) {
                    // Free the slot so other (paused) requests can resume after the
                    // pause; we'll re-acquire on retry.
                    this._releaseSlot();
                    releaseInFinally = false;
                    await new Promise((r) => setTimeout(r, pauseMs + 100));
                    return this._doFetchWithBackoff(path, params, apiKey, cacheKey, retries - 1);
                }
                return null;
            }
            if (!res.ok) return null;
            const data = await res.json();
            this._setCache(cacheKey, data);
            // Mirror into the persistent cache so reloads can serve it without
            // a network round-trip. 6h TTL — TMDB rows change daily at most.
            this._persistSet(`api:${cacheKey}`, data, API_RESPONSE_TTL);
            return data;
        } catch {
            return null;
        } finally {
            if (releaseInFinally) this._releaseSlot();
        }
    }

    async findByImdbId(imdbId) {
        // Persistent cache: imdbId → { type, id } (stable, safe to cache long-term)
        const persistKey = `find:${imdbId}`;
        const cached = this._persistGet(persistKey);
        if (cached !== undefined) return cached;

        const data = await this._fetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
        if (!data) return null;

        let result = null;
        if (data.movie_results?.length > 0) {
            result = { type: 'movie', ...data.movie_results[0] };
        } else if (data.tv_results?.length > 0) {
            result = { type: 'tv', ...data.tv_results[0] };
        }
        // Cache positive results only — negatives may be transient (rate limit, etc.)
        if (result) this._persistSet(persistKey, { type: result.type, id: result.id });
        return result;
    }

    async getDetails(tmdbId, mediaType = 'movie') {
        return await this._fetch(`/${mediaType}/${tmdbId}`);
    }

    async getRecommendations(tmdbId, mediaType = 'movie') {
        const data = await this._fetch(`/${mediaType}/${tmdbId}/recommendations`);
        if (!data?.results) return [];
        return data.results.slice(0, 20);
    }

    async getTrending(mediaType = 'movie', timeWindow = 'week') {
        const data = await this._fetch(`/trending/${mediaType}/${timeWindow}`);
        if (!data?.results) return [];
        return data.results;
    }

    async getPopular(mediaType = 'movie') {
        const data = await this._fetch(`/${mediaType}/popular`);
        if (!data?.results) return [];
        return data.results;
    }

    async getTopRated(mediaType = 'movie') {
        const data = await this._fetch(`/${mediaType}/top_rated`);
        if (!data?.results) return [];
        return data.results;
    }

    async getNowPlaying() {
        const data = await this._fetch('/movie/now_playing');
        if (!data?.results) return [];
        return data.results;
    }

    async getUpcoming() {
        const data = await this._fetch('/movie/upcoming');
        if (!data?.results) return [];
        return data.results;
    }

    async getAiringToday() {
        const data = await this._fetch('/tv/airing_today');
        if (!data?.results) return [];
        return data.results;
    }

    async getDiscover(mediaType = 'movie', params = {}) {
        const data = await this._fetch(`/discover/${mediaType}`, params);
        if (!data?.results) return [];
        return data.results;
    }

    // Resolve TMDB ID → IMDB ID via external_ids endpoint (cached, persisted)
    async getImdbId(tmdbId, mediaType = 'movie') {
        const cacheKey = `${mediaType}:${tmdbId}`;
        if (this._imdbCache.has(cacheKey)) return this._imdbCache.get(cacheKey);
        const persistKey = `imdb:${cacheKey}`;
        const persisted = this._persistGet(persistKey);
        if (persisted !== undefined) {
            this._imdbCache.set(cacheKey, persisted);
            return persisted;
        }
        try {
            const data = await this._fetch(`/${mediaType}/${tmdbId}/external_ids`);
            const imdbId = data?.imdb_id || null;
            this._imdbCache.set(cacheKey, imdbId);
            if (imdbId) this._persistSet(persistKey, imdbId);
            return imdbId;
        } catch {
            return null;
        }
    }

    // Enrich an array of Stremio items (from mapToStremioItem) with IMDB IDs.
    // Resolves TMDB IDs → IMDB IDs in parallel, updates id and deepLinks.
    async enrichWithImdbIds(items) {
        const toResolve = items.filter((item) => item.id && item.id.startsWith('tmdb:'));
        if (toResolve.length === 0) return items;

        await Promise.all(toResolve.map(async (item) => {
            const tmdbIdStr = item.id.replace('tmdb:', '');
            const mediaType = item.type === 'series' ? 'tv' : 'movie';
            const imdbId = await this.getImdbId(tmdbIdStr, mediaType);
            if (imdbId) {
                item._tmdbId = item.id; // preserve original TMDB ID
                item.id = imdbId;
                // A movie's streams page needs the videoId segment (which equals
                // the meta id for movies): #/metadetails/movie/tt../tt.. — without
                // it the meta page opens with no streams. Series go to the videos
                // (episodes) list instead, so no videoId.
                item.deepLinks = {
                    metaDetailsVideos: `#/metadetails/${item.type}/${imdbId}`,
                    metaDetailsStreams: item.type === 'movie' ?
                        `#/metadetails/movie/${imdbId}/${imdbId}` :
                        `#/metadetails/${item.type}/${imdbId}`,
                    player: null,
                };
            }
        }));

        return items;
    }

    // Map a TMDB item to Stremio-compatible format
    mapToStremioItem(tmdbItem, mediaType = 'movie') {
        const isMovie = mediaType === 'movie';
        const stremioType = isMovie ? 'movie' : 'series';
        const title = isMovie ? tmdbItem.title : tmdbItem.name;
        const year = (isMovie ? tmdbItem.release_date : tmdbItem.first_air_date || '').slice(0, 4);
        const tmdbId = tmdbItem.id;

        return {
            id: `tmdb:${tmdbId}`,
            type: stremioType,
            name: title || '',
            poster: tmdbItem.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${tmdbItem.backdrop_path}` : null,
            posterShape: 'landscape',
            background: tmdbItem.backdrop_path ? `${TMDB_IMAGE_BASE}/original${tmdbItem.backdrop_path}` : null,
            releaseInfo: year,
            description: tmdbItem.overview || '',
            links: (tmdbItem.genre_ids || []).map((id) => ({ category: 'Genres', name: GENRE_MAP[id] || '' })).filter((l) => l.name),
            deepLinks: {
                metaDetailsVideos: `#/metadetails/${stremioType}/tmdb:${tmdbId}`,
                metaDetailsStreams: isMovie ?
                    `#/metadetails/movie/tmdb:${tmdbId}/tmdb:${tmdbId}` :
                    `#/metadetails/${stremioType}/tmdb:${tmdbId}`,
                player: null,
            },
        };
    }

    /**
     * Get the best trailer YouTube ID for a given TMDB item.
     * Uses TMDB /videos endpoint with smart ranking:
     *   1. Filter: type=Trailer, site=YouTube, official=true, preferred language
     *   2. Exclude: sign language, behind-the-scenes, bloopers, featurettes, etc.
     *   3. Rank: official first, then by recency (published_at)
     *   4. Fallback to any language if preferred language has no results
     */
    async getBestTrailerYtId(tmdbId, mediaType = 'movie') {
        // Trailer ytIds are stable per (tmdbId, mediaType, language) and a
        // popular per-card lookup — persist them across reloads so the
        // videos endpoint isn't re-hit on every home-screen mount.
        const lang = this.getTrailerLanguage();
        const persistKey = `trailer:${mediaType}:${tmdbId}:${lang}`;
        const persisted = this._persistGet(persistKey);
        if (persisted !== undefined) return persisted;

        const data = await this._fetch(`/${mediaType}/${tmdbId}`, {
            append_to_response: 'videos',
            language: this.getTrailerLanguage(),
        });
        if (!data?.videos?.results) {
            this._persistSet(persistKey, null);
            return null;
        }

        const preferredLang = this.getTrailerLanguage();
        const allVideos = data.videos.results;

        // Filter to YouTube trailers only
        let trailers = allVideos.filter((v) =>
            v.site === 'YouTube' &&
            v.type === 'Trailer' &&
            v.key &&
            !BAD_TRAILER_PATTERNS.test(v.name || '')
        );

        if (trailers.length === 0) {
            // Fallback: accept Teasers too, but still YouTube + not bad patterns
            trailers = allVideos.filter((v) =>
                v.site === 'YouTube' &&
                (v.type === 'Trailer' || v.type === 'Teaser') &&
                v.key &&
                !BAD_TRAILER_PATTERNS.test(v.name || '')
            );
        }

        if (trailers.length === 0) {
            this._persistSet(persistKey, null);
            return null;
        }

        // Rank trailers by quality score
        const ranked = trailers.map((v) => {
            let score = 0;
            // Official gets highest priority
            if (v.official === true) score += 100;
            // Preferred language match
            if (v.iso_639_1 === preferredLang) score += 50;
            // English fallback (if preferred isn't English)
            else if (v.iso_639_1 === 'en') score += 25;
            // "Official Trailer" in name is a strong signal
            if (/official\s*trailer/i.test(v.name || '')) score += 30;
            // "Trailer" in name (but not "Teaser Trailer")
            else if (/^trailer/i.test(v.name || '')) score += 15;
            // Trailers over Teasers
            if (v.type === 'Trailer') score += 10;
            // Newer is better
            if (v.published_at) {
                try {
                    const age = Date.now() - new Date(v.published_at).getTime();
                    // More recent = higher score (max 5 points for very recent)
                    score += Math.max(0, 5 - Math.floor(age / (365 * 24 * 60 * 60 * 1000)));
                } catch { /* ignore */ }
            }
            return { ...v, _score: score };
        });

        ranked.sort((a, b) => b._score - a._score);
        const ytId = ranked[0].key;
        this._persistSet(persistKey, ytId);
        return ytId;
    }

    /**
     * Get raw TMDB video results (for settings preview / debugging)
     */
    async getVideos(tmdbId, mediaType = 'movie') {
        const data = await this._fetch(`/${mediaType}/${tmdbId}`, { append_to_response: 'videos' });
        if (!data?.videos?.results) return [];
        return data.videos.results.filter((v) => v.type === 'Trailer' && v.site === 'YouTube');
    }

    /**
     * Get the title logo URL for a TMDB item.
     * Uses TMDB /images endpoint — returns English PNG logos.
     * Returns null if no logo is found.
     */
    async getLogoUrl(tmdbId, mediaType = 'movie') {
        const persistKey = `logo:${mediaType}:${tmdbId}`;
        const persisted = this._persistGet(persistKey);
        if (persisted !== undefined) return persisted;
        try {
            const data = await this._fetch(`/${mediaType}/${tmdbId}/images`, {
                include_image_language: 'en,null',
            });
            const logos = data?.logos || [];
            if (logos.length === 0) return null;
            // Prefer English PNG logos, sorted by vote_average descending
            const sorted = logos
                .filter((l) => l.file_path)
                .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
            if (sorted.length === 0) return null;
            const url = `${TMDB_IMAGE_BASE}/w780${sorted[0].file_path}`;
            this._persistSet(persistKey, url);
            return url;
        } catch {
            return null;
        }
    }

    /**
     * Synchronous logo URL lookup — returns a cached URL if available, else null.
     * Used by MetaItem to render the title logo on the FIRST paint instead of
     * after a useEffect → async chain. Walks the same persisted maps as the
     * async path, but never issues a network request.
     */
    getCachedLogoUrl(itemId, itemType) {
        if (!itemId) return null;
        let tmdbId = null;
        let mediaType = null;
        const tmdbMatch = itemId.match(/^tmdb:(\d+)$/);
        if (tmdbMatch) {
            tmdbId = parseInt(tmdbMatch[1], 10);
            mediaType = itemType === 'series' ? 'tv' : 'movie';
        } else if (/^tt/.test(itemId)) {
            const found = this._persistGet(`find:${itemId}`);
            if (!found) return null;
            tmdbId = found.id;
            mediaType = found.type;
        } else {
            return null;
        }
        const url = this._persistGet(`logo:${mediaType}:${tmdbId}`);
        return url || null;
    }

    /**
     * Resolve the TMDB ID for a given item (handles both tmdb: and tt prefixes).
     * Returns { tmdbId, mediaType } or null.
     */
    async resolveTmdbId(itemId, itemType) {
        if (!itemId) return null;
        const tmdbMatch = itemId.match(/^tmdb:(\d+)$/);
        if (tmdbMatch) {
            return { tmdbId: parseInt(tmdbMatch[1], 10), mediaType: itemType === 'series' ? 'tv' : 'movie' };
        }
        if (/^tt/.test(itemId)) {
            const found = await this.findByImdbId(itemId);
            if (found) return { tmdbId: found.id, mediaType: found.type };
        }
        return null;
    }

}

const tmdbService = new TMDBService();
module.exports = tmdbService;
