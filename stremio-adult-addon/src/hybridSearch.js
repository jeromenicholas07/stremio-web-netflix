// Hybrid torrent search — fast direct sources + Prowlarr supplement.
//
// Runs every direct adapter (apibay, Knaben, Torrents-CSV) AND Prowlarr in
// parallel. Direct adapters are fast (~1-2s) and reliable; Prowlarr adds
// niche breadth but is slow, so it only gets whatever's left of a hard
// ~6s budget — a slow Prowlarr (or any dead adapter) never blocks the
// response. Results are merged, deduped, and sorted by seeders.

const { SOURCES } = require('./directSources');
const { searchProwlarr } = require('./prowlarr');
const { fingerprint } = require('./dedup');

// Total wall-clock budget for a search. Direct adapters resolve well
// inside this; Prowlarr gets the remainder as a grace window.
const HARD_DEADLINE_MS = 6000;

function delay(ms, value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// Run a producer, never throw, always resolve to an array.
async function safeArray(producer) {
    try {
        const r = await producer();
        return Array.isArray(r) ? r : [];
    } catch (err) {
        return [];
    }
}

/**
 * @param {Object}  opts
 * @param {string}  opts.query        search query
 * @param {number}  opts.cat          0 = all, 500 = adult (for direct adapters)
 * @param {Object}  opts.prowlarrOpts options forwarded verbatim to searchProwlarr
 * @returns {Promise<Array>} merged, deduped, seeders-sorted normalized items
 */
async function hybridSearch({ query, cat, prowlarrOpts }) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return [];

    const start = Date.now();

    // Fire all direct adapters in parallel — each failure-isolated.
    const directPromise = Promise.all(
        SOURCES.map((src) => safeArray(() => src.search({ query: q, cat })))
    ).then((lists) => lists.flat());

    // Prowlarr runs alongside; we never await it directly past the budget.
    const prowlarrPromise = safeArray(() => searchProwlarr(prowlarrOpts));

    // Await the fast tier first, then hand Prowlarr only the leftover budget.
    const direct = await directPromise;
    const remaining = Math.max(0, HARD_DEADLINE_MS - (Date.now() - start));
    const prowlarr = await Promise.race([prowlarrPromise, delay(remaining, [])]);

    // Merge + dedupe. Key on infoHash when present, else a title/url
    // fingerprint. On collision keep the higher-seeder copy.
    const byKey = new Map();
    for (const item of [...direct, ...prowlarr]) {
        if (!item) continue;
        const hash = typeof item.infoHash === 'string' ? item.infoHash.toLowerCase() : '';
        const key = /^[a-f0-9]{40}$/.test(hash)
            ? `h:${hash}`
            : `f:${fingerprint(item.downloadUrl || '', item.title || '')}`;
        const existing = byKey.get(key);
        if (!existing || (Number(item.seeders) || 0) > (Number(existing.seeders) || 0)) {
            byKey.set(key, item);
        }
    }

    const merged = Array.from(byKey.values());
    merged.sort((a, b) => (Number(b.seeders) || 0) - (Number(a.seeders) || 0));
    return merged;
}

module.exports = { hybridSearch };
