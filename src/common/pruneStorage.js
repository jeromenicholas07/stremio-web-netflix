// Copyright (C) 2017-2026 Smart code 203358507

// Keep localStorage from filling the shared ~5 MB quota and breaking
// stremio-core's writes (library / library_recent / streaming_server_urls) and
// small settings (auto-pick, debug). Several subsystems cache large, fully
// rebuildable network payloads in localStorage:
//   - Incognito catalogs / custom-row / search caches
//   - the Trakt response cache
// Older builds also left superseded versions of these keys behind (v1 → v2
// migrations that never deleted the old key), which alone accounted for
// megabytes of dead weight.
//
// This runs once at startup: it deletes superseded legacy keys outright, then —
// if still over budget — evicts the largest rebuildable caches until under it.
// Essential data (core library, profile, tokens, settings) is never touched.

// Exact keys from older builds that the current code no longer reads.
const LEGACY_KEYS_EXACT = [
    'incognito_catalogs_cache_v1',
    'incognito_search_cache_v1',
    'tmdb_persist_cache_v1', // cache now lives in IndexedDB
    'stremio_watchlist',
    'stremio_not_interested',
    'stremio_ratings',
    'stremio_dismissed_names',
];

// Key prefixes from older builds (superseded by a *_v2 prefix).
const LEGACY_PREFIXES = [
    'incognito_custom_row_cache:', // superseded by incognito_custom_row_cache_v2:
];

// Rebuildable caches we may evict under memory pressure. Anything NOT listed
// here (core data, settings, auth tokens, the Trakt sync snapshot) is kept.
const EVICTABLE_PREFIXES = [
    'incognito_custom_row_cache_v2:',
    'incognito_catalogs_cache_v2',
    'incognito_search_cache_v2',
    'trakt_response_cache_v1',
];

// Keep localStorage comfortably under the ~5 MB quota so core + settings always
// have room. Measured in characters (matches how the quota is hit in practice).
const BUDGET_CHARS = 3 * 1024 * 1024;

function isEvictable(key) {
    return EVICTABLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function pruneStorage() {
    let ls;
    try {
        ls = typeof window !== 'undefined' ? window.localStorage : null;
        if (!ls) return;
    } catch {
        return;
    }

    // 1) Delete superseded legacy keys outright.
    const legacy = [];
    for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key) continue;
        if (LEGACY_KEYS_EXACT.includes(key) || LEGACY_PREFIXES.some((p) => key.startsWith(p))) {
            legacy.push(key);
        }
    }
    legacy.forEach((key) => {
        try { ls.removeItem(key); } catch { /* ignore */ }
    });

    // 2) If still over budget, evict the largest rebuildable caches first.
    let total = 0;
    const evictable = [];
    for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key) continue;
        const size = key.length + (ls.getItem(key) || '').length;
        total += size;
        if (isEvictable(key)) evictable.push({ key, size });
    }
    if (total <= BUDGET_CHARS) return;

    evictable.sort((a, b) => b.size - a.size);
    for (const { key, size } of evictable) {
        if (total <= BUDGET_CHARS) break;
        try {
            ls.removeItem(key);
            total -= size;
        } catch { /* ignore */ }
    }
}

module.exports = { pruneStorage };
