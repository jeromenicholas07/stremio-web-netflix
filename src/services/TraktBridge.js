// TraktBridge — Direct browser→Trakt API service with proper OAuth (Device Code flow).
// Uses Trakt Device Auth: user enters a short code at trakt.tv/activate,
// app polls until authorized, then stores access_token + refresh_token.

// Use local proxy to avoid CORS issues with Trakt API.
// Webpack dev server proxies /trakt-api/* → https://api.trakt.tv/*
// For production builds, falls back to direct API (works in Stremio shell which has no CORS).
const TRAKT_API = typeof window !== 'undefined' && window.location?.hostname === 'localhost'
    ? '/trakt-api'
    : 'https://api.trakt.tv';
const DEFAULT_CLIENT_ID = '67bffdb0ebe7ee9ffda2192bf2a463d7a9f36da83325fd94e04552052ad7372c';
const DEFAULT_CLIENT_SECRET = '02768d0e1459bd002b5b1a99f70e0b84d68d068823d3acce95b91fb282e8da95';

class TraktBridge {
    constructor() {
        this._ratedIds = new Set();
        this._watchedIds = new Set();
        this._watchlistIds = new Set();
        this._notInterestedIds = new Set();
        this._allDismissedIds = new Set();
        this._syncInterval = 5 * 60 * 1000; // 5 minutes
        this._syncPromise = null;
        this._listeners = new Set();
        this._notInterestedListSlug = '';
        // Full item data from sync for rows — hydrated from localStorage so
        // reloads within the sync window don't need a round-trip to Trakt.
        const hydrated = this._readSyncSnapshot();
        this._lastSync = hydrated.lastSync || 0;
        this._watchedItemsData = hydrated.watchedItemsData || [];
        this._watchlistItemsData = hydrated.watchlistItemsData || [];
        this._notInterestedItemsData = hydrated.notInterestedItemsData || [];
        this._ratedImdbIds = new Set(hydrated.ratedImdb || []);
        this._ratedTmdbIds = new Set(hydrated.ratedTmdb || []);
        this._watchedIds = new Set(hydrated.watchedIds || []);
        this._watchlistIds = new Set(hydrated.watchlistIds || []);
        this._notInterestedIds = new Set(hydrated.notInterestedIds || []);
        // Rebuild composite _ratedIds (imdb IDs + tmdb-prefixed IDs) and
        // the all-dismissed set so filters work without waiting for a sync.
        this._ratedImdbIds.forEach((id) => this._ratedIds.add(id));
        this._ratedTmdbIds.forEach((id) => this._ratedIds.add(`tmdb:${id}`));
        this._watchedIds.forEach((id) => this._allDismissedIds.add(id));
        this._notInterestedIds.forEach((id) => this._allDismissedIds.add(id));
        this._ratedIds.forEach((id) => this._allDismissedIds.add(id));
        // Items marked watched locally but not yet confirmed by API
        this._pendingWatchedItems = new Map(); // id → item data
        // Device auth polling
        this._devicePollTimer = null;
        this._devicePollAbort = null;
    }

    // ─── Sync snapshot persistence ───
    // Persists the parsed result of a /sync/* fan-out to localStorage so
    // reloads within the sync window can skip the network round-trip entirely.
    _readSyncSnapshot() {
        try {
            const raw = localStorage.getItem('trakt_sync_snapshot_v1');
            if (!raw) return {};
            return JSON.parse(raw) || {};
        } catch { return {}; }
    }
    _writeSyncSnapshot() {
        try {
            const snap = {
                lastSync: this._lastSync,
                watchedItemsData: this._watchedItemsData,
                watchlistItemsData: this._watchlistItemsData,
                notInterestedItemsData: this._notInterestedItemsData,
                ratedImdb: Array.from(this._ratedImdbIds),
                ratedTmdb: Array.from(this._ratedTmdbIds),
                watchedIds: Array.from(this._watchedIds),
                watchlistIds: Array.from(this._watchlistIds),
                notInterestedIds: Array.from(this._notInterestedIds),
            };
            localStorage.setItem('trakt_sync_snapshot_v1', JSON.stringify(snap));
        } catch { /* quota — ignore */ }
    }

    // ─── Event system ───
    onChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _notify() {
        this._listeners.forEach((fn) => { try { fn(); } catch { /* */ } });
    }

    // ─── OAuth Token Management ───

    getClientId() {
        try { return localStorage.getItem('trakt_client_id') || DEFAULT_CLIENT_ID; }
        catch { return DEFAULT_CLIENT_ID; }
    }

    setClientId(val) {
        try { localStorage.setItem('trakt_client_id', val); }
        catch { /* */ }
    }

    getClientSecret() {
        try { return localStorage.getItem('trakt_client_secret') || DEFAULT_CLIENT_SECRET; }
        catch { return DEFAULT_CLIENT_SECRET; }
    }

    setClientSecret(val) {
        try { localStorage.setItem('trakt_client_secret', val); }
        catch { /* */ }
    }

    getAccessToken() {
        try { return localStorage.getItem('trakt_access_token') || ''; }
        catch { return ''; }
    }

    setAccessToken(val) {
        try { localStorage.setItem('trakt_access_token', val); }
        catch { /* */ }
    }

    getRefreshToken() {
        try { return localStorage.getItem('trakt_refresh_token') || ''; }
        catch { return ''; }
    }

    setRefreshToken(val) {
        try { localStorage.setItem('trakt_refresh_token', val); }
        catch { /* */ }
    }

