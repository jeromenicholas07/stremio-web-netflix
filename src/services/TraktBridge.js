// TraktBridge — Direct browser→Trakt API service.
// Works because the user's Trakt OAuth app has CORS whitelisted for the app origin.
// Credentials are stored in localStorage and configured via Settings.

const TRAKT_API = 'https://api.trakt.tv';

class TraktBridge {
    constructor() {
        this._ratedIds = new Set();
        this._watchedIds = new Set();
        this._watchlistIds = new Set();
        this._notInterestedIds = new Set();
        this._allDismissedIds = new Set();
        this._lastSync = 0;
        this._syncInterval = 5 * 60 * 1000; // 5 minutes
        this._syncPromise = null;
        this._listeners = new Set();
        this._notInterestedListSlug = '';
    }

    // Subscribe to changes in dismissed IDs
    onChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _notify() {
        this._listeners.forEach((fn) => { try { fn(); } catch { /* */ } });
    }

    // ─── Config ───
    getClientId() {
        try { return localStorage.getItem('trakt_client_id') || ''; } catch { return ''; }
    }

    getAccessToken() {
        try { return localStorage.getItem('trakt_access_token') || ''; } catch { return ''; }
    }

    getNotInterestedListSlug() {
        try { return localStorage.getItem('trakt_not_interested_slug') || ''; } catch { return ''; }
    }

    setClientId(val) {
        try { localStorage.setItem('trakt_client_id', val); } catch { /* */ }
    }

    setAccessToken(val) {
        try { localStorage.setItem('trakt_access_token', val); } catch { /* */ }
    }

    setNotInterestedListSlug(val) {
        try { localStorage.setItem('trakt_not_interested_slug', val); } catch { /* */ }
        this._notInterestedListSlug = val;
    }

    isConfigured() {
        return !!(this.getClientId() && this.getAccessToken());
    }

    // ─── Raw fetch ───
    async _fetch(path, options = {}) {
        const clientId = this.getClientId();
        const token = this.getAccessToken();
        if (!clientId || !token) {
            throw new Error('Trakt credentials not configured');
        }

        const headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': clientId,
            'Authorization': `Bearer ${token}`,
            ...options.headers,
        };

        const res = await fetch(`${TRAKT_API}${path}`, {
            ...options,
            headers,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Trakt API ${res.status}: ${text.slice(0, 200)}`);
        }

        // Some endpoints return 204 No Content
        if (res.status === 204) return {};
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('json')) return res.json();
        return {};
    }

    // Also handle POST/DELETE that return 201/200
    async _post(path, body) {
        const clientId = this.getClientId();
        const token = this.getAccessToken();
        if (!clientId || !token) {
            throw new Error('Trakt credentials not configured');
        }

        const res = await fetch(`${TRAKT_API}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId,
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });

