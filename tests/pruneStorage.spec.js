// Copyright (C) 2017-2026 Smart code 203358507

const { pruneStorage } = require('../src/common/pruneStorage');

function makeLocalStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        _map: map,
    };
}

const big = (kb) => 'x'.repeat(kb * 1024);

describe('pruneStorage', () => {
    afterEach(() => { delete global.window; });

    it('deletes superseded legacy keys and keeps active caches + core data', () => {
        const ls = makeLocalStorage({
            'incognito_catalogs_cache_v1': big(1100),
            'incognito_custom_row_cache:rowA': big(570),
            'incognito_search_cache_v1': big(150),
            'tmdb_persist_cache_v1': big(800),
            'stremio_watchlist': big(10),
            'incognito_custom_row_cache_v2:rowA': big(400),
            'trakt_response_cache_v1': big(300),
            'library_recent': big(115),
            'profile': big(12),
        });
        global.window = { localStorage: ls };

        pruneStorage();

        // Legacy keys gone.
        expect(ls.getItem('incognito_catalogs_cache_v1')).toBeNull();
        expect(ls.getItem('incognito_custom_row_cache:rowA')).toBeNull();
        expect(ls.getItem('incognito_search_cache_v1')).toBeNull();
        expect(ls.getItem('tmdb_persist_cache_v1')).toBeNull();
        expect(ls.getItem('stremio_watchlist')).toBeNull();
        // Active caches + core kept (total now well under budget).
        expect(ls.getItem('incognito_custom_row_cache_v2:rowA')).not.toBeNull();
        expect(ls.getItem('trakt_response_cache_v1')).not.toBeNull();
        expect(ls.getItem('library_recent')).not.toBeNull();
        expect(ls.getItem('profile')).not.toBeNull();
    });

    it('evicts the largest rebuildable caches (largest-first) until under budget, never core', () => {
        const ls = makeLocalStorage({
            'incognito_custom_row_cache_v2:r1': big(1500),
            'incognito_custom_row_cache_v2:r2': big(1400),
            'incognito_catalogs_cache_v2': big(900),
            'library_recent': big(300), // core — must survive
        });
        global.window = { localStorage: ls };

        pruneStorage();

        // The single largest evictable cache is dropped; the rest stay because
        // that already brings us under the 3 MB budget.
        expect(ls.getItem('incognito_custom_row_cache_v2:r1')).toBeNull();
        expect(ls.getItem('incognito_custom_row_cache_v2:r2')).not.toBeNull();
        expect(ls.getItem('incognito_catalogs_cache_v2')).not.toBeNull();
        expect(ls.getItem('library_recent')).not.toBeNull();

        let total = 0;
        for (let i = 0; i < ls.length; i++) total += ls.key(i).length + ls.getItem(ls.key(i)).length;
        expect(total).toBeLessThanOrEqual(3 * 1024 * 1024);
    });

    it('never evicts core/essential data even if it alone exceeds the budget', () => {
        const ls = makeLocalStorage({
            'library_recent': big(2000),
            'library': big(2000),
            'streaming_server_urls': big(200),
        });
        global.window = { localStorage: ls };

        pruneStorage();

        expect(ls.getItem('library_recent')).not.toBeNull();
        expect(ls.getItem('library')).not.toBeNull();
        expect(ls.getItem('streaming_server_urls')).not.toBeNull();
    });

    it('is a no-op when localStorage is unavailable', () => {
        delete global.window;
        expect(() => pruneStorage()).not.toThrow();
    });
});
