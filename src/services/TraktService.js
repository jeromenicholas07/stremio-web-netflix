// Copyright (C) 2017-2024 Smart code 203358507

const TRAKT_BASE = 'https://api.trakt.tv';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const METAHUB_POSTER = 'https://images.metahub.space/poster/medium';
const METAHUB_BACKGROUND = 'https://images.metahub.space/background/medium';

class TraktService {
    constructor() {
        this._cache = new Map();
    }

    // --- Settings stored in localStorage ---

    getClientId() {
        try {
            return localStorage.getItem('trakt_client_id') || '';
        } catch {
            return '';
        }
    }

    setClientId(id) {
        try {
            localStorage.setItem('trakt_client_id', id);
        } catch {
            // silent fail
        }
    }

    isConfigured() {
        return !!this.getClientId();
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
        const clientId = this.getClientId();
        if (!clientId) return null;

        const cacheKey = `${path}?${JSON.stringify(params)}`;
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        const url = new URL(`${TRAKT_BASE}${path}`);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

        try {
            const res = await fetch(url.toString(), {
                headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': clientId,
                },
            });
            if (!res.ok) return null;
            const data = await res.json();
            this._setCache(cacheKey, data);
            return data;
        } catch {
            return null;
        }
    }

    // --- Public endpoints (no OAuth required) ---

    async getTrending(type = 'movies', limit = 20) {
        const data = await this._fetch(`/${type}/trending`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getPopular(type = 'movies', limit = 20) {
        const data = await this._fetch(`/${type}/popular`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data;
    }

    async getAnticipated(type = 'movies', limit = 20) {
        const data = await this._fetch(`/${type}/anticipated`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getMostWatched(type = 'movies', period = 'weekly', limit = 20) {
        const data = await this._fetch(`/${type}/watched/${period}`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getRecommended(type = 'movies', period = 'weekly', limit = 20) {
        const data = await this._fetch(`/${type}/recommended/${period}`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getPlayed(type = 'movies', period = 'weekly', limit = 20) {
        const data = await this._fetch(`/${type}/played/${period}`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getFavorited(type = 'movies', period = 'weekly', limit = 20) {
        const data = await this._fetch(`/${type}/favorited/${period}`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    async getBoxOffice() {
        const data = await this._fetch('/movies/boxoffice', { extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item.movie).filter(Boolean);
    }

    async getUpdated(type = 'movies', limit = 20) {
        const today = new Date().toISOString().split('T')[0];
        const data = await this._fetch(`/${type}/updates/${today}`, { limit: String(limit), extended: 'full' });
        if (!Array.isArray(data)) return [];
        return data.map((item) => item[type === 'movies' ? 'movie' : 'show']).filter(Boolean);
    }

    // --- Map to Stremio-compatible item ---

    mapToStremioItem(traktItem, mediaType = 'movie') {
        const ids = traktItem.ids || {};
        const imdbId = ids.imdb;
        const isMovie = mediaType === 'movie';
        const stremioType = isMovie ? 'movie' : 'series';

        return {
            id: imdbId || ids.slug || null,
            type: stremioType,
            name: traktItem.title || '',
            poster: imdbId ? `${METAHUB_POSTER}/${imdbId}/img` : null,
            posterShape: 'landscape',
            background: imdbId ? `${METAHUB_BACKGROUND}/${imdbId}/img` : null,
            releaseInfo: traktItem.year ? String(traktItem.year) : '',
            description: traktItem.overview || '',
            links: Array.isArray(traktItem.genres)
                ? traktItem.genres.map((g) => ({ category: 'Genres', name: g.charAt(0).toUpperCase() + g.slice(1) }))
                : [],
            deepLinks: imdbId ? {
                metaDetailsVideos: `#/metadetails/${stremioType}/${imdbId}`,
                metaDetailsStreams: stremioType === 'movie' ?
                    `#/metadetails/movie/${imdbId}/${imdbId}` :
                    `#/metadetails/${stremioType}/${imdbId}`,
                player: null,
            } : {
                metaDetailsVideos: null,
                metaDetailsStreams: null,
                player: null,
            },
        };
    }
}

const traktService = new TraktService();
module.exports = traktService;
