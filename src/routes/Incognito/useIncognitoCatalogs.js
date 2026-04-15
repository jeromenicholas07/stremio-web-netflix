const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

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
    const [catalogs, setCatalogs] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const addonUrl = getAddonUrl();

    const fetchCatalogs = React.useCallback(async () => {
        if (!addonUrl) {
            setCatalogs([]);
            return;
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

            setCatalogs(results.filter(Boolean));
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

module.exports = useIncognitoCatalogs;
