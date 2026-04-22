const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

// Two-tier cache: fresh (<3h) render-and-done; stale (3h–7d) render
// immediately then refresh in the background. Persist to localStorage so
// a full browser restart still paints cached searches instantly. LRU-cap
// to 50 most-recent queries to stay well under the 5 MB origin quota.
const FRESH_TTL_MS = 3 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const LS_KEY = 'incognito_search_cache_v1';
const _searchCache = new Map();

function getAddonUrl() {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ADDON_URL_KEY) : null;
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    return DEFAULT_ADDON_URL;
}

function safeParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

function readStore() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = safeParse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch { return {}; }
}

function writeStore(store) {
    // LRU-evict by oldest `ts` until we're under MAX_ENTRIES.
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
        const sorted = keys.map(k => [k, store[k]?.ts || 0]).sort((a, b) => a[1] - b[1]);
        const toDrop = sorted.slice(0, keys.length - MAX_ENTRIES);
        for (const [k] of toDrop) delete store[k];
    }
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch (_e) {
        // QuotaExceededError — drop the oldest remaining entry and retry.
        try {
            const remaining = Object.entries(store);
            if (remaining.length > 0) {
                remaining.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
                delete store[remaining[0][0]];
                localStorage.setItem(LS_KEY, JSON.stringify(store));
            }
        } catch { /* give up silently */ }
    }
}

function readCacheEntry(key) {
    const mem = _searchCache.get(key);
    if (mem) return mem;
    const store = readStore();
    const entry = store[key];
    if (entry && typeof entry.ts === 'number' && Array.isArray(entry.metas)) {
        _searchCache.set(key, entry);
        return entry;
    }
    return null;
}

function writeCacheEntry(key, metas) {
    const entry = { ts: Date.now(), metas };
    _searchCache.set(key, entry);
    const store = readStore();
    store[key] = entry;
    writeStore(store);
}

function classifyEntry(entry) {
    if (!entry) return 'missing';
    const age = Date.now() - entry.ts;
    if (age < FRESH_TTL_MS) return 'fresh';
    if (age < STALE_TTL_MS) return 'stale';
    return 'expired';
}

/**
 * URL-driven search hook. The `query` argument is the source of truth —
 * it comes from the route (#/incognito/search/<urlencoded>).
 */
const useIncognitoSearch = (query) => {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    const addonUrl = getAddonUrl();
    const cacheKey = trimmed ? `${addonUrl}|${trimmed}` : '';

    // Seed synchronously so cached hits paint on first render.
    const initial = React.useMemo(() => {
        if (!cacheKey) return { results: [], loading: false, stale: false };
        const entry = readCacheEntry(cacheKey);
        const cls = classifyEntry(entry);
        if (cls === 'fresh') return { results: entry.metas, loading: false, stale: false };
        if (cls === 'stale') return { results: entry.metas, loading: false, stale: true };
        return { results: [], loading: true, stale: false };
    }, [cacheKey]);

    const [results, setResults] = React.useState(initial.results);
    const [loading, setLoading] = React.useState(initial.loading);
    const [stale, setStale] = React.useState(initial.stale);

    React.useEffect(() => {
        if (!trimmed) {
            setResults([]);
            setLoading(false);
            setStale(false);
            return undefined;
        }
        if (!addonUrl) {
            setResults([]);
            setLoading(false);
            setStale(false);
            return undefined;
        }

        const entry = readCacheEntry(cacheKey);
        const cls = classifyEntry(entry);

        if (cls === 'fresh') {
            setResults(entry.metas);
            setLoading(false);
            setStale(false);
            return undefined;
        }

        const controller = new AbortController();
        const doFetch = async () => {
            const encoded = encodeURIComponent(trimmed);
            const res = await fetch(
                `${addonUrl}/catalog/other/adult-search/search=${encoded}.json`,
                { signal: controller.signal }
            );
            if (!res.ok) throw new Error('Search failed');
            const data = await res.json();
            return data.metas || [];
        };

        if (cls === 'stale') {
            // Paint stale immediately, refresh in background.
            setResults(entry.metas);
            setLoading(false);
            setStale(true);
            doFetch()
                .then((metas) => {
                    writeCacheEntry(cacheKey, metas);
                    setResults(metas);
                    setStale(false);
                })
                .catch((err) => {
                    if (err.name !== 'AbortError') {
                        console.warn('[incognito-search] stale refresh failed:', err);
                    }
                });
            return () => controller.abort();
        }

        // Cold miss — show spinner.
        setLoading(true);
        doFetch()
            .then((metas) => {
                writeCacheEntry(cacheKey, metas);
                setResults(metas);
                setLoading(false);
                setStale(false);
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                console.error('Incognito search error:', err);
                setResults([]);
                setLoading(false);
            });

        return () => controller.abort();
    }, [trimmed, addonUrl, cacheKey]);

    return { results, loading, stale, query: query || '' };
};

function clearSearchCache() {
    _searchCache.clear();
    try { localStorage.removeItem(LS_KEY); } catch (_e) { /* ignore */ }
}

module.exports = useIncognitoSearch;
module.exports.clearSearchCache = clearSearchCache;
