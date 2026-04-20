const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

// 3-hour in-memory cache for built-in catalogs. The addon also caches
// internally, but a) navigating away and back still goes through the
// addon (localhost HTTP is fast but every request re-fetches the manifest
// and triggers N catalog requests), and b) users flip between tabs often
// enough that paying the "all catalogs in parallel" waterfall even once
// every 15 min is noticeable. Keyed by addonUrl so switching addons busts.
const CATALOG_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const _catalogsCache = new Map(); // addonUrl -> { ts, catalogs }

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
    // Seed state from cache synchronously so first paint is instant when warm.
    const cachedOnMount = React.useMemo(() => {
        const url = getAddonUrl();
        if (!url) return null;
        const entry = _catalogsCache.get(url);
        if (entry && Date.now() - entry.ts < CATALOG_CACHE_TTL_MS) return entry.catalogs;
        return null;
    }, []);

    const [catalogs, setCatalogs] = React.useState(cachedOnMount || []);
    const [loading, setLoading] = React.useState(!cachedOnMount);
    const addonUrl = getAddonUrl();

    const fetchCatalogs = React.useCallback(async ({ force = false } = {}) => {
        if (!addonUrl) {
            setCatalogs([]);
            return;
        }

        if (!force) {
            const entry = _catalogsCache.get(addonUrl);
            if (entry && Date.now() - entry.ts < CATALOG_CACHE_TTL_MS) {
                setCatalogs(entry.catalogs);
                setLoading(false);
                return;
            }
        }

        setLoading(true);
        try {
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

            const catalogsOut = results.filter(Boolean);
            _catalogsCache.set(addonUrl, { ts: Date.now(), catalogs: catalogsOut });
            setCatalogs(catalogsOut);
        } catch (err) {
            console.error('Failed to fetch incognito catalogs:', err);
            setCatalogs([]);
        } finally {
            setLoading(false);
        }
    }, [addonUrl]);

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

    return { catalogs, loading, fetchCatalogWithGenre, loadNextPage, addonUrl };
};

function clearCatalogsCache() {
    _catalogsCache.clear();
}

module.exports = useIncognitoCatalogs;
module.exports.clearCatalogsCache = clearCatalogsCache;
