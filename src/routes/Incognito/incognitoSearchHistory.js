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
// Suggestions philosophy:
//   - Empty query (the user just opened the search box) → show ONLY their
//     own history. Never pre-fill adult terms or pornstar names. A new
//     install with no history shows an empty dropdown.
//   - Typed query → search a large bundled dictionary of adult terms +
//     pornstar names AND the user's history. Prefix matches rank above
//     substring matches. History always shows above dictionary entries
//     for the same prefix.
//
// The dictionaries live in adultDictionary.js / pornstars.js so this
// file stays focused on storage and ranking logic.

const ADULT_DICTIONARY = require('./adultDictionary');
const PORNSTARS = require('./pornstars');
const PORNSTARS_EXTENDED = require('./pornstars-extended');

const HISTORY_KEY = 'incognito_search_history';
const CHANGED_EVENT = 'incognito:search-history-changed';
const MAX_ENTRIES = 50;

// Optional remote pornstar list — fetched on first use and refreshed once
// per day. Lets me grow the suggestion dictionary without shipping a new
// build / forcing every user to redownload the launcher exe. Format is the
// same as pornstars.js: a JSON array of strings. Hosted alongside the web
// UI on gh-pages.
const REMOTE_PORNSTARS_URL = 'https://jeromenicholas07.github.io/stremio-web-netflix/pornstars.json';
const REMOTE_PORNSTARS_LS_KEY = 'incognito_remote_pornstars_v1';
const REMOTE_PORNSTARS_TS_KEY = 'incognito_remote_pornstars_ts_v1';
const REMOTE_PORNSTARS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ── Dictionary preprocessing ──
// Each entry can be a canonical term or `'canonical|alias1|alias2'`.
// We expand into a flat list of { canonical, match } where `match` is the
// lowercased string we test against, and `canonical` is what we display.
//
// `_terms` is mutable so the remote-fetch path can append new pornstar
// entries without rebuilding anything. Each fresh fetch dedupes on the
// lowercased canonical so no entry appears twice.
let _terms = [];
const _seenCanonical = new Set();

function addTerm(canonical, match, kind) {
    const lc = canonical.toLowerCase();
    if (_seenCanonical.has(lc)) return;
    _seenCanonical.add(lc);
    _terms.push({ canonical, match: match.toLowerCase(), kind });
}

function addTermWithAliases(canonicalAndAliases, kind) {
    const parts = String(canonicalAndAliases).split('|');
    const canonical = parts[0];
    const lc = canonical.toLowerCase();
    if (_seenCanonical.has(lc)) return;
    _seenCanonical.add(lc);
    for (const variant of parts) {
        _terms.push({ canonical, match: variant.toLowerCase(), kind });
    }
}

// Bootstrap from bundled lists.
for (const raw of ADULT_DICTIONARY) addTermWithAliases(raw, 'term');
for (const name of PORNSTARS) addTerm(name, name, 'star');
for (const name of PORNSTARS_EXTENDED) addTerm(name, name, 'star');

// Hydrate any remote names already cached (sync) before we kick off a
// background refresh.
try {
    if (typeof localStorage !== 'undefined') {
        const cachedRaw = localStorage.getItem(REMOTE_PORNSTARS_LS_KEY);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (Array.isArray(cached)) {
                for (const name of cached) {
                    if (typeof name === 'string' && name.trim()) addTerm(name.trim(), name.trim(), 'star');
                }
            }
        }
    }
} catch { /* localStorage unavailable / corrupt — ignore */ }

// Background refresh (fire-and-forget). Runs once per day; failures are
// silent (we just keep using the bundled + cached list).
function maybeRefreshRemote() {
    if (typeof fetch === 'undefined' || typeof localStorage === 'undefined') return;
    let lastTs = 0;
    try { lastTs = parseInt(localStorage.getItem(REMOTE_PORNSTARS_TS_KEY) || '0', 10) || 0; } catch { /* */ }
    if (Date.now() - lastTs < REMOTE_PORNSTARS_TTL_MS) return;
    fetch(REMOTE_PORNSTARS_URL, { cache: 'no-cache' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!Array.isArray(data)) return;
            const valid = data.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
            try {
                localStorage.setItem(REMOTE_PORNSTARS_LS_KEY, JSON.stringify(valid));
                localStorage.setItem(REMOTE_PORNSTARS_TS_KEY, String(Date.now()));
            } catch { /* quota — non-fatal */ }
            for (const name of valid) addTerm(name, name, 'star');
        })
        .catch(() => { /* offline / 404 / CORS — silent */ });
}
// Defer the refresh slightly so we don't compete with the page's first
// paint. setTimeout 0 is enough — pushes it past the current microtask
// queue so React's first commit goes first.
if (typeof setTimeout !== 'undefined') setTimeout(maybeRefreshRemote, 0);

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
 * Return suggestions for the current query.
 *
 * Empty query: ONLY the user's history (sorted newest-first, capped at
 * `limit`). No filler terms, no pre-filled pornstar names — a new install
 * shows an empty dropdown.
 *
 * Non-empty query: history entries that match the query (substring), then
 * dictionary terms + pornstar names that match. Ranking inside the
 * dictionary tier is "prefix match first, substring match second", so
 * typing "mia" shows "Mia Khalifa", "Mia Malkova", … before "Cynthia Mia".
 *
 * Each returned entry shape:
 *   `{ query: string, ts?: number, kind: 'history' | 'term' | 'star' }`.
 */
function suggest(q, limit = 8) {
    const trimmed = String(q || '').trim().toLowerCase();
    const history = readHistory().map(e => ({ query: e.query, ts: e.ts, kind: 'history' }));
    const seen = new Set(history.map(e => e.query.toLowerCase()));

    // Empty query → history only, no pre-filled adult content.
    if (!trimmed) {
        return history.slice(0, limit);
    }

    const filteredHistory = history.filter(e => e.query.toLowerCase().includes(trimmed));

    // Two-tier match: prefix-first, substring-second. Each entry is shown
    // by its canonical form; aliases match silently. Dedupe by canonical so
    // an entry with multiple matching aliases doesn't render twice.
    const dictPrefix = [];
    const dictSubstring = [];
    const usedCanonical = new Set();
    for (const t of _terms) {
        const canonicalLc = t.canonical.toLowerCase();
        if (seen.has(canonicalLc) || usedCanonical.has(canonicalLc)) continue;
        if (t.match.startsWith(trimmed)) {
            usedCanonical.add(canonicalLc);
            dictPrefix.push({ query: t.canonical, kind: t.kind });
        } else if (t.match.includes(trimmed)) {
            // Defer the dedupe-add until the substring tier emits the entry,
            // so a later prefix match on the same canonical can still win.
            dictSubstring.push({ query: t.canonical, kind: t.kind, _lc: canonicalLc });
        }
    }
    // Apply the substring tier with a second-pass dedupe.
    const subOut = [];
    for (const e of dictSubstring) {
        if (usedCanonical.has(e._lc)) continue;
        usedCanonical.add(e._lc);
        subOut.push({ query: e.query, kind: e.kind });
    }

    return [
        ...filteredHistory,
        ...dictPrefix,
        ...subOut,
    ].slice(0, limit);
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
