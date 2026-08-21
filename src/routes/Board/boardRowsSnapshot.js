// Copyright (C) 2017-2026 Smart code 203358507

// Last-known-good snapshot of the board's discovery rows.
//
// The rows themselves are already cached upstream (Trakt responses in
// localStorage, TMDB lookups in IndexedDB), but rebuilding the row model from
// those caches still means unwrapping every response and walking every item
// before the first row can paint. This stores the *finished* row model — the
// exact shape the board renders — so a remount can paint the home screen from
// disk in one read, then reconcile against fresh data as it arrives.
//
// The snapshot is a rendering optimisation, never a source of truth: a fresh
// build always replaces it, and a failed read just means the old (slower)
// build-then-paint path.

const idb = require('stremio/common/idbKeyval');

const DB_NAME = 'board_cache';
const STORE_NAME = 'kv';
const SNAPSHOT_KEY = 'discovery_rows_v1';

// Bump when the row/item shape changes so old snapshots are discarded rather
// than rendered into a component that no longer understands them.
const SNAPSHOT_VERSION = 1;

// Rows older than this are dropped instead of shown. Everything here is
// discovery content ("Trending this week") that reads as wrong once it is
// genuinely stale, and a week-old snapshot is still replaced seconds after it
// paints — this only bounds what a long-absent user sees first.
const SNAPSHOT_TTL = 7 * 24 * 60 * 60 * 1000;

// Bound what we write. The board only renders the first screenful of each row
// before the user scrolls, and a fresh build overwrites this within seconds.
const MAX_ROWS = 30;
const MAX_ITEMS_PER_ROW = 50;

// Only the fields the board actually renders survive a round trip. Keeping this
// explicit stops an incidental field (a closure, a DOM node) from reaching
// structured-clone and failing the whole write.
function serializeItem(item) {
    if (!item || typeof item.id !== 'string') return null;
    return {
        id: item.id,
        name: item.name || '',
        type: item.type || '',
        poster: item.poster || '',
        background: item.background || '',
        posterShape: item.posterShape || 'poster',
        releaseInfo: item.releaseInfo || '',
        _tmdbId: item._tmdbId || null,
        deepLinks: item.deepLinks && typeof item.deepLinks === 'object' ?
            {
                metaDetailsStreams: item.deepLinks.metaDetailsStreams || '',
                metaDetailsVideos: item.deepLinks.metaDetailsVideos || '',
            }
            :
            null,
    };
}

function serializeRow(row) {
    if (!row || typeof row.key !== 'string') return null;
    const items = (Array.isArray(row.items) ? row.items : [])
        .slice(0, MAX_ITEMS_PER_ROW)
        .map(serializeItem)
        .filter(Boolean);
    if (items.length === 0) return null;
    return { key: row.key, title: row.title || '', items };
}

async function loadRowsSnapshot() {
    const stored = await idb.get(DB_NAME, STORE_NAME, SNAPSHOT_KEY);
    if (!stored || typeof stored !== 'object') return null;
    if (stored.version !== SNAPSHOT_VERSION) return null;
    if (!Number.isFinite(stored.savedAt) || Date.now() - stored.savedAt > SNAPSHOT_TTL) return null;

    const rows = (Array.isArray(stored.rows) ? stored.rows : [])
        .map(serializeRow)
        .filter(Boolean);
    return rows.length > 0 ? rows : null;
}

function saveRowsSnapshot(rows) {
    const serialized = (Array.isArray(rows) ? rows : [])
        .slice(0, MAX_ROWS)
        .map(serializeRow)
        .filter(Boolean);
    if (serialized.length === 0) return Promise.resolve(false);

    return idb.set(DB_NAME, STORE_NAME, SNAPSHOT_KEY, {
        version: SNAPSHOT_VERSION,
        savedAt: Date.now(),
        rows: serialized,
    });
}

function clearRowsSnapshot() {
    return idb.del(DB_NAME, STORE_NAME, SNAPSHOT_KEY);
}

module.exports = {
    SNAPSHOT_VERSION,
    SNAPSHOT_TTL,
    MAX_ITEMS_PER_ROW,
    loadRowsSnapshot,
    saveRowsSnapshot,
    clearRowsSnapshot,
};
