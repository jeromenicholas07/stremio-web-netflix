// Copyright (C) 2017-2026 Smart code 203358507

const idb = require('../src/common/idbKeyval');
const snapshot = require('../src/routes/Board/boardRowsSnapshot');

const {
    SNAPSHOT_VERSION,
    SNAPSHOT_TTL,
    MAX_ITEMS_PER_ROW,
    loadRowsSnapshot,
    saveRowsSnapshot,
    clearRowsSnapshot,
} = snapshot;

// Stand-in for IndexedDB: the module under test only needs get/set/del to
// behave like a key/value store that can also fail.
let store;

beforeEach(() => {
    store = new Map();
    jest.spyOn(idb, 'get').mockImplementation(async (db, name, key) => store.get(key));
    jest.spyOn(idb, 'set').mockImplementation(async (db, name, key, value) => {
        store.set(key, value);
        return true;
    });
    jest.spyOn(idb, 'del').mockImplementation(async (db, name, key) => {
        store.delete(key);
        return true;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

function item(id, extra = {}) {
    return {
        id,
        name: `Title ${id}`,
        type: 'movie',
        poster: `https://img/${id}.jpg`,
        background: `https://bg/${id}.jpg`,
        posterShape: 'landscape',
        releaseInfo: '2020',
        _tmdbId: 42,
        deepLinks: { metaDetailsStreams: `#/a/${id}`, metaDetailsVideos: `#/b/${id}` },
        ...extra,
    };
}

function row(key, ids) {
    return { key, title: `Row ${key}`, items: ids.map((id) => item(id)) };
}

describe('round trip', () => {
    it('returns null when nothing was ever saved', async () => {
        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });

    it('restores exactly the fields the board renders', async () => {
        await saveRowsSnapshot([row('trending-movies', ['tt1', 'tt2'])]);
        const loaded = await loadRowsSnapshot();

        expect(loaded).toHaveLength(1);
        expect(loaded[0].key).toBe('trending-movies');
        expect(loaded[0].title).toBe('Row trending-movies');
        expect(loaded[0].items[0]).toEqual({
            id: 'tt1',
            name: 'Title tt1',
            type: 'movie',
            poster: 'https://img/tt1.jpg',
            background: 'https://bg/tt1.jpg',
            posterShape: 'landscape',
            releaseInfo: '2020',
            _tmdbId: 42,
            deepLinks: { metaDetailsStreams: '#/a/tt1', metaDetailsVideos: '#/b/tt1' },
        });
    });

    it('preserves row order', async () => {
        await saveRowsSnapshot([row('a', ['tt1']), row('b', ['tt2']), row('c', ['tt3'])]);
        const loaded = await loadRowsSnapshot();
        expect(loaded.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    });

    it('overwrites the previous snapshot rather than appending', async () => {
        await saveRowsSnapshot([row('a', ['tt1'])]);
        await saveRowsSnapshot([row('b', ['tt2'])]);
        const loaded = await loadRowsSnapshot();
        expect(loaded.map((r) => r.key)).toEqual(['b']);
    });

    it('forgets the snapshot on demand', async () => {
        await saveRowsSnapshot([row('a', ['tt1'])]);
        await clearRowsSnapshot();
        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });
});

describe('freshness', () => {
    it('drops a snapshot older than the TTL', async () => {
        await saveRowsSnapshot([row('a', ['tt1'])]);
        const stored = store.get('discovery_rows_v1');
        stored.savedAt = Date.now() - SNAPSHOT_TTL - 1000;

        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });

    it('keeps a snapshot just inside the TTL', async () => {
        await saveRowsSnapshot([row('a', ['tt1'])]);
        store.get('discovery_rows_v1').savedAt = Date.now() - SNAPSHOT_TTL + 60_000;

        await expect(loadRowsSnapshot()).resolves.not.toBe(null);
    });

    it('drops a snapshot written by an older row shape', async () => {
        await saveRowsSnapshot([row('a', ['tt1'])]);
        store.get('discovery_rows_v1').version = SNAPSHOT_VERSION - 1;

        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });
});

describe('bounds', () => {
    it('caps items per row', async () => {
        const ids = Array.from({ length: MAX_ITEMS_PER_ROW + 20 }, (_, i) => `tt${i}`);
        await saveRowsSnapshot([row('a', ids)]);
        const loaded = await loadRowsSnapshot();
        expect(loaded[0].items).toHaveLength(MAX_ITEMS_PER_ROW);
    });

    it('caps total rows', async () => {
        const rows = Array.from({ length: 40 }, (_, i) => row(`r${i}`, ['tt1']));
        await saveRowsSnapshot(rows);
        expect(store.get('discovery_rows_v1').rows.length).toBeLessThanOrEqual(30);
    });
});

describe('malformed data', () => {
    it('skips items without a usable id', async () => {
        await saveRowsSnapshot([{
            key: 'a',
            title: 'A',
            items: [item('tt1'), { name: 'no id' }, null, item('tt2')],
        }]);
        const loaded = await loadRowsSnapshot();
        expect(loaded[0].items.map((i) => i.id)).toEqual(['tt1', 'tt2']);
    });

    it('drops rows that end up empty', async () => {
        await saveRowsSnapshot([row('a', ['tt1']), { key: 'b', title: 'B', items: [] }]);
        const loaded = await loadRowsSnapshot();
        expect(loaded.map((r) => r.key)).toEqual(['a']);
    });

    it('does not write when there is nothing worth keeping', async () => {
        await expect(saveRowsSnapshot([])).resolves.toBe(false);
        expect(idb.set).not.toHaveBeenCalled();
    });

    it('survives a stored value that is not a snapshot', async () => {
        store.set('discovery_rows_v1', 'garbage');
        await expect(loadRowsSnapshot()).resolves.toBe(null);

        store.set('discovery_rows_v1', { version: SNAPSHOT_VERSION, savedAt: Date.now(), rows: 'nope' });
        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });

    it('tolerates an item with no deepLinks', async () => {
        await saveRowsSnapshot([{ key: 'a', title: 'A', items: [item('tt1', { deepLinks: undefined })] }]);
        const loaded = await loadRowsSnapshot();
        expect(loaded[0].items[0].deepLinks).toBe(null);
    });
});

describe('storage failure', () => {
    it('reports a failed write without throwing', async () => {
        idb.set.mockResolvedValue(false);
        await expect(saveRowsSnapshot([row('a', ['tt1'])])).resolves.toBe(false);
    });

    it('returns null when the store is unreadable', async () => {
        idb.get.mockResolvedValue(undefined);
        await expect(loadRowsSnapshot()).resolves.toBe(null);
    });
});
