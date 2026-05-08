// Copyright (C) 2017-2024 Smart code 203358507

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour (in-memory API responses)

// Persistent (localStorage) cache for stable lookups: imdb→tmdb resolution and logo URLs.
// These results don't change for a given title, so we keep them across page reloads.
const PERSIST_KEY = 'tmdb_persist_cache_v1';
const PERSIST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const PERSIST_MAX_ENTRIES = 2000;

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

class TMDBService {
    constructor() {
        this._cache = new Map();
        this._imdbCache = new Map(); // tmdbId → imdbId (mirrors persistent cache)
        this._persist = this._loadPersist();
    }

    // --- Persistent cache (localStorage) for stable lookups ---

    _loadPersist() {
        try {
            const raw = localStorage.getItem(PERSIST_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch {
            return {};
        }
    }

    _savePersist() {
        try {
            // LRU eviction: if over cap, drop oldest entries by `time`
            const keys = Object.keys(this._persist);
            if (keys.length > PERSIST_MAX_ENTRIES) {
                const sorted = keys
                    .map((k) => ({ k, t: this._persist[k].time || 0 }))
                    .sort((a, b) => a.t - b.t);
                const toRemove = sorted.slice(0, keys.length - PERSIST_MAX_ENTRIES);
                for (const { k } of toRemove) delete this._persist[k];
            }
            localStorage.setItem(PERSIST_KEY, JSON.stringify(this._persist));
        } catch {
            // Quota exceeded or unavailable — drop everything and try once more
            try {
                this._persist = {};
                localStorage.removeItem(PERSIST_KEY);
            } catch { /* silent */ }
        }
    }

    _persistGet(key) {
        const entry = this._persist[key];
        if (!entry) return undefined;
        if (Date.now() - (entry.time || 0) > PERSIST_TTL) {
            delete this._persist[key];
            return undefined;
        }
        return entry.value;
    }

    _persistSet(key, value) {
        this._persist[key] = { value, time: Date.now() };
        // Debounce-ish: write immediately. Volume is low (a few writes per page load).
        this._savePersist();
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

        const url = new URL(`${TMDB_BASE}${path}`);
        url.searchParams.set('api_key', apiKey);
        // Always include language for localized results
        if (!params.language) {
            url.searchParams.set('language', this.getTrailerLanguage());
        }
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

        try {
            const res = await fetch(url.toString());
            if (!res.ok) return null;
            const data = await res.json();
            this._setCache(cacheKey, data);
            return data;
        } catch {
            return null;
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
                item.deepLinks = {
                    metaDetailsVideos: `#/metadetails/${item.type}/${imdbId}`,
                    metaDetailsStreams: `#/metadetails/${item.type}/${imdbId}`,
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
                metaDetailsStreams: `#/metadetails/${stremioType}/tmdb:${tmdbId}`,
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
        const data = await this._fetch(`/${mediaType}/${tmdbId}`, {
            append_to_response: 'videos',
            language: this.getTrailerLanguage(),
        });
        if (!data?.videos?.results) return null;

        const preferredLang = this.getTrailerLanguage();
        const allVideos = data.videos.results;

        // Filter to YouTube trailers only
        let trailers = allVideos.filter(v =>
            v.site === 'YouTube' &&
            v.type === 'Trailer' &&
            v.key &&
            !BAD_TRAILER_PATTERNS.test(v.name || '')
        );

        if (trailers.length === 0) {
            // Fallback: accept Teasers too, but still YouTube + not bad patterns
            trailers = allVideos.filter(v =>
                v.site === 'YouTube' &&
                (v.type === 'Trailer' || v.type === 'Teaser') &&
                v.key &&
                !BAD_TRAILER_PATTERNS.test(v.name || '')
            );
        }

        if (trailers.length === 0) return null;

        // Rank trailers by quality score
        const ranked = trailers.map(v => {
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
        return ranked[0].key;
    }

    /**
     * Get raw TMDB video results (for settings preview / debugging)
     */
    async getVideos(tmdbId, mediaType = 'movie') {
        const data = await this._fetch(`/${mediaType}/${tmdbId}`, { append_to_response: 'videos' });
        if (!data?.videos?.results) return [];
        return data.videos.results.filter(v => v.type === 'Trailer' && v.site === 'YouTube');
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
