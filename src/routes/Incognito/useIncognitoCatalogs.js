const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

// Catalogs cache has two TTLs:
//   FRESH (3 h) — serve, do nothing else.
//   STALE (30 d) — serve immediately, kick off a background refresh, then
//                  MERGE the fresh data into the cached list. The cache is
//                  aggregative: previously-discovered metas are kept even
//                  when Prowlarr cycles them out of its top-N, so the user
//                  builds up a growing local library of releases.
// The store lives in localStorage so a cold browser start still paints
// instantly, and in an in-memory Map as a hot path so we don't re-parse
// JSON on every render.
const FRESH_TTL_MS = 3 * 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Hard cap per catalog row to avoid unbounded localStorage growth. 300 is
// comfortably more than any infinite-scroll session and keeps JSON
// serialisation under ~500 KB per addonUrl entry.
const MAX_PER_CATALOG = 300;
// v2: see useIncognitoSearch.js — drops cached metas containing stale
// `cold: true` flags from the over-eager addon cold-state era.
const LS_KEY = 'incognito_catalogs_cache_v2';
const _catalogsCache = new Map(); // addonUrl -> { ts, catalogs }

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
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch (_e) {
        // Almost always QuotaExceededError. Drop the oldest entry and retry
        // once — if that still fails, accept the in-memory cache as the
        // sole layer for this session.
        try {
            const entries = Object.entries(store);
            if (entries.length > 0) {
                entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
                const [oldestKey] = entries[0];
                delete store[oldestKey];
                localStorage.setItem(LS_KEY, JSON.stringify(store));
            }
        } catch { /* give up silently */ }
    }
}

function readCacheEntry(addonUrl) {
    // Hot path: in-memory Map first.
    const mem = _catalogsCache.get(addonUrl);
    if (mem) return mem;
    // Fall back to localStorage — seed the Map so subsequent reads stay hot.
    const store = readStore();
    const entry = store[addonUrl];
    if (entry && typeof entry.ts === 'number' && Array.isArray(entry.catalogs)) {
        _catalogsCache.set(addonUrl, entry);
        return entry;
    }
    return null;
}

function writeCacheEntry(addonUrl, catalogs) {
    const entry = { ts: Date.now(), catalogs };
    _catalogsCache.set(addonUrl, entry);
    const store = readStore();
    store[addonUrl] = entry;
    writeStore(store);
}

function classifyEntry(entry) {
    if (!entry) return 'missing';
    const age = Date.now() - entry.ts;
    if (age < FRESH_TTL_MS) return 'fresh';
    if (age < STALE_TTL_MS) return 'stale';
    return 'expired';
}