        const text = await res.text().catch(() => '');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
    }

    // ─── Test connection ───
    async testConnection() {
        try {
            const data = await this._fetch('/users/settings');
            const user = data?.user;
            return {
                ok: true,
                message: `Connected as ${user?.username || 'unknown'}`,
                user: {
                    username: user?.username,
                    name: user?.name,
                    vip: user?.vip,
                },
            };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    // ─── Rate item ───
    // rating: 1-5 from UI stars → map to 2-10 for Trakt (multiply by 2)
    async rateItem(itemId, type, rating) {
        const traktRating = Math.min(10, Math.max(1, rating * 2));
        const { imdb, tmdb } = this._parseId(itemId);

        const item = { rated_at: new Date().toISOString(), rating: traktRating };
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/ratings', { [traktType]: [item] });

        if (result.ok) {
            this._ratedIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Watchlist ───
    async addToWatchlist(itemId, type) {
        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/watchlist', { [traktType]: [item] });

        if (result.ok) {
            this._watchlistIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    async removeFromWatchlist(itemId, type) {
        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/watchlist/remove', { [traktType]: [item] });

        if (result.ok) {
            this._watchlistIds.delete(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Not Interested (custom list) ───
    async addToNotInterested(itemId, type) {
        const slug = this.getNotInterestedListSlug();
        if (!slug) throw new Error('Not Interested list slug not configured');

        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        // Get username from settings or use 'me'
        const result = await this._post(`/users/me/lists/${slug}/items`, { [traktType]: [item] });

        if (result.ok) {
            this._notInterestedIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Mark as watched ───
    async markWatched(itemId, type) {
        const { imdb, tmdb } = this._parseId(itemId);
        const item = { watched_at: new Date().toISOString() };
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/history', { [traktType]: [item] });

        if (result.ok) {
            this._watchedIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Sync all data from Trakt ───
    async syncAll(force = false) {
        if (!this.isConfigured()) return;
        if (!force && Date.now() - this._lastSync < this._syncInterval) return;
        if (this._syncPromise) return this._syncPromise;

        this._syncPromise = this._doSync();
        try {
            await this._syncPromise;
        } finally {
            this._syncPromise = null;
        }
    }

    async _doSync() {
        try {
            const [ratingsMovies, ratingsShows, watchedMovies, watchedShows] = await Promise.all([
                this._fetch('/sync/ratings/movies').catch(() => []),
                this._fetch('/sync/ratings/shows').catch(() => []),
                this._fetch('/sync/watched/movies').catch(() => []),
                this._fetch('/sync/watched/shows').catch(() => []),
            ]);

            // Build rated IDs
            const newRated = new Set();
            (Array.isArray(ratingsMovies) ? ratingsMovies : []).forEach((r) => {
                if (r.movie?.ids?.imdb) newRated.add(r.movie.ids.imdb);
                if (r.movie?.ids?.tmdb) newRated.add(`tmdb:${r.movie.ids.tmdb}`);
            });
            (Array.isArray(ratingsShows) ? ratingsShows : []).forEach((r) => {
                if (r.show?.ids?.imdb) newRated.add(r.show.ids.imdb);
                if (r.show?.ids?.tmdb) newRated.add(`tmdb:${r.show.ids.tmdb}`);
            });
            this._ratedIds = newRated;

            // Build watched IDs
            const newWatched = new Set();
            (Array.isArray(watchedMovies) ? watchedMovies : []).forEach((w) => {
                if (w.movie?.ids?.imdb) newWatched.add(w.movie.ids.imdb);
                if (w.movie?.ids?.tmdb) newWatched.add(`tmdb:${w.movie.ids.tmdb}`);
            });
            (Array.isArray(watchedShows) ? watchedShows : []).forEach((w) => {
                if (w.show?.ids?.imdb) newWatched.add(w.show.ids.imdb);
                if (w.show?.ids?.tmdb) newWatched.add(`tmdb:${w.show.ids.tmdb}`);
            });
            this._watchedIds = newWatched;

            this._rebuildDismissed();
            this._lastSync = Date.now();
            this._notify();
        } catch (err) {
            console.warn('TraktBridge sync failed:', err.message);
        }
    }

    _rebuildDismissed() {
        const all = new Set();
        this._ratedIds.forEach((id) => all.add(id));
        this._watchedIds.forEach((id) => all.add(id));
        this._watchlistIds.forEach((id) => all.add(id));
        this._notInterestedIds.forEach((id) => all.add(id));
        this._allDismissedIds = all;
    }

    getDismissedIds() {
        return this._allDismissedIds;
    }

    isItemDismissed(itemId) {
        return this._allDismissedIds.has(itemId);
    }

    // ─── Get user lists (for finding the not-interested list slug) ───
    async getLists() {
        try {
            return await this._fetch('/users/me/lists');
        } catch {
            return [];
        }
    }

    // ─── Helpers ───
    _parseId(itemId) {
        if (!itemId) return {};
        const tmdbMatch = itemId.match(/^tmdb:(\d+)$/);
        if (tmdbMatch) return { tmdb: tmdbMatch[1] };
        if (itemId.startsWith('tt')) return { imdb: itemId };
        return {};
    }
}

const traktBridge = new TraktBridge();
module.exports = traktBridge;
