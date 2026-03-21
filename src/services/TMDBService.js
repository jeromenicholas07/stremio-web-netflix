// Copyright (C) 2017-2024 Smart code 203358507

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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
        const data = await this._fetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
        if (!data) return null;

        if (data.movie_results?.length > 0) {
            return { type: 'movie', ...data.movie_results[0] };
        }
        if (data.tv_results?.length > 0) {
            return { type: 'tv', ...data.tv_results[0] };
        }
        return null;
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
            poster: tmdbItem.backdrop_path ? `${TMDB_IMAGE_BASE}/w780${tmdbItem.backdrop_path}` : null,
            posterShape: 'landscape',
            background: tmdbItem.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${tmdbItem.backdrop_path}` : null,
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

}

const tmdbService = new TMDBService();
module.exports = tmdbService;
