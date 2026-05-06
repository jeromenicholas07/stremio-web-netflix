// Queries the local Incognito addon's torrent-search catalog so the main
// Stremio search page gets a row of raw Prowlarr hits alongside core addon
// results. Uses plain fetch — does NOT go through stremio-core so it
// doesn't need to be an installed addon.

const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

function getAddonUrl() {
    try {
        const stored = localStorage.getItem(ADDON_URL_KEY);
        if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    } catch { /* ignore */ }
    return DEFAULT_ADDON_URL;
}

const useProwlarrSearch = (query) => {
    const [state, setState] = React.useState({ loading: false, metas: [], error: null });

    React.useEffect(() => {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            setState({ loading: false, metas: [], error: null });
            return;
        }

        const addonUrl = getAddonUrl();
        if (!addonUrl) {
            setState({ loading: false, metas: [], error: 'addon not configured' });
            return;
        }

        const ctrl = new AbortController();
        setState({ loading: true, metas: [], error: null });

        // Ask the addon for the addon's hard ceiling (200) so we get as many
        // hits as Prowlarr will give us — sorted by seeders inside the addon.
        const url = `${addonUrl}/catalog/other/torrent-search/search=${encodeURIComponent(query)}&limit=150.json`;
        fetch(url, { signal: ctrl.signal })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data) => {
                setState({ loading: false, metas: (data && data.metas) || [], error: null });
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                setState({ loading: false, metas: [], error: err.message || 'fetch failed' });
            });

        return () => ctrl.abort();
    }, [query]);

    return state;
};

module.exports = useProwlarrSearch;
