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

// Each search pulls down a full page at a time and can keep appending more
// via `loadMore()`. PAGE_SIZE is the client-side request — addon clamps to
// 200 and Prowlarr caps at whatever the indexer yields, so we ask for 100
// and accept whatever comes back.
const PAGE_SIZE = 100;

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

async function fetchPage({ addonUrl, query, skip, signal }) {
    const encoded = encodeURIComponent(query);
    const url = `${addonUrl}/catalog/other/adult-search/search=${encoded}&skip=${skip}&limit=${PAGE_SIZE}.json`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.metas) ? data.metas : [];
}

function dedupeById(list) {
    const seen = new Set();
    const out = [];
    for (const m of list) {
        if (!m || !m.id) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

/**
 * URL-driven search hook. The `query` argument is the source of truth —
 * it comes from the route (#/incognito/search/<urlencoded>).
 *
 * Returns `{ results, loading, loadingMore, stale, hasMore, loadMore, query }`:
 * the grid renders `results` directly and calls `loadMore()` when the user
 * scrolls near the bottom. `hasMore` flips false when a page returns
 * fewer items than PAGE_SIZE (Prowlarr ran out of results for this query).
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
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [stale, setStale] = React.useState(initial.stale);
    const [hasMore, setHasMore] = React.useState(true);

    // Refs so loadMore() can read the latest state without re-creating the
    // callback on every render (IntersectionObserver keeps a stable ref).
    const resultsRef = React.useRef(initial.results);
    const hasMoreRef = React.useRef(true);
    const loadingMoreRef = React.useRef(false);
    const abortRef = React.useRef(null);

    React.useEffect(() => { resultsRef.current = results; }, [results]);
    React.useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
    React.useEffect(() => { loadingMoreRef.current = loadingMore; }, [loadingMore]);

    // First-page load (stale-while-revalidate + cache seed).
    React.useEffect(() => {
        if (!trimmed || !addonUrl) {
            setResults([]);
            setLoading(false);
            setStale(false);
            setHasMore(false);
            return undefined;
        }

        const entry = readCacheEntry(cacheKey);
        const cls = classifyEntry(entry);

        // Fresh cache — no network work, assume more pages may exist on
        // further scrolling (the cache only stores page 1).
        if (cls === 'fresh') {
            setResults(entry.metas);
            setLoading(false);
            setStale(false);
            setHasMore(entry.metas.length >= PAGE_SIZE);
            return undefined;
        }

        const controller = new AbortController();
        abortRef.current = controller;

        const doFetch = async () => fetchPage({
            addonUrl, query: trimmed, skip: 0, signal: controller.signal,
        });

        if (cls === 'stale') {
            // Paint stale immediately, refresh in background.
            setResults(entry.metas);
            setLoading(false);
            setStale(true);
            setHasMore(entry.metas.length >= PAGE_SIZE);
            doFetch()
                .then((metas) => {
                    writeCacheEntry(cacheKey, metas);
                    setResults(metas);
                    setStale(false);
                    setHasMore(metas.length >= PAGE_SIZE);
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
        setResults([]);
        setHasMore(true);
        doFetch()
            .then((metas) => {
                writeCacheEntry(cacheKey, metas);
                setResults(metas);
                setLoading(false);
                setStale(false);
                setHasMore(metas.length >= PAGE_SIZE);
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                console.error('Incognito search error:', err);
                setResults([]);
                setLoading(false);
                setHasMore(false);
            });

        return () => controller.abort();
    }, [trimmed, addonUrl, cacheKey]);

    // Append the next page of results. Safe to call repeatedly: guards on
    // `loadingMore` + `hasMore` via refs.
    const loadMore = React.useCallback(async () => {
        if (!trimmed || !addonUrl) return;
        if (loadingMoreRef.current || !hasMoreRef.current) return;
        const currentLen = resultsRef.current.length;
        if (currentLen === 0) return; // wait for first page

        loadingMoreRef.current = true;
        setLoadingMore(true);
        try {
            const next = await fetchPage({
                addonUrl, query: trimmed, skip: currentLen, signal: undefined,
            });
            if (next.length === 0) {
                setHasMore(false);
            } else {
                const merged = dedupeById([...resultsRef.current, ...next]);
                setResults(merged);
                // Prowlarr exhausted if the page came back short of PAGE_SIZE.
                setHasMore(next.length >= PAGE_SIZE);
            }
        } catch (err) {
            console.warn('[incognito-search] loadMore failed:', err);
            // Don't flip hasMore=false on transient errors — let the user
            // retry by scrolling again.
        } finally {
            loadingMoreRef.current = false;
            setLoadingMore(false);
        }
    }, [trimmed, addonUrl]);

    return { results, loading, loadingMore, stale, hasMore, loadMore, query: query || '' };
};

function clearSearchCache() {
    _searchCache.clear();
    try { localStorage.removeItem(LS_KEY); } catch (_e) { /* ignore */ }
}

module.exports = useIncognitoSearch;
module.exports.clearSearchCache = clearSearchCache;
