// Fetches meta + streams directly from the incognito addon HTTP endpoint.
// Intentionally bypasses stremio-core (the addon is NOT installed in core —
// we keep it that way to preserve Library / Continue Watching / Addons-page isolation).

const React = require('react');

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';
// 3h: matches the catalog/search caches. Stream metadata for a given
// torrent doesn't meaningfully change on shorter windows (seeders drift
// slowly, and the infoHash/magnet is immutable), so re-fetching every
// 5 min just makes the details page feel sluggish when re-opened.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;

const _cache = new Map(); // id -> { value: { meta, streams }, ts }

function getAddonUrl() {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ADDON_URL_KEY) : null;
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    return DEFAULT_ADDON_URL;
}

async function fetchDetails(addonUrl, id, signal) {
    const type = 'other';
    const [metaRes, streamRes] = await Promise.all([
        fetch(`${addonUrl}/meta/${type}/${encodeURIComponent(id)}.json`, { signal }),
        fetch(`${addonUrl}/stream/${type}/${encodeURIComponent(id)}.json`, { signal })
    ]);
    const meta = metaRes.ok ? ((await metaRes.json()).meta || null) : null;
    const streams = streamRes.ok ? ((await streamRes.json()).streams || []) : [];
    return { meta, streams };
}

const useIncognitoDetails = (id) => {
    const [state, setState] = React.useState({ meta: null, streams: [], loading: !!id, error: null });

    React.useEffect(() => {
        if (!id) {
            setState({ meta: null, streams: [], loading: false, error: null });
            return undefined;
        }

        const cached = _cache.get(id);
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
            setState({ meta: cached.value.meta, streams: cached.value.streams, loading: false, error: null });
            return undefined;
        }

        const addonUrl = getAddonUrl();
        const controller = new AbortController();
        setState((prev) => ({ ...prev, loading: true, error: null }));

        fetchDetails(addonUrl, id, controller.signal)
            .then((value) => {
                _cache.set(id, { value, ts: Date.now() });
                setState({ meta: value.meta, streams: value.streams, loading: false, error: null });
            })
            .catch((err) => {
                if (err.name === 'AbortError') return;
                console.error('Failed to fetch incognito details:', err);
                setState({ meta: null, streams: [], loading: false, error: err.message || String(err) });
            });

        return () => controller.abort();
    }, [id]);

    return state;
};

function clearDetailsCache() {
    _cache.clear();
}

module.exports = useIncognitoDetails;
module.exports.clearDetailsCache = clearDetailsCache;
