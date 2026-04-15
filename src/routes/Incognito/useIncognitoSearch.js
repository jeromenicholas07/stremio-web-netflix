const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

function getAddonUrl() {
    const stored = localStorage.getItem(ADDON_URL_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    return DEFAULT_ADDON_URL;
}

/**
 * Handles search directly via the incognito addon HTTP endpoint,
 * bypassing stremio-core to maintain isolation.
 */
const useIncognitoSearch = () => {
    const [results, setResults] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [query, setQuery] = React.useState('');

    const search = React.useCallback(async (searchQuery) => {
        setQuery(searchQuery);

        if (!searchQuery || searchQuery.trim().length === 0) {
            setResults([]);
            return;
        }

        const addonUrl = getAddonUrl();
        if (!addonUrl) {
            setResults([]);
            return;
        }

        setLoading(true);
        try {
            const encoded = encodeURIComponent(searchQuery.trim());
            const res = await fetch(`${addonUrl}/catalog/other/adult-search/search=${encoded}.json`);
            if (!res.ok) throw new Error('Search failed');
            const data = await res.json();
            setResults(data.metas || []);
        } catch (err) {
            console.error('Incognito search error:', err);
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);

    return { results, loading, query, search };
};

module.exports = useIncognitoSearch;
