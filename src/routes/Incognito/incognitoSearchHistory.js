// Incognito-only search history.
//
// Kept completely separate from stremio-core's `searchHistory` (which is
// backed by the user's Library / cloud sync and would leak incognito
// queries into the main app's suggestions). This is localStorage-only,
// device-local, never synced.
//
// Storage shape: `[{ query: string, ts: number }]` newest-first, deduped
// by query (case-insensitive), capped at MAX_ENTRIES.

const HISTORY_KEY = 'incognito_search_history';
const CHANGED_EVENT = 'incognito:search-history-changed';
const MAX_ENTRIES = 50;

function readHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(e => e && typeof e.query === 'string' && typeof e.ts === 'number');
    } catch (_e) {
        return [];
    }
}

function writeHistory(list) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        // Same-tab listeners — `storage` events only fire cross-tab.
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    } catch (_e) { /* quota / private mode */ }
}

function addEntry(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;
    const lc = trimmed.toLowerCase();
    const prev = readHistory();
    // Drop any existing entry for the same query (case-insensitive) so the
    // new one floats to the top with a fresh timestamp.
    const filtered = prev.filter(e => e.query.toLowerCase() !== lc);
    const next = [{ query: trimmed, ts: Date.now() }, ...filtered].slice(0, MAX_ENTRIES);
    writeHistory(next);
}

function removeEntry(query) {
    const lc = String(query || '').toLowerCase();
    const next = readHistory().filter(e => e.query.toLowerCase() !== lc);
    writeHistory(next);
}

function clearHistory() {
    writeHistory([]);
}

/**
 * Return entries whose query substring-matches `q` (case-insensitive).
 * When `q` is empty, returns the whole history.
 */
function suggest(q, limit = 8) {
    const trimmed = String(q || '').trim().toLowerCase();
    const all = readHistory();
    if (!trimmed) return all.slice(0, limit);
    return all.filter(e => e.query.toLowerCase().includes(trimmed)).slice(0, limit);
}

function subscribe(cb) {
    const handler = () => cb();
    window.addEventListener(CHANGED_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
        window.removeEventListener(CHANGED_EVENT, handler);
        window.removeEventListener('storage', handler);
    };
}

module.exports = {
    readHistory,
    addEntry,
    removeEntry,
    clearHistory,
    suggest,
    subscribe,
    CHANGED_EVENT,
};
