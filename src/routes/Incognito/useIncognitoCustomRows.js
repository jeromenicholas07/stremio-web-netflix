const React = require('react');

// User-defined catalog rows inside the Incognito tab. Each row is just a
// saved search query — we hit the addon's adult-search endpoint and treat
// the results as a MetaRow catalog. Cached for 24 h per row in
// localStorage so switching tabs / reopening the app doesn't re-hit
// Prowlarr every time (cold searches can take 15–30 s).

const ROWS_KEY = 'incognito_custom_rows';
const CACHE_PREFIX = 'incognito_custom_row_cache:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROWS_CHANGED_EVENT = 'incognito:custom-rows-changed';

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

function getAddonUrl() {
    try {
        const stored = localStorage.getItem(ADDON_URL_KEY);
        if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    } catch (_e) { /* ignore */ }
    return DEFAULT_ADDON_URL;
}

function readRows() {
    try {
        const raw = localStorage.getItem(ROWS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(r => r && typeof r.id === 'string' && typeof r.query === 'string');
    } catch (_e) {
        return [];
    }
}

function writeRows(rows) {
    try {
        localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
        // Notify same-tab listeners; storage events only fire cross-tab.
        window.dispatchEvent(new CustomEvent(ROWS_CHANGED_EVENT));
    } catch (_e) { /* quota / private mode — silently drop */ }
}

function readCache(id) {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + id);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.metas)) return null;
        if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
        return parsed.metas;
    } catch (_e) {
        return null;
    }
}

function writeCache(id, metas) {
    try {
        localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ ts: Date.now(), metas }));
    } catch (_e) { /* ignore quota */ }
}

function clearCache(id) {
    try { localStorage.removeItem(CACHE_PREFIX + id); } catch (_e) { /* ignore */ }
}

function makeId() {
    return 'row_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function fetchQuery(query, signal) {
    const addonUrl = getAddonUrl();
    const encoded = encodeURIComponent(query);
    const url = `${addonUrl}/catalog/other/adult-search/search=${encoded}.json`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.metas) ? data.metas : [];
}

/**
 * Hook for the main catalogs view. Returns an array of MetaRow-compatible
 * catalog objects, one per user-defined row. Serves cached metas
 * immediately if fresh, otherwise kicks off a background fetch.
 */
function useIncognitoCustomRows() {
    const [rows, setRows] = React.useState(readRows);
    const [dataById, setDataById] = React.useState(() => {
        const m = {};
        for (const r of readRows()) {
            const cached = readCache(r.id);
            m[r.id] = { status: cached ? 'ready' : 'loading', metas: cached || [] };
        }
        return m;
    });

    // Keep `rows` in sync across tabs and with same-tab writes from Settings.
    React.useEffect(() => {
        const refresh = () => setRows(readRows());
        window.addEventListener('storage', refresh);
        window.addEventListener(ROWS_CHANGED_EVENT, refresh);
        return () => {
            window.removeEventListener('storage', refresh);
            window.removeEventListener(ROWS_CHANGED_EVENT, refresh);
        };
    }, []);

    // Fetch any rows that don't have fresh cache. Re-runs when rows change.
    React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        // Seed state for any newly-added rows.
        setDataById(prev => {
            const next = { ...prev };
            for (const r of rows) {
                if (!next[r.id]) {
                    const cached = readCache(r.id);
                    next[r.id] = { status: cached ? 'ready' : 'loading', metas: cached || [] };
                }
            }
            // Drop state for removed rows so the map doesn't grow forever.
            const keep = new Set(rows.map(r => r.id));
            for (const key of Object.keys(next)) if (!keep.has(key)) delete next[key];
            return next;
        });

        (async () => {
            for (const row of rows) {
                if (cancelled) return;
                if (readCache(row.id)) continue; // already fresh
                try {
                    const metas = await fetchQuery(row.query, controller.signal);
                    if (cancelled) return;
                    writeCache(row.id, metas);
                    setDataById(prev => ({
                        ...prev,
                        [row.id]: { status: 'ready', metas },
                    }));
                } catch (err) {
                    if (err.name === 'AbortError' || cancelled) return;
                    setDataById(prev => ({
                        ...prev,
                        [row.id]: { status: 'error', metas: [] },
                    }));
                }
            }
        })();

        return () => { cancelled = true; controller.abort(); };
    }, [rows]);

    // Shape each row as a MetaRow catalog so the main view can render it
    // with the same component it uses for manifest catalogs.
    const customCatalogs = React.useMemo(() => rows.map(row => {
        const data = dataById[row.id] || { status: 'loading', metas: [] };
        return {
            id: `custom:${row.id}`,
            name: row.name || row.query,
            type: 'other',
            query: row.query,
            content: {
                type: 'Ready',
                content: data.metas,
            },
            // Consumers can read this to show a spinner/placeholder.
            _customStatus: data.status,
        };
    }), [rows, dataById]);

    return customCatalogs;
}

// Mutation helpers exposed for the Settings UI.
function listCustomRows() { return readRows(); }

function addCustomRow({ name, query }) {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return null;
    const row = {
        id: makeId(),
        name: String(name || '').trim() || trimmedQuery,
        query: trimmedQuery,
    };
    const next = [...readRows(), row];
    writeRows(next);
    return row;
}

function updateCustomRow(id, patch) {
    const rows = readRows();
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) return;
    const prev = rows[i];
    const nextRow = { ...prev, ...patch };
    // If the query changed, bust the cached results.
    if (patch.query !== undefined && String(patch.query).trim() !== prev.query) {
        clearCache(id);
    }
    rows[i] = nextRow;
    writeRows(rows);
}

function removeCustomRow(id) {
    const next = readRows().filter(r => r.id !== id);
    writeRows(next);
    clearCache(id);
}

function refreshCustomRow(id) {
    clearCache(id);
    writeRows(readRows()); // retrigger the hook
}

// Wipe every cached result row (but keep the row definitions themselves —
// clearing caches should not destroy the user's configured rows). The
// next useIncognitoCustomRows render re-fetches each one.
function clearAllCustomRowCaches() {
    try {
        const rows = readRows();
        for (const r of rows) clearCache(r.id);
        // Ping the hook so it re-seeds and re-fetches.
        window.dispatchEvent(new CustomEvent(ROWS_CHANGED_EVENT));
    } catch (_e) { /* ignore */ }
}

module.exports = useIncognitoCustomRows;
module.exports.useIncognitoCustomRows = useIncognitoCustomRows;
module.exports.listCustomRows = listCustomRows;
module.exports.addCustomRow = addCustomRow;
module.exports.updateCustomRow = updateCustomRow;
module.exports.removeCustomRow = removeCustomRow;
module.exports.refreshCustomRow = refreshCustomRow;
module.exports.clearAllCustomRowCaches = clearAllCustomRowCaches;
