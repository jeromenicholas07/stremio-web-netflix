const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

// Catalogs cache has two TTLs:
//   FRESH (3 h) — serve, do nothing else.
//   STALE (7 d) — serve immediately, kick off a background refresh, then
//                 swap in the new data once it arrives.
// The store lives in localStorage so a cold browser start still paints
// instantly, and in an in-memory Map as a hot path so we don't re-parse
// JSON on every render.
const FRESH_TTL_MS = 3 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LS_KEY = 'incognito_catalogs_cache_v1';
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
                // then silently refresh in the background. We fall through
                // to the network fetch below but WITHOUT flipping loading
                // to true — the UI keeps rendering stale cards the whole
                // time.
                setCatalogs(entry.catalogs);
                setLoading(false);
                setStale(true);
                try {
                    const catalogsOut = await fetchFromNetwork();
                    writeCacheEntry(addonUrl, catalogsOut);
                    setCatalogs(catalogsOut);
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
            writeCacheEntry(addonUrl, catalogsOut);
            setCatalogs(catalogsOut);
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