    getTokenExpiry() {
        try {
            const v = localStorage.getItem('trakt_token_expiry');
            return v ? parseInt(v, 10) : 0;
        } catch { return 0; }
    }

    setTokenExpiry(timestamp) {
        try { localStorage.setItem('trakt_token_expiry', String(timestamp)); }
        catch { /* */ }
    }

    getUsername() {
        try { return localStorage.getItem('trakt_username') || ''; }
        catch { return ''; }
    }

    setUsername(val) {
        try { localStorage.setItem('trakt_username', val); }
        catch { /* */ }
    }

    getNotInterestedListSlug() {
        try { return localStorage.getItem('trakt_not_interested_slug') || ''; }
        catch { return ''; }
    }

    setNotInterestedListSlug(val) {
        try { localStorage.setItem('trakt_not_interested_slug', val); }
        catch { /* */ }
        this._notInterestedListSlug = val;
    }

    isConnected() {
        return !!this.getAccessToken();
    }

    isConfigured() {
        return this.isConnected();
    }

    isTokenExpired() {
        const expiry = this.getTokenExpiry();
        if (!expiry) return true;
        // Consider expired 5 minutes early to avoid edge cases
        return Date.now() > (expiry - 5 * 60 * 1000);
    }

    // ─── Device Code OAuth Flow ───
    // Step 1: Request a device code from Trakt
    async startDeviceAuth() {
        const res = await fetch(`${TRAKT_API}/oauth/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: this.getClientId() }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Failed to start device auth: ${res.status} ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        // Returns: { device_code, user_code, verification_url, expires_in, interval }
        return data;
    }

    // Step 2: Poll for authorization (call this after startDeviceAuth)
    // Returns a promise that resolves when the user authorizes, or rejects on timeout/error.
    // onStatus callback receives status updates for the UI.
    pollDeviceAuth(deviceCode, interval, expiresIn, onStatus) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + expiresIn * 1000;
            const pollInterval = Math.max(interval, 5) * 1000; // Trakt minimum 5s

            // Cancel any existing poll
            this.cancelDevicePoll();

            const poll = async () => {
                if (Date.now() > deadline) {
                    if (onStatus) onStatus('expired');
                    reject(new Error('Device authorization expired. Please try again.'));
                    return;
                }

                try {
                    const res = await fetch(`${TRAKT_API}/oauth/device/token`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            code: deviceCode,
                            client_id: this.getClientId(),
                            client_secret: this.getClientSecret(),
                        }),
                    });

                    if (res.status === 200) {
                        // Success! User authorized.
                        const data = await res.json();
                        this._storeTokens(data);
                        if (onStatus) onStatus('success');
                        resolve(data);
                        return;
                    }

                    if (res.status === 400) {
                        // Pending — user hasn't authorized yet
                        if (onStatus) onStatus('pending');
                        this._devicePollTimer = setTimeout(poll, pollInterval);
                        return;
                    }

                    if (res.status === 404) {
                        // Invalid device code
                        reject(new Error('Invalid device code. Please try again.'));
                        return;
                    }

                    if (res.status === 409) {
                        // Already approved
                        const data = await res.json();
                        this._storeTokens(data);
                        if (onStatus) onStatus('success');
                        resolve(data);
                        return;
                    }

                    if (res.status === 410) {
                        // Expired
                        reject(new Error('Device code expired. Please try again.'));
                        return;
                    }

                    if (res.status === 418) {
                        // Denied
                        reject(new Error('Authorization denied by user.'));
                        return;
                    }

                    if (res.status === 429) {
                        // Slow down — increase interval
                        this._devicePollTimer = setTimeout(poll, pollInterval + 5000);
                        return;
                    }

                    // Unknown error
                    const text = await res.text().catch(() => '');
                    reject(new Error(`Unexpected response: ${res.status} ${text.slice(0, 100)}`));
                } catch (err) {
                    // Network error — retry
                    if (onStatus) onStatus('pending');
                    this._devicePollTimer = setTimeout(poll, pollInterval);
                }
            };

            poll();
        });
    }

    cancelDevicePoll() {
        if (this._devicePollTimer) {
            clearTimeout(this._devicePollTimer);
            this._devicePollTimer = null;
        }
    }

    _storeTokens(data) {
        // data: { access_token, token_type, expires_in, refresh_token, scope, created_at }
        this.setAccessToken(data.access_token);
        this.setRefreshToken(data.refresh_token);
        // expires_in is in seconds, created_at is unix timestamp
        const expiryMs = (data.created_at + data.expires_in) * 1000;
        this.setTokenExpiry(expiryMs);
    }

    // ─── Token Refresh ───
    async refreshAccessToken() {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            throw new Error('No refresh token available. Please reconnect to Trakt.');
        }

        const res = await fetch(`${TRAKT_API}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                refresh_token: refreshToken,
                client_id: this.getClientId(),
                client_secret: this.getClientSecret(),
                redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
                grant_type: 'refresh_token',
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            // If refresh fails, clear tokens — user needs to re-authorize
            if (res.status === 401 || res.status === 403) {
                this.disconnect();
            }
            throw new Error(`Token refresh failed: ${res.status} ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        this._storeTokens(data);
        return data;
    }

    // ─── Disconnect (clear all auth data) ───
    disconnect() {
        this.cancelDevicePoll();
        try {
            localStorage.removeItem('trakt_access_token');
            localStorage.removeItem('trakt_refresh_token');
            localStorage.removeItem('trakt_token_expiry');
            localStorage.removeItem('trakt_username');
        } catch { /* */ }
        // Clear synced data
        this._ratedIds = new Set();
        this._watchedIds = new Set();
        this._watchlistIds = new Set();
        this._notInterestedIds = new Set();
        this._allDismissedIds = new Set();
        this._watchedItemsData = [];
        this._watchlistItemsData = [];
        this._notInterestedItemsData = [];
        this._ratedImdbIds = new Set();
        this._ratedTmdbIds = new Set();
        this._lastSync = 0;
        try {
            localStorage.removeItem('trakt_sync_snapshot_v1');
            localStorage.removeItem('trakt_response_cache_v1');
        } catch { /* */ }
        this._notify();
    }

    // ─── Ensure valid token (auto-refresh if expired) ───
    async _ensureToken() {
        if (!this.getAccessToken()) {
            throw new Error('Not connected to Trakt');
        }
        if (this.isTokenExpired() && this.getRefreshToken()) {
            try {
                await this.refreshAccessToken();
            } catch (err) {
                throw new Error(`Token expired and refresh failed: ${err.message}`);
            }
        }
    }

    // ─── Public unauthenticated fetch (trending, popular, etc.) ───
    // Trakt public endpoints only need trakt-api-key + trakt-api-version.
    async fetchPublic(path) {
        const clientId = this.getClientId();
        if (!clientId) throw new Error('No Trakt client ID');
        const res = await fetch(`${TRAKT_API}${path}`, {
            headers: {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId,
            },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Trakt API ${res.status}: ${text.slice(0, 200)}`);
        }
        if (res.status === 204) return {};
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) return res.json();
        return {};
    }

    // Public alias for the auth-required _fetch (used by hooks).
    async fetchAuth(path, options = {}) {
        return this._fetch(path, options);
    }

    // ─── Response cache (stale-while-revalidate) ───
    // Backs discovery/list fetches with a localStorage cache so repeated mounts
    // don't blow through Trakt's rate limits. On fetch errors (e.g. rate limit)
    // the most recent cached value is returned as a graceful fallback.
    //
    // Keys: 'public:<path>' or 'auth:<path>'
    // Values: { ts: epoch_ms, data: ... }
    _readCache() {
        try { return JSON.parse(localStorage.getItem('trakt_response_cache_v1') || '{}'); }
        catch { return {}; }
    }
    _writeCache(cache) {
        try { localStorage.setItem('trakt_response_cache_v1', JSON.stringify(cache)); }
        catch { /* quota exceeded — ignore, cache is best-effort */ }
    }
    // In-flight promise dedup so parallel callers share one network round-trip.
    _inflight = new Map();

    async _cachedFetch(key, fetcher, ttlMs) {
        const cache = this._readCache();
        const entry = cache[key];
        const now = Date.now();
        if (entry && (now - entry.ts) < ttlMs) {
            return entry.data;
        }
        if (this._inflight.has(key)) return this._inflight.get(key);
        const p = (async () => {
            try {
                const data = await fetcher();
                const fresh = this._readCache();
                fresh[key] = { ts: Date.now(), data };
                this._writeCache(fresh);
                return data;
            } catch (err) {
                // On rate-limit / network failure, serve the stale entry if
                // we have one so the UI keeps working.
                if (entry) {
                    console.warn('[Trakt] Serving stale cache for', key, '—', err.message);
                    return entry.data;
                }
                throw err;
            } finally {
                this._inflight.delete(key);
            }
        })();
        this._inflight.set(key, p);
        return p;
    }

    // Cached variants used by discovery/list hooks.
    async fetchPublicCached(path, ttlMs = 60 * 60 * 1000) {
        return this._cachedFetch('public:' + path, () => this.fetchPublic(path), ttlMs);
    }
    async fetchAuthCached(path, ttlMs = 30 * 60 * 1000) {
        return this._cachedFetch('auth:' + path, () => this._fetch(path), ttlMs);
    }

    // Manual cache clear (exposed for dev/debug via window.traktBridge).
    clearResponseCache() {
        try { localStorage.removeItem('trakt_response_cache_v1'); } catch { /* */ }
        this._inflight.clear();
    }

    // ─── Raw fetch with auto-refresh ───
    async _fetch(path, options = {}) {
        await this._ensureToken();

        const token = this.getAccessToken();
        const clientId = this.getClientId();
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

        if (res.status === 401) {
            // Token might have been revoked — try one refresh
            if (this.getRefreshToken()) {
                try {
                    await this.refreshAccessToken();
                    // Retry with new token
                    const newToken = this.getAccessToken();
                    const retryRes = await fetch(`${TRAKT_API}${path}`, {
                        ...options,
                        headers: { ...headers, 'Authorization': `Bearer ${newToken}` },
                    });
                    if (!retryRes.ok) {
                        const text = await retryRes.text().catch(() => '');
                        throw new Error(`Trakt API ${retryRes.status}: ${text.slice(0, 200)}`);
                    }
                    if (retryRes.status === 204) return {};
                    const ct = retryRes.headers.get('content-type') || '';
                    if (ct.includes('json')) return retryRes.json();
                    return {};
                } catch {
                    this.disconnect();
                    throw new Error('Trakt session expired. Please reconnect.');
                }
            }
            this.disconnect();
            throw new Error('Trakt session expired. Please reconnect.');
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Trakt API ${res.status}: ${text.slice(0, 200)}`);
        }

        if (res.status === 204) return {};
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('json')) return res.json();
        return {};
    }

    async _post(path, body) {
        await this._ensureToken();

        const token = this.getAccessToken();
        const headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': this.getClientId(),
            'Authorization': `Bearer ${token}`,
        };

        let res = await fetch(`${TRAKT_API}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        // Auto-retry on 401 with refreshed token
        if (res.status === 401 && this.getRefreshToken()) {
            try {
                await this.refreshAccessToken();
                const newToken = this.getAccessToken();
                res = await fetch(`${TRAKT_API}${path}`, {
                    method: 'POST',
                    headers: { ...headers, 'Authorization': `Bearer ${newToken}` },
                    body: JSON.stringify(body),
                });
            } catch {
                this.disconnect();
                throw new Error('Trakt session expired. Please reconnect in Settings.');
            }
        }

        const text = await res.text().catch(() => '');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }

        return { status: res.status, ok: res.status >= 200 && res.status < 300, data, path };
    }

    // ─── Test connection & fetch username ───
    async testConnection() {
        try {
            const data = await this._fetch('/users/settings');
            const user = data?.user;
            if (user?.username) {
                this.setUsername(user.username);
            }
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

    // Returns watched items that haven't been rated, sorted by watchedAt desc
    getWatchedNotRated() {
        return this._watchedItemsData.filter((item) => {
            if (item.imdbId && this._ratedImdbIds.has(item.imdbId)) return false;
            if (item.tmdbId && this._ratedTmdbIds.has(item.tmdbId)) return false;
            return true;
        });
    }

    // Returns full watchlist item data for rendering rows
    getWatchlistItems() { return this._watchlistItemsData; }

    // Returns full not-interested item data for rendering rows
    getNotInterestedItems() { return this._notInterestedItemsData; }

    // ─── Rate item ───
    async rateItem(itemId, type, rating) {
        const traktRating = Math.min(10, Math.max(1, rating * 2));
        const { imdb, tmdb } = this._parseId(itemId);

        const item = { rated_at: new Date().toISOString(), rating: traktRating };
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        // Optimistic: add to rated sets BEFORE API call so item leaves Watched (Not Rated) immediately
        this._ratedIds.add(itemId);
        if (imdb) this._ratedImdbIds.add(imdb);
        if (tmdb) this._ratedTmdbIds.add(parseInt(tmdb, 10));
        this._rebuildDismissed();
        this._notify();

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/ratings', { [traktType]: [item] });

        if (result.ok) {
            // Delayed refresh to sync watched/rated data from Trakt
            this._scheduleRefresh('watched');
        } else {
            // Rollback: remove from rated sets so item reappears in Watched (Not Rated)
            this._ratedIds.delete(itemId);
            if (imdb) this._ratedImdbIds.delete(imdb);
            if (tmdb) this._ratedTmdbIds.delete(parseInt(tmdb, 10));
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Watchlist ───
    async addToWatchlist(itemId, type, itemName) {
        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/watchlist', { [traktType]: [item] });

        if (result.ok) {
            this._watchlistIds.add(itemId);
            // Optimistic: add to local data immediately
            const alreadyExists = this._watchlistItemsData.some((w) => w.id === itemId);
            if (!alreadyExists) {
                this._watchlistItemsData = [{
                    id: itemId, imdbId: imdb || null, tmdbId: tmdb ? parseInt(tmdb, 10) : null,
                    name: itemName || '', type: type === 'series' ? 'series' : 'movie',
                    year: null, listedAt: new Date().toISOString(),
                }, ...this._watchlistItemsData];
            }
            this._rebuildDismissed();
            this._notify();
            // Delayed refresh to let Trakt propagate
            this._scheduleRefresh('watchlist');
        }
        return result;
    }

    async removeFromWatchlist(itemId, type) {
        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

        // Optimistic: update local state BEFORE the API call
        // Remove all ID variants (imdb, tmdb:N) since items may be stored under either
        this._watchlistIds.delete(itemId);
        if (imdb) this._watchlistIds.delete(imdb);
        if (tmdb) this._watchlistIds.delete(`tmdb:${tmdb}`);
        this._watchlistItemsData = this._watchlistItemsData.filter((w) =>
            w.id !== itemId &&
            (!imdb || (w.id !== imdb && w.imdbId !== imdb)) &&
            (!tmdb || (w.id !== `tmdb:${tmdb}` && w.tmdbId !== parseInt(tmdb, 10)))
        );
        this._rebuildDismissed();
        this._notify();

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/watchlist/remove', { [traktType]: [item] });

        if (!result.ok) {
            this._watchlistIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // ─── Not Interested (custom list) ───
    async addToNotInterested(itemId, type, itemName) {
        const slug = this.getNotInterestedListSlug();
        if (!slug) throw new Error('Not Interested list slug not configured');

        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post(`/users/me/lists/${slug}/items`, { [traktType]: [item] });

        if (result.ok) {
            this._notInterestedIds.add(itemId);
            // Optimistic: add to local data immediately
            const alreadyExists = this._notInterestedItemsData.some((w) => w.id === itemId);
            if (!alreadyExists) {
                this._notInterestedItemsData = [...this._notInterestedItemsData, {
                    id: itemId, imdbId: imdb || null, tmdbId: tmdb ? parseInt(tmdb, 10) : null,
                    name: itemName || '', type: type === 'series' ? 'series' : 'movie',
                    year: null, listedAt: new Date().toISOString(),
                }];
            }
            this._rebuildDismissed();
            this._notify();
            // Delayed refresh to sync with Trakt
            this._scheduleRefresh('notInterested');
        }
        return result;
    }

    async removeFromNotInterested(itemId, type) {
        const slug = this.getNotInterestedListSlug();
        if (!slug) throw new Error('Not Interested list slug not configured');

        const { imdb, tmdb } = this._parseId(itemId);
        const item = {};
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        // Optimistic: update local state BEFORE the API call
        // Remove all ID variants (imdb, tmdb:N) since items may be stored under either
        this._notInterestedIds.delete(itemId);
        if (imdb) this._notInterestedIds.delete(imdb);
        if (tmdb) this._notInterestedIds.delete(`tmdb:${tmdb}`);
        this._notInterestedItemsData = this._notInterestedItemsData.filter((w) =>
            w.id !== itemId &&
            (!imdb || (w.id !== imdb && w.imdbId !== imdb)) &&
            (!tmdb || (w.id !== `tmdb:${tmdb}` && w.tmdbId !== parseInt(tmdb, 10)))
        );
        this._rebuildDismissed();
        this._notify();

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post(`/users/me/lists/${slug}/items/remove`, { [traktType]: [item] });

        if (!result.ok) {
            this._notInterestedIds.add(itemId);
            this._rebuildDismissed();
            this._notify();
        }
        return result;
    }

    // Debounced delayed refresh — waits 1.5s for Trakt to propagate before re-fetching.
    // On failure, retries once after 5s. If both attempts fail, forces the next syncAll()
    // to bypass its 5-min cooldown so the data is corrected at the earliest opportunity.
    _scheduleRefresh(listType) {
        const timerKey = `_refreshTimer_${listType}`;
        clearTimeout(this[timerKey]);
        this[timerKey] = setTimeout(() => {
            this._executeRefresh(listType).catch(() => {
                // First attempt failed — retry once after 5s
                const retryKey = `_refreshRetry_${listType}`;
                clearTimeout(this[retryKey]);
                this[retryKey] = setTimeout(() => {
                    this._executeRefresh(listType).catch(() => {
                        // Both attempts failed — force next syncAll to bypass cooldown
                        this._lastSync = 0;
                        console.warn(`TraktBridge: Refresh for "${listType}" failed after retry, next syncAll will force.`);
                    });
                }, 5000);
            });
        }, 1500);
    }

    async _executeRefresh(listType) {
        if (listType === 'watchlist') await this._refreshWatchlistData();
        else if (listType === 'notInterested') await this._refreshNotInterestedData();
        else if (listType === 'watched') await this._refreshWatchedData();
    }

    // ─── Mark as watched ───
    async markWatched(itemId, type, itemName) {
        const { imdb, tmdb } = this._parseId(itemId);
        const now = new Date().toISOString();
        const item = { watched_at: now };
        if (imdb) item.ids = { imdb };
        else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
        else throw new Error('Invalid item ID');

        // Optimistic: add to _watchedItemsData BEFORE the API call so the item
        // appears in Watched (Not Rated) immediately, even if the user skips rating
        // before the API returns.
        // Don't add to _watchedIds — that triggers _rebuildDismissed which would
        // filter the item from discovery rows and unmount the rating overlay.
        const pendingItem = {
            id: itemId,
            imdbId: imdb || null,
            tmdbId: tmdb ? parseInt(tmdb, 10) : null,
            name: itemName || '',
            type: type === 'series' ? 'series' : 'movie',
            year: null,
            watchedAt: now,
        };

        const alreadyExists = this._watchedItemsData.some((w) => w.id === itemId);
        if (!alreadyExists) {
            this._watchedItemsData.unshift(pendingItem);
        }
        // Track as pending so refreshes don't wipe it before API confirms
        this._pendingWatchedItems.set(itemId, pendingItem);
        this._notify();

        const traktType = type === 'series' ? 'shows' : 'movies';
        const result = await this._post('/sync/history', { [traktType]: [item] });

        if (result.ok) {
            // Delayed refresh to sync full watched data (including movies) from Trakt.
            // Pending item stays until the refresh confirms it from the API.
            this._scheduleRefresh('watched');
        } else {
            // Rollback: remove the optimistically-added item so it doesn't linger in
            // Watched (Not Rated) when the API didn't actually persist it
            this._pendingWatchedItems.delete(itemId);
            this._watchedItemsData = this._watchedItemsData.filter((w) => w.id !== itemId);
            this._notify();
        }
        return result;
    }

    // ─── Sync all data from Trakt ───
    async syncAll(force = false) {
        if (!this.isConnected()) return;
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
            // Ensure the Not Interested list exists (auto-create if needed)
            await this._ensureNotInterestedList();

            const notInterestedSlug = this.getNotInterestedListSlug();
            // Use /sync/history (real-time) for watched items data, and /sync/watched
            // (cached aggregate) for dismissed IDs. The history endpoint reflects new
            // markWatched calls immediately, while /sync/watched can lag behind.
            const [ratingsMovies, ratingsShows, watchedMovies, watchedShows, historyMovies, historyShows, watchlistMovies, watchlistShows, notInterestedItems] = await Promise.all([
                this._fetch('/sync/ratings/movies').catch(() => []),
                this._fetch('/sync/ratings/shows').catch(() => []),
                this._fetch('/sync/watched/movies').catch(() => []),
                this._fetch('/sync/watched/shows').catch(() => []),
                this._fetch('/sync/history/movies?limit=500').catch(() => []),
                this._fetch('/sync/history/shows?limit=500').catch(() => []),
                this._fetch('/sync/watchlist/movies').catch(() => []),
                this._fetch('/sync/watchlist/shows').catch(() => []),
                notInterestedSlug
                    ? this._fetch(`/users/me/lists/${notInterestedSlug}/items`).catch(() => [])
                    : Promise.resolve([]),
            ]);

            // Build rated IDs
            const newRated = new Set();
            const ratedImdb = new Set();
            const ratedTmdb = new Set();
            (Array.isArray(ratingsMovies) ? ratingsMovies : []).forEach((r) => {
                if (r.movie?.ids?.imdb) { newRated.add(r.movie.ids.imdb); ratedImdb.add(r.movie.ids.imdb); }
                if (r.movie?.ids?.tmdb) { newRated.add(`tmdb:${r.movie.ids.tmdb}`); ratedTmdb.add(r.movie.ids.tmdb); }
            });
            (Array.isArray(ratingsShows) ? ratingsShows : []).forEach((r) => {
                if (r.show?.ids?.imdb) { newRated.add(r.show.ids.imdb); ratedImdb.add(r.show.ids.imdb); }
                if (r.show?.ids?.tmdb) { newRated.add(`tmdb:${r.show.ids.tmdb}`); ratedTmdb.add(r.show.ids.tmdb); }
            });
            this._ratedIds = newRated;
            this._ratedImdbIds = ratedImdb;
            this._ratedTmdbIds = ratedTmdb;

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

            // Build watchlist IDs + full item data
            const newWatchlist = new Set();
            const watchlistItems = [];
            const watchlistSeen = new Set();
            (Array.isArray(watchlistMovies) ? watchlistMovies : []).forEach((w) => {
                const imdbId = w.movie?.ids?.imdb;
                const tmdbId = w.movie?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newWatchlist.add(imdbId);
                if (tmdbId) newWatchlist.add(`tmdb:${tmdbId}`);
                if (id && !watchlistSeen.has(id)) {
                    watchlistSeen.add(id);
                    watchlistItems.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: w.movie?.title || '', type: 'movie',
                        year: w.movie?.year || null,
                        listedAt: w.listed_at || null,
                    });
                }
            });
            (Array.isArray(watchlistShows) ? watchlistShows : []).forEach((w) => {
                const imdbId = w.show?.ids?.imdb;
                const tmdbId = w.show?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newWatchlist.add(imdbId);
                if (tmdbId) newWatchlist.add(`tmdb:${tmdbId}`);
                if (id && !watchlistSeen.has(id)) {
                    watchlistSeen.add(id);
                    watchlistItems.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: w.show?.title || '', type: 'series',
                        year: w.show?.year || null,
                        listedAt: w.listed_at || null,
                    });
                }
            });
            watchlistItems.sort((a, b) => {
                if (!a.listedAt && !b.listedAt) return 0;
                if (!a.listedAt) return 1;
                if (!b.listedAt) return -1;
                return new Date(b.listedAt) - new Date(a.listedAt);
            });
            this._watchlistIds = newWatchlist;
            this._watchlistItemsData = watchlistItems;

            // Build not-interested IDs + full item data
            const newNotInterested = new Set();
            const niItems = [];
            const niSeen = new Set();
            (Array.isArray(notInterestedItems) ? notInterestedItems : []).forEach((item) => {
                const obj = item.movie || item.show;
                const imdbId = obj?.ids?.imdb;
                const tmdbId = obj?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newNotInterested.add(imdbId);
                if (tmdbId) newNotInterested.add(`tmdb:${tmdbId}`);
                if (id && !niSeen.has(id)) {
                    niSeen.add(id);
                    niItems.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: obj?.title || obj?.name || '', type: item.show ? 'series' : 'movie',
                        year: obj?.year || null,
                        listedAt: item.listed_at || null,
                    });
                }
            });
            // Sort: most recently added first
            niItems.sort((a, b) => {
                if (!a.listedAt && !b.listedAt) return 0;
                if (!a.listedAt) return 1;
                if (!b.listedAt) return -1;
                return new Date(b.listedAt) - new Date(a.listedAt);
            });
            this._notInterestedIds = newNotInterested;
            this._notInterestedItemsData = niItems;

            // Build full watched items data from /sync/history (real-time).
            // History returns individual events; deduplicate by ID, keeping most recent.
            const watchedItems = [];
            const seenIds = new Set();
            (Array.isArray(historyMovies) ? historyMovies : []).forEach((h) => {
                const imdbId = h.movie?.ids?.imdb;
                const tmdbId = h.movie?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (!id || seenIds.has(id)) return;
                seenIds.add(id);
                watchedItems.push({
                    id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                    name: h.movie?.title || '', type: 'movie',
                    year: h.movie?.year || null,
                    watchedAt: h.watched_at || null,
                });
            });
            (Array.isArray(historyShows) ? historyShows : []).forEach((h) => {
                const imdbId = h.show?.ids?.imdb;
                const tmdbId = h.show?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (!id || seenIds.has(id)) return;
                seenIds.add(id);
                watchedItems.push({
                    id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                    name: h.show?.title || '', type: 'series',
                    year: h.show?.year || null,
                    watchedAt: h.watched_at || null,
                });
            });
            watchedItems.sort((a, b) => {
                if (!a.watchedAt && !b.watchedAt) return 0;
                if (!a.watchedAt) return 1;
                if (!b.watchedAt) return -1;
                return new Date(b.watchedAt) - new Date(a.watchedAt);
            });

            // Merge pending items that the API hasn't returned yet
            for (const [pendingId, pendingItem] of this._pendingWatchedItems) {
                if (seenIds.has(pendingId)) {
                    this._pendingWatchedItems.delete(pendingId);
                } else {
                    watchedItems.unshift(pendingItem);
                }
            }

            this._watchedItemsData = watchedItems;

            this._rebuildDismissed();
            this._lastSync = Date.now();
            this._writeSyncSnapshot();
            this._notify();
        } catch (err) {
            console.warn('TraktBridge sync failed:', err.message);
        }
    }

    // Ensure the "Not Interested List" exists on Trakt; auto-create if missing.
    async _ensureNotInterestedList() {
        // Always list the user's lists first so we can pick the best match —
        // a previously-cached slug may point at a stale auto-created list
        // when a better-named one exists on the account.
        try {
            const lists = await this._fetch('/users/me/lists');
            if (Array.isArray(lists)) {
                const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                const isNiName = (s) => /not\s*interested/.test(normalize(s));
                // Priority order:
                //  1. Canonical slug 'not-interested-list'  (user's curated list)
                //  2. Exact name 'Not Interested List'
                //  3. Any list whose name/slug contains 'not interested'
                //  4. Any list whose name contains 'dismiss'
                const canonical = lists.find((l) => l.ids?.slug === 'not-interested-list');
                const exactName = lists.find((l) => l.name === 'Not Interested List');
                const fuzzy = lists.find((l) => isNiName(l.name) || isNiName(l.ids?.slug));
                const dismissed = lists.find((l) => /dismiss/.test(normalize(l.name)));
                const match = canonical || exactName || fuzzy || dismissed;
                if (match && match.ids?.slug) {
                    this.setNotInterestedListSlug(match.ids.slug);
                    return;
                }
            }
        } catch {
            // /users/me/lists failed (rate-limited, offline). Fall back to the
            // previously cached slug if we have one.
            const existingSlug = this.getNotInterestedListSlug();
            if (existingSlug) {
                try {
                    await this._fetch(`/users/me/lists/${existingSlug}`);
                    return; // cached slug still resolves
                } catch { /* fall through to create */ }
            }
        }

        // Create the list
        try {
            const result = await this._post('/users/me/lists', {
                name: 'Not Interested List',
                description: 'Items dismissed from Stremio recommendations',
                privacy: 'private',
                display_numbers: false,
                allow_comments: false,
            });
            if (result.ok && result.data?.ids?.slug) {
                this.setNotInterestedListSlug(result.data.ids.slug);
                console.log('TraktBridge: Created "Not Interested List" on Trakt:', result.data.ids.slug);
            } else {
                console.warn('TraktBridge: Failed to create Not Interested List:', result.status, result.data);
            }
        } catch (err) {
            console.warn('TraktBridge: Error creating Not Interested List:', err.message);
        }
    }

    // Re-fetch watchlist items from Trakt API and update internal state
    async _refreshWatchlistData() {
        try {
            const [movies, shows] = await Promise.all([
                this._fetch('/sync/watchlist/movies').catch(() => []),
                this._fetch('/sync/watchlist/shows').catch(() => []),
            ]);
            const newIds = new Set();
            const items = [];
            const seen = new Set();
            (Array.isArray(movies) ? movies : []).forEach((w) => {
                const imdbId = w.movie?.ids?.imdb;
                const tmdbId = w.movie?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newIds.add(imdbId);
                if (tmdbId) newIds.add(`tmdb:${tmdbId}`);
                if (id && !seen.has(id)) {
                    seen.add(id);
                    items.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: w.movie?.title || '', type: 'movie',
                        year: w.movie?.year || null, listedAt: w.listed_at || null,
                    });
                }
            });
            (Array.isArray(shows) ? shows : []).forEach((w) => {
                const imdbId = w.show?.ids?.imdb;
                const tmdbId = w.show?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newIds.add(imdbId);
                if (tmdbId) newIds.add(`tmdb:${tmdbId}`);
                if (id && !seen.has(id)) {
                    seen.add(id);
                    items.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: w.show?.title || '', type: 'series',
                        year: w.show?.year || null, listedAt: w.listed_at || null,
                    });
                }
            });
            items.sort((a, b) => {
                if (!a.listedAt && !b.listedAt) return 0;
                if (!a.listedAt) return 1;
                if (!b.listedAt) return -1;
                return new Date(b.listedAt) - new Date(a.listedAt);
            });
            this._watchlistIds = newIds;
            this._watchlistItemsData = items;
            this._rebuildDismissed();
            this._writeSyncSnapshot();
            this._notify();
        } catch (err) {
            console.warn('TraktBridge: Failed to refresh watchlist:', err.message);
            throw err;
        }
    }

    // Re-fetch not-interested list items from Trakt API and update internal state
    async _refreshNotInterestedData() {
        try {
            const slug = this.getNotInterestedListSlug();
            if (!slug) return;
            const listItems = await this._fetch(`/users/me/lists/${slug}/items`).catch(() => []);
            const newIds = new Set();
            const items = [];
            const seen = new Set();
            (Array.isArray(listItems) ? listItems : []).forEach((item) => {
                const obj = item.movie || item.show;
                const imdbId = obj?.ids?.imdb;
                const tmdbId = obj?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (imdbId) newIds.add(imdbId);
                if (tmdbId) newIds.add(`tmdb:${tmdbId}`);
                if (id && !seen.has(id)) {
                    seen.add(id);
                    items.push({
                        id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                        name: obj?.title || obj?.name || '', type: item.show ? 'series' : 'movie',
                        year: obj?.year || null, listedAt: item.listed_at || null,
                    });
                }
            });
            // Sort: most recently added first
            items.sort((a, b) => {
                if (!a.listedAt && !b.listedAt) return 0;
                if (!a.listedAt) return 1;
                if (!b.listedAt) return -1;
                return new Date(b.listedAt) - new Date(a.listedAt);
            });
            this._notInterestedIds = newIds;
            this._notInterestedItemsData = items;
            this._rebuildDismissed();
            this._writeSyncSnapshot();
            this._notify();
        } catch (err) {
            console.warn('TraktBridge: Failed to refresh not-interested list:', err.message);
            throw err;
        }
    }

    async _refreshWatchedData() {
        try {
            // Use /sync/history (real-time) for watched items data.
            const [historyMovies, historyShows, ratingsMovies, ratingsShows] = await Promise.all([
                this._fetch('/sync/history/movies?limit=500').catch(() => []),
                this._fetch('/sync/history/shows?limit=500').catch(() => []),
                this._fetch('/sync/ratings/movies').catch(() => []),
                this._fetch('/sync/ratings/shows').catch(() => []),
            ]);

            // Rebuild rated IDs
            const newRated = new Set();
            const ratedImdb = new Set();
            const ratedTmdb = new Set();
            (Array.isArray(ratingsMovies) ? ratingsMovies : []).forEach((r) => {
                if (r.movie?.ids?.imdb) { newRated.add(r.movie.ids.imdb); ratedImdb.add(r.movie.ids.imdb); }
                if (r.movie?.ids?.tmdb) { newRated.add(`tmdb:${r.movie.ids.tmdb}`); ratedTmdb.add(r.movie.ids.tmdb); }
            });
            (Array.isArray(ratingsShows) ? ratingsShows : []).forEach((r) => {
                if (r.show?.ids?.imdb) { newRated.add(r.show.ids.imdb); ratedImdb.add(r.show.ids.imdb); }
                if (r.show?.ids?.tmdb) { newRated.add(`tmdb:${r.show.ids.tmdb}`); ratedTmdb.add(r.show.ids.tmdb); }
            });
            this._ratedIds = newRated;
            this._ratedImdbIds = ratedImdb;
            this._ratedTmdbIds = ratedTmdb;

            // Rebuild watched items from history (deduplicated, most recent first)
            const watchedItems = [];
            const seenIds = new Set();
            (Array.isArray(historyMovies) ? historyMovies : []).forEach((h) => {
                const imdbId = h.movie?.ids?.imdb;
                const tmdbId = h.movie?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (!id || seenIds.has(id)) return;
                seenIds.add(id);
                watchedItems.push({
                    id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                    name: h.movie?.title || '', type: 'movie',
                    year: h.movie?.year || null,
                    watchedAt: h.watched_at || null,
                });
            });
            (Array.isArray(historyShows) ? historyShows : []).forEach((h) => {
                const imdbId = h.show?.ids?.imdb;
                const tmdbId = h.show?.ids?.tmdb;
                const id = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null);
                if (!id || seenIds.has(id)) return;
                seenIds.add(id);
                watchedItems.push({
                    id, imdbId: imdbId || null, tmdbId: tmdbId || null,
                    name: h.show?.title || '', type: 'series',
                    year: h.show?.year || null,
                    watchedAt: h.watched_at || null,
                });
            });
            watchedItems.sort((a, b) => {
                if (!a.watchedAt && !b.watchedAt) return 0;
                if (!a.watchedAt) return 1;
                if (!b.watchedAt) return -1;
                return new Date(b.watchedAt) - new Date(a.watchedAt);
            });

            // Merge pending items not yet in API
            for (const [pendingId, pendingItem] of this._pendingWatchedItems) {
                if (seenIds.has(pendingId)) {
                    this._pendingWatchedItems.delete(pendingId);
                } else {
                    watchedItems.unshift(pendingItem);
                }
            }

            this._watchedItemsData = watchedItems;
            this._rebuildDismissed();
            this._writeSyncSnapshot();
            this._notify();
        } catch (err) {
            console.warn('TraktBridge: Failed to refresh watched data:', err.message);
            throw err;
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

    getDismissedIds() { return this._allDismissedIds; }
    isItemDismissed(itemId) { return this._allDismissedIds.has(itemId); }

    // Explicitly dismiss a watched item (called after rating overlay is done).
    // markWatched intentionally skips _watchedIds to keep the item visible for rating.
    dismissWatched(itemId) {
        this._watchedIds.add(itemId);
        this._rebuildDismissed();
        this._notify();
    }

    async getLists() {
        try { return await this._fetch('/users/me/lists'); }
        catch { return []; }
    }

    _parseId(itemId) {
        if (!itemId) return {};
        const tmdbMatch = itemId.match(/^tmdb:(\d+)$/);
        if (tmdbMatch) return { tmdb: tmdbMatch[1] };
        if (itemId.startsWith('tt')) return { imdb: itemId };
        return {};
    }

}

const traktBridge = new TraktBridge();

// Expose on window for runtime debugging (safe — read/write access to an
// instance the user already controls via Settings).
if (typeof window !== 'undefined') {
    window.traktBridge = traktBridge;
}

module.exports = traktBridge;