function getAddonUrl() {
    const stored = localStorage.getItem(ADDON_URL_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    // Fall back to the bundled addon shipped with StremioLauncherFULL
    return DEFAULT_ADDON_URL;
}

// Merge a freshly-fetched catalog list into the cached catalogs. Same
// catalog IDs are merged at the meta level: fresh metas come first
// (newer data wins), cached-only metas are appended so the user keeps
// access to releases that aged out of Prowlarr's current top-N.
function mergeCatalogs(cached, fresh, maxPerCatalog = MAX_PER_CATALOG) {
    if (!Array.isArray(cached) || cached.length === 0) return Array.isArray(fresh) ? fresh : [];
    if (!Array.isArray(fresh) || fresh.length === 0) return cached;

    // Build a quick lookup of cached metas by catalog ID.
    const cachedById = new Map();
    for (const cat of cached) {
        if (cat && cat.id) cachedById.set(cat.id, cat);
    }

    return fresh.map((cat) => {
        if (!cat || !cat.id) return cat;
        const old = cachedById.get(cat.id);
        if (!old || old.content?.type !== 'Ready' || cat.content?.type !== 'Ready') return cat;
        const oldMetas = Array.isArray(old.content.content) ? old.content.content : [];
        const newMetas = Array.isArray(cat.content.content) ? cat.content.content : [];
        const seen = new Set();
        const merged = [];
        for (const m of newMetas) {
            if (m && m.id && !seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
        for (const m of oldMetas) {
            if (m && m.id && !seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
        return { ...cat, content: { type: 'Ready', content: merged.slice(0, maxPerCatalog) } };
    });
}

/**
 * Fetches catalogs directly from the incognito addon HTTP endpoint,
 * bypassing stremio-core to maintain isolation.
 */
const useIncognitoCatalogs = () => {
    const addonUrl = getAddonUrl();

    // Seed state from cache synchronously so first paint is instant on
    // fresh AND stale hits. Only on genuine miss do we block on a spinner.
    const initial = React.useMemo(() => {
        if (!addonUrl) return { catalogs: [], loading: false, stale: false };
        const entry = readCacheEntry(addonUrl);
        const cls = classifyEntry(entry);
        if (cls === 'fresh') return { catalogs: entry.catalogs, loading: false, stale: false };
        if (cls === 'stale') return { catalogs: entry.catalogs, loading: false, stale: true };
        return { catalogs: [], loading: true, stale: false };
    }, [addonUrl]);

    const [catalogs, setCatalogs] = React.useState(initial.catalogs);
    const [loading, setLoading] = React.useState(initial.loading);
    const [stale, setStale] = React.useState(initial.stale);

    const fetchFromNetwork = React.useCallback(async () => {
        const manifestRes = await fetch(`${addonUrl}/manifest.json`);
        if (!manifestRes.ok) throw new Error('Failed to fetch manifest');
        const manifest = await manifestRes.json();

        // Only fetch non-search catalogs for browsing
        const browseCatalogs = (manifest.catalogs || []).filter(
            cat => !cat.extra?.some(e => e.name === 'search' && e.isRequired)
        );

        const results = await Promise.all(
            browseCatalogs.map(async (cat) => {
                try {
                    const res = await fetch(`${addonUrl}/catalog/${cat.type}/${cat.id}.json`);
                    if (!res.ok) return null;
                    const data = await res.json();
                    return {
                        id: cat.id,
                        name: cat.name,
                        type: cat.type,
                        genres: cat.extra?.find(e => e.name === 'genre')?.options || [],
                        content: {
                            type: 'Ready',
                            content: data.metas || [],
                        },
                    };
                } catch {
                    return null;
                }
            })
        );
        return results.filter(Boolean);
    }, [addonUrl]);

    const fetchCatalogs = React.useCallback(async ({ force = false } = {}) => {
        if (!addonUrl) {
            setCatalogs([]);
            setLoading(false);
            setStale(false);
            return;
        }

        if (!force) {
            const entry = readCacheEntry(addonUrl);
            const cls = classifyEntry(entry);
            if (cls === 'fresh') {
                setCatalogs(entry.catalogs);
                setLoading(false);
                setStale(false);
                return;
            }
            if (cls === 'stale') {
                // Stale-while-revalidate: paint the stale data right now,
                // then silently refresh in the background. The refresh
                // MERGES new metas into the cached list rather than
                // replacing — releases that have aged out of Prowlarr's
                // current top-N stay accessible via cache.
                setCatalogs(entry.catalogs);
                setLoading(false);
                setStale(true);
                try {
                    const catalogsOut = await fetchFromNetwork();
                    const merged = mergeCatalogs(entry.catalogs, catalogsOut);
                    writeCacheEntry(addonUrl, merged);
                    setCatalogs(merged);
                    setStale(false);
                } catch (err) {
                    console.warn('[incognito] stale refresh failed, keeping cached data:', err);
                }
                return;
            }
        }

        // Cold path (miss or forced).
        setLoading(true);
        try {
            const catalogsOut = await fetchFromNetwork();
            // Even on cold path: if the in-memory Map happens to hold a
            // stale entry from this session (e.g. user just clicked Clear
            // cache), merge it back in so we don't lose accumulated
            // history.
            const memEntry = _catalogsCache.get(addonUrl);
            const merged = memEntry && Array.isArray(memEntry.catalogs)
                ? mergeCatalogs(memEntry.catalogs, catalogsOut)
                : catalogsOut;
            writeCacheEntry(addonUrl, merged);
            setCatalogs(merged);
            setStale(false);
        } catch (err) {
            console.error('Failed to fetch incognito catalogs:', err);
            setCatalogs([]);
        } finally {
            setLoading(false);
        }
    }, [addonUrl, fetchFromNetwork]);

    const fetchCatalogWithGenre = React.useCallback(async (catalogId, genre) => {
        if (!addonUrl) return;

        try {
            const extra = genre ? `/genre=${encodeURIComponent(genre)}` : '';
            const res = await fetch(`${addonUrl}/catalog/other/${catalogId}${extra}.json`);
            if (!res.ok) return;
            const data = await res.json();

            setCatalogs(prev => prev.map(cat => {
                if (cat.id === catalogId) {
                    return {
                        ...cat,
                        content: { type: 'Ready', content: data.metas || [] },
                    };
                }
                return cat;
            }));
        } catch (err) {
            console.error('Failed to fetch catalog with genre:', err);
        }
    }, [addonUrl]);

    const loadNextPage = React.useCallback(async (catalogId, currentCount) => {
        if (!addonUrl) return;

        try {
            const res = await fetch(`${addonUrl}/catalog/other/${catalogId}/skip=${currentCount}.json`);
            if (!res.ok) return;
            const data = await res.json();

            setCatalogs(prev => prev.map(cat => {
                if (cat.id === catalogId && cat.content?.type === 'Ready') {
                    return {
                        ...cat,
                        content: {
                            type: 'Ready',
                            content: [...cat.content.content, ...(data.metas || [])],
                        },
                    };
                }
                return cat;
            }));
        } catch (err) {
            console.error('Failed to load next page:', err);
        }
    }, [addonUrl]);

    React.useEffect(() => {
        fetchCatalogs();
    }, [fetchCatalogs]);

    return { catalogs, loading, stale, fetchCatalogWithGenre, loadNextPage, addonUrl };
};

function clearCatalogsCache() {
    _catalogsCache.clear();
    try { localStorage.removeItem(LS_KEY); } catch (_e) { /* ignore */ }
}

module.exports = useIncognitoCatalogs;
module.exports.clearCatalogsCache = clearCatalogsCache;
