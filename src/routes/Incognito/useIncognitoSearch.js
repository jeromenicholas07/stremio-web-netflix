const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

function getAddonUrl() {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ADDON_URL_KEY) : null;
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    return DEFAULT_ADDON_URL;
}

/**
 * URL-driven search hook. The `query` argument is the source of truth —
 * it comes from the route (#/incognito/search/<urlencoded>). When the URL
 * changes, the hook re-fetches; there is no internal query state.
 */
const useIncognitoSearch = (query) => {
    const [results, setResults] = React.useState([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        const trimmed = typeof query === 'string' ? query.trim() : '';
        if (!trimmed) {
            setResults([]);
            setLoading(false);
            return undefined;
        }

        const addonUrl = getAddonUrl();
        if (!addonUrl) {
            setResults([]);
            setLoading(false);
            return undefined;
        }

        const controller = new AbortController();
        setLoading(true);

        const encoded = encodeURIComponent(trimmed);
        fetch(`${addonUrl}/catalog/other/adult-search/search=${encoded}.json`, { signal: controller.signal })
            .then((res) => {
                if (!res.ok) throw new Error('Search failed');
                return res.json();
            })
            .then((data) => {
                setResults(data.metas || []);
                setLoading(false);
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                console.error('Incognito search error:', err);
                setResults([]);
                setLoading(false);
            });

        return () => controller.abort();
    }, [query]);

    return { results, loading, query: query || '' };
};

module.exports = useIncognitoSearch;
