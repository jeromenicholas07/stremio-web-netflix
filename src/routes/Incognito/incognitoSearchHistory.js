// Incognito-only search history + suggestions.
//
// Kept completely separate from stremio-core's `searchHistory` (which is
// backed by the user's Library / cloud sync and would leak incognito
// queries into the main app's suggestions). This is localStorage-only,
// device-local, never synced.
//
// Storage shape: `[{ query: string, ts: number }]` newest-first, deduped
// by query (case-insensitive), capped at MAX_ENTRIES.
//
// Suggestions: blend stored history with a static list of canonical
// genres/categories. The genre list mirrors the addon's manifest so
// suggestions match real catalog facets. Pornstar names are deliberately
// NOT bundled — they accumulate naturally via history as the user types.
// (Free public autocomplete APIs for adult content either require API
// keys or route through search engines that filter/block adult terms,
// so client-side suggestions are the only reliable option.)

const HISTORY_KEY = 'incognito_search_history';
const CHANGED_EVENT = 'incognito:search-history-changed';
const MAX_ENTRIES = 50;

// Bundled fallback genre suggestions. Match the addon's manifest so
// clicking one returns a meaningful catalog. Lowercase for case-insensitive
// match; rendered as-typed by the user.
const STATIC_SUGGESTIONS = [
    'amateur', 'anal', 'asian', 'bbw', 'big tits', 'blonde', 'blowjob',
    'brunette', 'casting', 'compilation', 'creampie', 'cumshot', 'dp',
    'ebony', 'european', 'facial', 'fetish', 'fisting', 'gangbang',
    'group', 'hairy', 'handjob', 'hardcore', 'hd', 'hentai', 'indian',
    'interracial', 'jav', 'latex', 'latina', 'lesbian', 'massage',
    'masturbation', 'mature', 'milf', 'mom', 'orgy', 'pawg', 'petite',
    'pissing', 'pov', 'public', 'redhead', 'rough', 'russian', 'school',
    'shemale', 'small tits', 'solo', 'squirt', 'stepmom', 'stepsister',
    'teen', 'threesome', 'tied', 'toys', 'uncensored', 'vintage',
    'voyeur', 'webcam',
];

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
 * Blends the user's history with the bundled STATIC_SUGGESTIONS list so
 * a fresh install with no history still shows useful suggestions on
 * focus / partial-typing. History entries always come first; static
 * fillers slot in below until the limit is hit. Static entries do NOT
 * appear when `q` matches no static suggestion (so typing "mia kha…"
 * doesn't dilute the dropdown with irrelevant genres).
 *
 * Each returned entry shape: `{ query: string, ts?: number, kind: 'history' | 'static' }`.
 */
function suggest(q, limit = 8) {
    const trimmed = String(q || '').trim().toLowerCase();
    const history = readHistory().map(e => ({ query: e.query, ts: e.ts, kind: 'history' }));
    const seen = new Set(history.map(e => e.query.toLowerCase()));

    let filteredHistory = history;
    if (trimmed) {
        filteredHistory = history.filter(e => e.query.toLowerCase().includes(trimmed));
    }

    // Static suggestions filtered by prefix/substring match. Skip ones the
    // user has already searched (deduped via `seen`).
    const staticMatches = STATIC_SUGGESTIONS
        .filter(s => !seen.has(s))
        .filter(s => !trimmed || s.includes(trimmed))
        .slice(0, limit) // cap before constructing objects
        .map(s => ({ query: s, kind: 'static' }));

    return [...filteredHistory, ...staticMatches].slice(0, limit);
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
