const React = require('react');

// User-defined catalog rows inside the Incognito tab. Each row is just a
// saved search query — we hit the addon's adult-search endpoint and treat
// the results as a MetaRow catalog.
//
// Caching strategy: stale-while-revalidate with aggregation.
//   FRESH (3 h)  → paint cache, do nothing.
//   STALE (30 d) → paint cache immediately, refresh in the background,
//                  MERGE the fresh metas into the cached list (caching is
//                  aggregative — items from past refreshes are kept even
//                  when Prowlarr cycles them out).
// This is what makes custom rows feel instant on every visit instead of
// triggering a 15-30 s Prowlarr cold search every time the user opens
// the tab. Hard-capped per-row at MAX_PER_ROW to bound localStorage use.

const ROWS_KEY = 'incognito_custom_rows';
// v2 prefix bump: drops cached metas carrying stale `cold: true` flags
// from the over-eager addon cold-state era.
const CACHE_PREFIX = 'incognito_custom_row_cache_v2:';
const FRESH_TTL_MS = 3 * 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Bounds per-row localStorage use. A horizontal row only ever shows a few
// dozen items, and each cached meta is ~3 KB, so 300 made a single row ~900 KB
// and helped blow the shared localStorage quota. 120 is still far more than is
// ever scrolled while keeping each row cache well under ~400 KB.
const MAX_PER_ROW = 120;
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
        return parsed.filter((r) => r && typeof r.id === 'string' && typeof r.query === 'string');
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
        const age = Date.now() - parsed.ts;
        if (age > STALE_TTL_MS) return null;
        return { metas: parsed.metas, fresh: age < FRESH_TTL_MS };
    } catch (_e) {
        return null;
    }
}

function writeCache(id, metas) {
    try {
        localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ ts: Date.now(), metas }));
    } catch (_e) { /* ignore quota */ }
}

// Merge fresh fetch into cached metas (fresh wins on collision, cached-
// only items appended). Capped at MAX_PER_ROW.
function mergeMetas(cachedMetas, freshMetas) {
    if (!Array.isArray(cachedMetas) || cachedMetas.length === 0) {
        return Array.isArray(freshMetas) ? freshMetas.slice(0, MAX_PER_ROW) : [];
    }
    if (!Array.isArray(freshMetas) || freshMetas.length === 0) {
        return cachedMetas.slice(0, MAX_PER_ROW);
    }
    const seen = new Set();
    const out = [];
    for (const m of freshMetas) {
        if (m && m.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    for (const m of cachedMetas) {
        if (m && m.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    return out.slice(0, MAX_PER_ROW);
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
            m[r.id] = cached
                ? { status: cached.fresh ? 'ready' : 'stale', metas: cached.metas }
                : { status: 'loading', metas: [] };
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
    // Stale rows: paint cached immediately, refresh in background, merge.
    React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        // Seed state for any newly-added rows.
        setDataById((prev) => {
            const next = { ...prev };
            for (const r of rows) {
                if (!next[r.id]) {
                    const cached = readCache(r.id);
                    next[r.id] = cached
                        ? { status: cached.fresh ? 'ready' : 'stale', metas: cached.metas }
                        : { status: 'loading', metas: [] };
                }
            }
            // Drop state for removed rows so the map doesn't grow forever.
            const keep = new Set(rows.map((r) => r.id));
            for (const key of Object.keys(next)) if (!keep.has(key)) delete next[key];
            return next;
        });

        (async () => {
            for (const row of rows) {
                if (cancelled) return;
                const cached = readCache(row.id);
                // Fresh cache → no fetch needed.
                if (cached && cached.fresh) continue;
                // Stale or missing — fetch in background and merge.
                try {
                    const metas = await fetchQuery(row.query, controller.signal);
                    if (cancelled) return;
                    const merged = mergeMetas(cached ? cached.metas : [], metas);
                    writeCache(row.id, merged);
                    setDataById((prev) => ({
                        ...prev,
                        [row.id]: { status: 'ready', metas: merged },
                    }));
                } catch (err) {
                    if (err.name === 'AbortError' || cancelled) return;
                    // On error, keep showing stale data if we have it;
                    // only flip to 'error' on a true cold miss.
                    setDataById((prev) => ({
                        ...prev,
                        [row.id]: cached
                            ? { status: 'ready', metas: cached.metas }
                            : { status: 'error', metas: [] },
                    }));
                }
            }
        })();

        return () => { cancelled = true; controller.abort(); };
    }, [rows]);

    // Shape each row as a MetaRow catalog so the main view can render it
    // with the same component it uses for manifest catalogs.
    const customCatalogs = React.useMemo(() => rows.map((row) => {
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
    const i = rows.findIndex((r) => r.id === id);
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
    const next = readRows().filter((r) => r.id !== id);
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
