const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

// Two-tier SWR cache: fresh (<3h) render-and-done; stale (3h-30d) render
// immediately then refresh in the background, MERGING new items into the
// stored set rather than replacing. Persisted to localStorage so a browser
// restart still paints cached searches instantly. LRU-capped to 50 queries.
//
// Cache is AGGREGATIVE — each refresh adds previously-unseen items (capped
// at MAX_PER_QUERY) so the user builds up a growing set of releases over
// time even as the upstream cycles old ones out.
const FRESH_TTL_MS = 3 * 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const MAX_PER_QUERY = 500;
const LS_KEY = 'incognito_search_cache_v2';

// One-shot fetch: the hybrid backend returns the full merged result set
// (~200 items) in a SINGLE response, so there is no network pagination.
// The grid reveals these REVEAL_STEP at a time as the user scrolls —
// purely client-side, which removes the old skip-based dedup/exhaustion
// bugs entirely.
const FETCH_LIMIT = 200;
const REVEAL_STEP = 60;

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

// One-shot search fetch. The addon returns the full merged result set in a
// single response (`limit` is the only param — no `skip`).
async function fetchAll({ addonUrl, query, signal }) {
    const encoded = encodeURIComponent(query);
    const url = `${addonUrl}/catalog/other/adult-search/search=${encoded}&limit=${FETCH_LIMIT}.json`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.metas) ? dedupeById(data.metas) : [];
}

// Merge a fresh fetch into cached metas. Fresh items take precedence (they
// may carry updated seeders/quality); cached-only items are kept appended
// so the user still sees previously-discovered releases. Capped at
// MAX_PER_QUERY so a year of refreshes doesn't blow the localStorage quota.
function mergeWithCache(existing, fresh, maxSize = MAX_PER_QUERY) {
    if (!Array.isArray(existing) || existing.length === 0) {
        return Array.isArray(fresh) ? fresh.slice(0, maxSize) : [];
    }
    if (!Array.isArray(fresh) || fresh.length === 0) {
        return existing.slice(0, maxSize);
    }
    const freshIds = new Set();
    for (const m of fresh) if (m && m.id) freshIds.add(m.id);
    const merged = [...fresh];
    for (const m of existing) {
        if (m && m.id && !freshIds.has(m.id)) merged.push(m);
    }
    return merged.slice(0, maxSize);
}

/**
 * URL-driven search hook. `query` comes from the route
 * (#/incognito/search/<urlencoded>).
 *
 * Returns `{ results, loading, loadingMore, stale, refreshFailed, hasMore,
 * loadMore, query }`. The full result set is fetched once; `results` is the
 * revealed slice the grid renders, grown REVEAL_STEP at a time by `loadMore`
 * (a pure client-side operation — no network).
 */
const useIncognitoSearch = (query) => {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    const addonUrl = getAddonUrl();
    const cacheKey = trimmed ? `${addonUrl}|${trimmed}` : '';

    // Seed synchronously so cached hits paint on first render.
    const initial = React.useMemo(() => {
        if (!cacheKey) return { all: [], loading: false, stale: false };
        const entry = readCacheEntry(cacheKey);
        const cls = classifyEntry(entry);
        if (cls === 'fresh') return { all: entry.metas, loading: false, stale: false };
        if (cls === 'stale') return { all: entry.metas, loading: false, stale: true };
        return { all: [], loading: true, stale: false };
    }, [cacheKey]);

    const [all, setAll] = React.useState(initial.all);
    const [revealed, setRevealed] = React.useState(() => Math.min(initial.all.length, REVEAL_STEP));
    const [loading, setLoading] = React.useState(initial.loading);
    const [stale, setStale] = React.useState(initial.stale);
    const [refreshFailed, setRefreshFailed] = React.useState(false);

    // Ref so the stable loadMore callback can read the latest full length.
    const allRef = React.useRef(initial.all);
    React.useEffect(() => { allRef.current = all; }, [all]);

    React.useEffect(() => {
        if (!trimmed || !addonUrl) {
            setAll([]); setRevealed(0); setLoading(false); setStale(false); setRefreshFailed(false);
            return undefined;
        }

        const entry = readCacheEntry(cacheKey);
        const cls = classifyEntry(entry);
        const controller = new AbortController();

        // Fresh cache — no network.
        if (cls === 'fresh') {
            setAll(entry.metas);
            setRevealed(Math.min(entry.metas.length, REVEAL_STEP));
            setLoading(false); setStale(false); setRefreshFailed(false);
            return undefined;
        }

        // Stale — paint immediately, refresh + merge in the background.
        if (cls === 'stale') {
            setAll(entry.metas);
            setRevealed(Math.min(entry.metas.length, REVEAL_STEP));
            setLoading(false); setStale(true); setRefreshFailed(false);
            fetchAll({ addonUrl, query: trimmed, signal: controller.signal })
                .then((metas) => {
                    const merged = mergeWithCache(entry.metas, metas);
                    writeCacheEntry(cacheKey, merged);
                    setAll(merged);
                    setStale(false);
                })
                .catch((err) => {
                    if (err.name === 'AbortError') return;
                    // Surface the failure instead of leaving "refreshing…"
                    // stuck forever — the stale data stays usable.
                    console.warn('[incognito-search] stale refresh failed:', err);
                    setStale(false);
                    setRefreshFailed(true);
                });
            return () => controller.abort();
        }

        // Cold miss — spinner, then one fetch.
        setLoading(true); setAll([]); setRevealed(0); setStale(false); setRefreshFailed(false);
        fetchAll({ addonUrl, query: trimmed, signal: controller.signal })
            .then((metas) => {
                writeCacheEntry(cacheKey, metas);
                setAll(metas);
                setRevealed(Math.min(metas.length, REVEAL_STEP));
                setLoading(false);
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                console.error('Incognito search error:', err);
                setAll([]); setRevealed(0); setLoading(false);
            });

        return () => controller.abort();
    }, [trimmed, addonUrl, cacheKey]);

    // Reveal the next chunk — purely client-side, instant, no network.
    const loadMore = React.useCallback(() => {
        setRevealed((r) => Math.min(r + REVEAL_STEP, allRef.current.length));
    }, []);

    const results = React.useMemo(() => all.slice(0, revealed), [all, revealed]);
    const hasMore = revealed < all.length;

    return {
        results,
        loading,
        loadingMore: false,
        stale,
        refreshFailed,
        hasMore,
        loadMore,
        query: query || '',
    };
};

function clearSearchCache() {
    _searchCache.clear();
    try { localStorage.removeItem(LS_KEY); } catch (_e) { /* ignore */ }
}

module.exports = useIncognitoSearch;
module.exports.clearSearchCache = clearSearchCache;
