// Copyright (C) 2017-2025 Smart Code OOD
// TraktBridge integration tests — covers all operations across all row types,
// verifying both immediate (optimistic) state and post-refresh (API sync) state.

'use strict';

// ─── Mock localStorage ───
const storage = {};
const localStorageMock = {
    getItem: jest.fn((key) => storage[key] || null),
    setItem: jest.fn((key, val) => { storage[key] = String(val); }),
    removeItem: jest.fn((key) => { delete storage[key]; }),
    clear: jest.fn(() => { Object.keys(storage).forEach((k) => delete storage[k]); }),
};
global.localStorage = localStorageMock;

// ─── Mock fetch ───
let fetchHandler = () => Promise.resolve(makeOkResponse({}));
global.fetch = jest.fn((...args) => fetchHandler(...args));

// ─── Require TraktBridge singleton ───
const traktBridge = require('../src/services/TraktBridge');

// ─── Helpers ───

function makeOkResponse(body, status = 200) {
    const text = JSON.stringify(body);
    return {
        ok: true,
        status,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(body),
        headers: { get: (h) => h === 'content-type' ? 'application/json' : null },
    };
}

function make404Response() {
    return {
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
        json: () => Promise.reject(new Error('Not JSON')),
        headers: { get: () => null },
    };
}

function makeTraktMovie(imdbId, tmdbId, title, year = 2020) {
    return {
        movie: {
            title,
            year,
            ids: {
                imdb: imdbId || undefined,
                tmdb: tmdbId || undefined,
                trakt: Math.floor(Math.random() * 100000),
                slug: title.toLowerCase().replace(/\s/g, '-'),
            },
        },
    };
}

function makeTraktShow(imdbId, tmdbId, title, year = 2020) {
    return {
        show: {
            title,
            year,
            ids: {
                imdb: imdbId || undefined,
                tmdb: tmdbId || undefined,
                trakt: Math.floor(Math.random() * 100000),
                slug: title.toLowerCase().replace(/\s/g, '-'),
            },
        },
    };
}

function makeWatchedMovie(imdbId, tmdbId, title, watchedAt = '2026-03-28T10:00:00.000Z') {
    const m = makeTraktMovie(imdbId, tmdbId, title);
    return { ...m, plays: 1, last_watched_at: watchedAt };
}

function makeWatchedShow(imdbId, tmdbId, title, watchedAt = '2026-03-28T10:00:00.000Z') {
    const s = makeTraktShow(imdbId, tmdbId, title);
    return { ...s, plays: 1, last_watched_at: watchedAt };
}

function makeRatingMovie(imdbId, tmdbId, title, rating = 8) {
    const m = makeTraktMovie(imdbId, tmdbId, title);
    return { ...m, rating, rated_at: '2026-03-28T10:00:00.000Z' };
}

function makeRatingShow(imdbId, tmdbId, title, rating = 8) {
    const s = makeTraktShow(imdbId, tmdbId, title);
    return { ...s, rating, rated_at: '2026-03-28T10:00:00.000Z' };
}

function makeWatchlistMovie(imdbId, tmdbId, title, listedAt = '2026-03-28T10:00:00.000Z') {
    const m = makeTraktMovie(imdbId, tmdbId, title);
    return { ...m, listed_at: listedAt };
}

function makeWatchlistShow(imdbId, tmdbId, title, listedAt = '2026-03-28T10:00:00.000Z') {
    const s = makeTraktShow(imdbId, tmdbId, title);
    return { ...s, listed_at: listedAt };
}

function makeNIEntry(imdbId, tmdbId, title, isShow = false, listedAt = '2026-03-28T10:00:00.000Z') {
    const base = isShow ? makeTraktShow(imdbId, tmdbId, title) : makeTraktMovie(imdbId, tmdbId, title);
    return { ...base, listed_at: listedAt };
}

// Builds a complete mock API response map for _doSync
function buildSyncResponses({
    ratedMovies = [], ratedShows = [],
    watchedMovies = [], watchedShows = [],
    watchlistMovies = [], watchlistShows = [],
    niItems = [], lists = [],
} = {}) {
    return {
        '/sync/ratings/movies': ratedMovies,
        '/sync/ratings/shows': ratedShows,
        '/sync/watched/movies': watchedMovies,
        '/sync/watched/shows': watchedShows,
        '/sync/watchlist/movies': watchlistMovies,
        '/sync/watchlist/shows': watchlistShows,
        '/users/me/lists/not-interested/items': niItems,
        '/users/me/lists': lists,
    };
}

// Set up fetch mock to return specific responses per path
function mockFetch(responseMap) {
    fetchHandler = (url, opts) => {
        const path = url.replace(/^.*\/trakt-api/, '').replace(/^https:\/\/api\.trakt\.tv/, '');
        if (responseMap[path] !== undefined) {
            const data = responseMap[path];
            if (data === 'FAIL') return Promise.resolve(make404Response());
            return Promise.resolve(makeOkResponse(data));
        }
        // Default: return ok for POST (add/remove operations), empty for GET
        if (opts?.method === 'POST') {
            return Promise.resolve(makeOkResponse({ added: { movies: 1 }, deleted: { movies: 1 } }));
        }
        return Promise.resolve(makeOkResponse([]));
    };
}

function resetBridge() {
    traktBridge._ratedIds = new Set();
    traktBridge._watchedIds = new Set();
    traktBridge._watchlistIds = new Set();
    traktBridge._notInterestedIds = new Set();
    traktBridge._allDismissedIds = new Set();
    traktBridge._lastSync = 0;
    traktBridge._syncPromise = null;
    traktBridge._listeners = new Set();
    traktBridge._notInterestedListSlug = '';
    traktBridge._watchedItemsData = [];
    traktBridge._watchlistItemsData = [];
    traktBridge._notInterestedItemsData = [];
    traktBridge._ratedImdbIds = new Set();
    traktBridge._ratedTmdbIds = new Set();
    traktBridge._devicePollTimer = null;
    traktBridge._devicePollAbort = null;
    clearTimeout(traktBridge._refreshTimer_watchlist);
    clearTimeout(traktBridge._refreshTimer_notInterested);
    clearTimeout(traktBridge._refreshTimer_watched);
    localStorageMock.clear();
    // Set required localStorage values
    storage['trakt_access_token'] = 'test-token';
    storage['trakt_token_expiry'] = String(Date.now() + 3600000);
    storage['trakt_not_interested_slug'] = 'not-interested';
    global.fetch.mockClear();
}

// Simulate a full page refresh: reset state and run _doSync with mock API data
async function simulatePageRefresh(apiResponses) {
    traktBridge._ratedIds = new Set();
    traktBridge._watchedIds = new Set();
    traktBridge._watchlistIds = new Set();
    traktBridge._notInterestedIds = new Set();
    traktBridge._allDismissedIds = new Set();
    traktBridge._watchedItemsData = [];
    traktBridge._watchlistItemsData = [];
    traktBridge._notInterestedItemsData = [];
    traktBridge._ratedImdbIds = new Set();
    traktBridge._ratedTmdbIds = new Set();
    traktBridge._lastSync = 0;
    traktBridge._syncPromise = null;
    mockFetch(apiResponses);
    await traktBridge._doSync();
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
    jest.useFakeTimers();
    resetBridge();
    mockFetch({});
});

afterEach(() => {
    jest.useRealTimers();
});

// ─── 1. _parseId ───

describe('_parseId', () => {
    test('parses IMDB ID', () => {
        expect(traktBridge._parseId('tt1234567')).toEqual({ imdb: 'tt1234567' });
    });
    test('parses TMDB ID', () => {
        expect(traktBridge._parseId('tmdb:12345')).toEqual({ tmdb: '12345' });
    });
    test('returns empty for null', () => {
        expect(traktBridge._parseId(null)).toEqual({});
    });
    test('returns empty for undefined', () => {
        expect(traktBridge._parseId(undefined)).toEqual({});
    });
    test('returns empty for unrecognized format', () => {
        expect(traktBridge._parseId('abc123')).toEqual({});
    });
});

// ─── 2. Event system ───

describe('onChange / _notify', () => {
    test('listener called on _notify', () => {
        const fn = jest.fn();
        traktBridge.onChange(fn);
        traktBridge._notify();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('unsubscribe stops notifications', () => {
        const fn = jest.fn();
        const unsub = traktBridge.onChange(fn);
        unsub();
        traktBridge._notify();
        expect(fn).not.toHaveBeenCalled();
    });

    test('exception in one listener does not break others', () => {
        const bad = jest.fn(() => { throw new Error('boom'); });
        const good = jest.fn();
        traktBridge.onChange(bad);
        traktBridge.onChange(good);
        traktBridge._notify();
        expect(bad).toHaveBeenCalled();
        expect(good).toHaveBeenCalled();
    });
});

// ─── 3. _rebuildDismissed ───

describe('_rebuildDismissed', () => {
    test('combines all four ID sets', () => {
        traktBridge._ratedIds.add('tt0001');
        traktBridge._watchedIds.add('tt0002');
        traktBridge._watchlistIds.add('tt0003');
        traktBridge._notInterestedIds.add('tt0004');
        traktBridge._rebuildDismissed();
        const dismissed = traktBridge.getDismissedIds();
        expect(dismissed.has('tt0001')).toBe(true);
        expect(dismissed.has('tt0002')).toBe(true);
        expect(dismissed.has('tt0003')).toBe(true);
        expect(dismissed.has('tt0004')).toBe(true);
    });

    test('isItemDismissed returns correct results', () => {
        traktBridge._ratedIds.add('tt9999');
        traktBridge._rebuildDismissed();
        expect(traktBridge.isItemDismissed('tt9999')).toBe(true);
        expect(traktBridge.isItemDismissed('tt0000')).toBe(false);
    });
});

// ─── 4. getWatchedNotRated ───

describe('getWatchedNotRated', () => {
    test('returns unrated items', () => {
        traktBridge._watchedItemsData = [
            { id: 'tt0001', imdbId: 'tt0001', tmdbId: 100, name: 'MovieA', type: 'movie' },
            { id: 'tt0002', imdbId: 'tt0002', tmdbId: 200, name: 'MovieB', type: 'movie' },
        ];
        const result = traktBridge.getWatchedNotRated();
        expect(result).toHaveLength(2);
    });

    test('filters out item rated by IMDB ID', () => {
        traktBridge._watchedItemsData = [
            { id: 'tt0001', imdbId: 'tt0001', tmdbId: 100, name: 'MovieA', type: 'movie' },
        ];
        traktBridge._ratedImdbIds.add('tt0001');
        expect(traktBridge.getWatchedNotRated()).toHaveLength(0);
    });

    test('filters out item rated by TMDB ID', () => {
        traktBridge._watchedItemsData = [
            { id: 'tmdb:100', imdbId: null, tmdbId: 100, name: 'MovieA', type: 'movie' },
        ];
        traktBridge._ratedTmdbIds.add(100);
        expect(traktBridge.getWatchedNotRated()).toHaveLength(0);
    });

    test('filters out item when only one ID variant is rated', () => {
        traktBridge._watchedItemsData = [
            { id: 'tt0001', imdbId: 'tt0001', tmdbId: 100, name: 'MovieA', type: 'movie' },
        ];
        // Only TMDB rated, not IMDB — should still be filtered
        traktBridge._ratedTmdbIds.add(100);
        expect(traktBridge.getWatchedNotRated()).toHaveLength(0);
    });

    test('includes movies and shows', () => {
        traktBridge._watchedItemsData = [
            { id: 'tt0001', imdbId: 'tt0001', tmdbId: 100, name: 'MovieA', type: 'movie' },
            { id: 'tt0002', imdbId: 'tt0002', tmdbId: 200, name: 'ShowA', type: 'series' },
        ];
        const result = traktBridge.getWatchedNotRated();
        expect(result.filter((i) => i.type === 'movie')).toHaveLength(1);
        expect(result.filter((i) => i.type === 'series')).toHaveLength(1);
    });
});

// ─── 5. addToWatchlist ───

describe('addToWatchlist', () => {
    describe('from Discovery row (IMDB ID)', () => {
        const itemId = 'tt0111161';
        const type = 'movie';
        const name = 'The Shawshank Redemption';

        test('item appears in getWatchlistItems immediately', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            const items = traktBridge.getWatchlistItems();
            expect(items.some((i) => i.id === itemId)).toBe(true);
            expect(items.find((i) => i.id === itemId).name).toBe(name);
        });

        test('item ID added to _watchlistIds', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            expect(traktBridge._watchlistIds.has(itemId)).toBe(true);
        });

        test('item appears in getDismissedIds', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            expect(traktBridge.isItemDismissed(itemId)).toBe(true);
        });

        test('_notify called', async () => {
            const fn = jest.fn();
            traktBridge.onChange(fn);
            await traktBridge.addToWatchlist(itemId, type, name);
            expect(fn).toHaveBeenCalled();
        });

        test('duplicate add does not create duplicate entries', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            await traktBridge.addToWatchlist(itemId, type, name);
            expect(traktBridge.getWatchlistItems().filter((i) => i.id === itemId)).toHaveLength(1);
        });

        test('item persists after page refresh', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            // Simulate page refresh — API returns the item in watchlist
            await simulatePageRefresh(buildSyncResponses({
                watchlistMovies: [makeWatchlistMovie('tt0111161', 389, 'The Shawshank Redemption')],
            }));
            const items = traktBridge.getWatchlistItems();
            expect(items.some((i) => i.id === itemId)).toBe(true);
            expect(traktBridge.isItemDismissed(itemId)).toBe(true);
        });
    });

    describe('from Discovery row (TMDB-only ID)', () => {
        const itemId = 'tmdb:54321';
        const type = 'series';
        const name = 'Some Show';

        test('item with TMDB ID added correctly', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            expect(traktBridge._watchlistIds.has('tmdb:54321')).toBe(true);
            const items = traktBridge.getWatchlistItems();
            expect(items.some((i) => i.id === itemId && i.tmdbId === 54321)).toBe(true);
        });

        test('persists after page refresh with API returning both IDs', async () => {
            await traktBridge.addToWatchlist(itemId, type, name);
            await simulatePageRefresh(buildSyncResponses({
                watchlistShows: [makeWatchlistShow('tt9999999', 54321, 'Some Show')],
            }));
            // After sync, the item now has an IMDB ID from the API
            const items = traktBridge.getWatchlistItems();
            expect(items.some((i) => i.imdbId === 'tt9999999' || i.tmdbId === 54321)).toBe(true);
        });
    });
});

// ─── 6. removeFromWatchlist ───

describe('removeFromWatchlist', () => {
    beforeEach(async () => {
        // Pre-populate watchlist with an item
        traktBridge._watchlistIds.add('tt0111161');
        traktBridge._watchlistIds.add('tmdb:389');
        traktBridge._watchlistItemsData = [{
            id: 'tt0111161', imdbId: 'tt0111161', tmdbId: 389,
            name: 'The Shawshank Redemption', type: 'movie',
            year: 1994, listedAt: '2026-03-28T10:00:00.000Z',
        }];
        traktBridge._rebuildDismissed();
    });

    test('item removed from getWatchlistItems before API returns', async () => {
        // Don't await — check immediately after the synchronous part
        const promise = traktBridge.removeFromWatchlist('tt0111161', 'movie');
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
        await promise;
    });

    test('item removed from _watchlistIds (parsed variants)', async () => {
        const promise = traktBridge.removeFromWatchlist('tt0111161', 'movie');
        expect(traktBridge._watchlistIds.has('tt0111161')).toBe(false);
        // tmdb:389 can't be derived from 'tt0111161' alone — cleaned up on next sync
        await promise;
    });

    test('_notify called for immediate UI update', async () => {
        const fn = jest.fn();
        traktBridge.onChange(fn);
        const promise = traktBridge.removeFromWatchlist('tt0111161', 'movie');
        expect(fn).toHaveBeenCalled();
        await promise;
    });

    test('rollback on API failure', async () => {
        mockFetch({ '/sync/watchlist/remove': 'FAIL' });
        await traktBridge.removeFromWatchlist('tt0111161', 'movie');
        // Item should be restored
        expect(traktBridge._watchlistIds.has('tt0111161')).toBe(true);
    });

    test('item absent after page refresh (API confirms removal)', async () => {
        await traktBridge.removeFromWatchlist('tt0111161', 'movie');
        await simulatePageRefresh(buildSyncResponses({
            watchlistMovies: [], // Item gone from API
        }));
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
        expect(traktBridge._watchlistIds.has('tt0111161')).toBe(false);
    });

    describe('ID format mismatch regression', () => {
        test('item stored with IMDB, removed by IMDB', async () => {
            await traktBridge.removeFromWatchlist('tt0111161', 'movie');
            expect(traktBridge.getWatchlistItems()).toHaveLength(0);
        });

        test('item with both IDs — filter catches via imdbId field', () => {
            traktBridge._watchlistItemsData = [{
                id: 'tt0111161', imdbId: 'tt0111161', tmdbId: 389,
                name: 'Test', type: 'movie', year: 2020, listedAt: null,
            }];
            // Remove using the IMDB ID
            traktBridge.removeFromWatchlist('tt0111161', 'movie');
            expect(traktBridge._watchlistItemsData).toHaveLength(0);
        });
    });
});

// ─── 7. addToNotInterested ───

describe('addToNotInterested', () => {
    describe('from Discovery row', () => {
        const itemId = 'tt0068646';
        const type = 'movie';
        const name = 'The Godfather';

        test('item appears in getNotInterestedItems immediately', async () => {
            await traktBridge.addToNotInterested(itemId, type, name);
            const items = traktBridge.getNotInterestedItems();
            expect(items.some((i) => i.id === itemId)).toBe(true);
        });

        test('item in getDismissedIds', async () => {
            await traktBridge.addToNotInterested(itemId, type, name);
            expect(traktBridge.isItemDismissed(itemId)).toBe(true);
        });

        test('persists after page refresh', async () => {
            await traktBridge.addToNotInterested(itemId, type, name);
            await simulatePageRefresh(buildSyncResponses({
                niItems: [makeNIEntry('tt0068646', 550, 'The Godfather')],
            }));
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === itemId)).toBe(true);
        });
    });

    describe('from Watchlist row (move Watchlist → NI)', () => {
        test('item ends up in NI list and dismissed', async () => {
            // First add to watchlist
            await traktBridge.addToWatchlist('tt0068646', 'movie', 'The Godfather');
            // Then move to NI
            await traktBridge.addToNotInterested('tt0068646', 'movie', 'The Godfather');
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === 'tt0068646')).toBe(true);
            expect(traktBridge.isItemDismissed('tt0068646')).toBe(true);
        });
    });

    test('throws if slug not configured', async () => {
        storage['trakt_not_interested_slug'] = '';
        traktBridge._notInterestedListSlug = '';
        await expect(traktBridge.addToNotInterested('tt0001', 'movie', 'Test'))
            .rejects.toThrow('Not Interested list slug not configured');
    });
});

// ─── 8. removeFromNotInterested ───

describe('removeFromNotInterested', () => {
    beforeEach(() => {
        traktBridge._notInterestedIds.add('tt0114369');
        traktBridge._notInterestedIds.add('tmdb:745');
        traktBridge._notInterestedItemsData = [{
            id: 'tt0114369', imdbId: 'tt0114369', tmdbId: 745,
            name: 'The Sixth Sense', type: 'movie',
            year: 1999, listedAt: '2026-03-28T10:00:00.000Z',
        }];
        traktBridge._rebuildDismissed();
    });

    test('item removed from getNotInterestedItems before API returns', async () => {
        const promise = traktBridge.removeFromNotInterested('tt0114369', 'movie');
        expect(traktBridge.getNotInterestedItems()).toHaveLength(0);
        await promise;
    });

    test('_notInterestedIds cleared for parsed variants', async () => {
        const promise = traktBridge.removeFromNotInterested('tt0114369', 'movie');
        expect(traktBridge._notInterestedIds.has('tt0114369')).toBe(false);
        // tmdb:745 can't be derived from 'tt0114369' alone — cleaned up on next sync
        await promise;
    });

    test('rollback on API failure', async () => {
        mockFetch({ '/users/me/lists/not-interested/items/remove': 'FAIL' });
        await traktBridge.removeFromNotInterested('tt0114369', 'movie');
        expect(traktBridge._notInterestedIds.has('tt0114369')).toBe(true);
    });

    test('item absent after page refresh (API confirms)', async () => {
        await traktBridge.removeFromNotInterested('tt0114369', 'movie');
        await simulatePageRefresh(buildSyncResponses({ niItems: [] }));
        expect(traktBridge.getNotInterestedItems()).toHaveLength(0);
    });

    describe('ID format mismatch regression', () => {
        test('TMDB-only item removed by tmdb: ID', () => {
            traktBridge._notInterestedIds = new Set(['tmdb:999']);
            traktBridge._notInterestedItemsData = [{
                id: 'tmdb:999', imdbId: null, tmdbId: 999,
                name: 'TMDB Movie', type: 'movie', year: 2020, listedAt: null,
            }];
            traktBridge.removeFromNotInterested('tmdb:999', 'movie');
            expect(traktBridge._notInterestedItemsData).toHaveLength(0);
        });

        test('item stored with IMDB primary, removed via IMDB ID', () => {
            // Default setup has item with id: 'tt0114369'
            traktBridge.removeFromNotInterested('tt0114369', 'movie');
            expect(traktBridge._notInterestedItemsData).toHaveLength(0);
        });

        test('filter matches via tmdbId field (number comparison)', () => {
            traktBridge._notInterestedItemsData = [{
                id: 'tt0114369', imdbId: 'tt0114369', tmdbId: 745,
                name: 'The Sixth Sense', type: 'movie', year: 1999, listedAt: null,
            }];
            // Remove using IMDB ID — should match via w.imdbId === imdb
            traktBridge.removeFromNotInterested('tt0114369', 'movie');
            expect(traktBridge._notInterestedItemsData).toHaveLength(0);
        });
    });
});

// ─── 9. markWatched ───

describe('markWatched', () => {
    describe('from Discovery row (Already Watched button)', () => {
        const itemId = 'tt0110912';
        const type = 'movie';
        const name = 'Pulp Fiction';

        test('REGRESSION: item in getWatchedNotRated BEFORE API returns', () => {
            // Call markWatched but do NOT await — simulates user skipping rating fast
            traktBridge.markWatched(itemId, type, name);
            // Item must be in watched data immediately (optimistic)
            const unrated = traktBridge.getWatchedNotRated();
            expect(unrated.some((i) => i.id === itemId)).toBe(true);
            expect(unrated.find((i) => i.id === itemId).name).toBe(name);
        });

        test('REGRESSION: item NOT added to _watchedIds (would kill rating overlay)', () => {
            traktBridge.markWatched(itemId, type, name);
            expect(traktBridge._watchedIds.has(itemId)).toBe(false);
        });

        test('REGRESSION: getDismissedIds does NOT include item after markWatched', () => {
            traktBridge.markWatched(itemId, type, name);
            expect(traktBridge.isItemDismissed(itemId)).toBe(false);
        });

        test('_notify called immediately for Watched (Not Rated) row update', () => {
            const fn = jest.fn();
            traktBridge.onChange(fn);
            traktBridge.markWatched(itemId, type, name);
            expect(fn).toHaveBeenCalled();
        });

        test('duplicate markWatched does not create duplicate entries', async () => {
            await traktBridge.markWatched(itemId, type, name);
            await traktBridge.markWatched(itemId, type, name);
            expect(traktBridge._watchedItemsData.filter((i) => i.id === itemId)).toHaveLength(1);
        });

        test('item persists after page refresh (API confirms watched, not rated)', async () => {
            await traktBridge.markWatched(itemId, type, name);
            await simulatePageRefresh(buildSyncResponses({
                watchedMovies: [makeWatchedMovie('tt0110912', 680, 'Pulp Fiction', '2026-03-28T14:30:00.000Z')],
                ratedMovies: [], // NOT rated
            }));
            const unrated = traktBridge.getWatchedNotRated();
            expect(unrated.some((i) => i.id === itemId)).toBe(true);
        });

        test('item disappears from Watched (Not Rated) after rating + page refresh', async () => {
            await traktBridge.markWatched(itemId, type, name);
            await traktBridge.rateItem(itemId, type, 4);
            await simulatePageRefresh(buildSyncResponses({
                watchedMovies: [makeWatchedMovie('tt0110912', 680, 'Pulp Fiction')],
                ratedMovies: [makeRatingMovie('tt0110912', 680, 'Pulp Fiction', 8)],
            }));
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === itemId)).toBe(false);
        });
    });

    describe('from Discovery row (TMDB-only ID)', () => {
        test('item in getWatchedNotRated immediately', () => {
            traktBridge.markWatched('tmdb:550', 'movie', 'Fight Club');
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tmdb:550')).toBe(true);
        });
    });

    describe('show type', () => {
        test('show appears in getWatchedNotRated', () => {
            traktBridge.markWatched('tt0903747', 'series', 'Breaking Bad');
            const result = traktBridge.getWatchedNotRated();
            expect(result.some((i) => i.id === 'tt0903747' && i.type === 'series')).toBe(true);
        });
    });
});

// ─── 10. rateItem ───

describe('rateItem', () => {
    beforeEach(async () => {
        // Put item in watched first
        await traktBridge.markWatched('tt0111161', 'movie', 'The Shawshank Redemption');
    });

    test('rating 3 stars maps to Trakt rating 6', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 3);
        // Verify the POST body
        const postCalls = global.fetch.mock.calls.filter(
            ([url, opts]) => opts?.method === 'POST' && url.includes('/sync/ratings')
        );
        expect(postCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(postCalls[postCalls.length - 1][1].body);
        expect(body.movies[0].rating).toBe(6);
    });

    test('rating 5 stars maps to Trakt rating 10', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 5);
        const postCalls = global.fetch.mock.calls.filter(
            ([url, opts]) => opts?.method === 'POST' && url.includes('/sync/ratings')
        );
        const body = JSON.parse(postCalls[postCalls.length - 1][1].body);
        expect(body.movies[0].rating).toBe(10);
    });

    test('item added to _ratedIds', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        expect(traktBridge._ratedIds.has('tt0111161')).toBe(true);
    });

    test('IMDB ID added to _ratedImdbIds', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        expect(traktBridge._ratedImdbIds.has('tt0111161')).toBe(true);
    });

    test('TMDB ID added to _ratedTmdbIds', async () => {
        await traktBridge.rateItem('tmdb:550', 'movie', 4);
        expect(traktBridge._ratedTmdbIds.has(550)).toBe(true);
    });

    test('item removed from getWatchedNotRated after rating', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0111161')).toBe(false);
    });

    test('item in getDismissedIds after rating', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        expect(traktBridge.isItemDismissed('tt0111161')).toBe(true);
    });

    test('rated status persists after page refresh', async () => {
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        await simulatePageRefresh(buildSyncResponses({
            watchedMovies: [makeWatchedMovie('tt0111161', 389, 'The Shawshank Redemption')],
            ratedMovies: [makeRatingMovie('tt0111161', 389, 'The Shawshank Redemption', 8)],
        }));
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0111161')).toBe(false);
        expect(traktBridge._ratedImdbIds.has('tt0111161')).toBe(true);
    });
});

// ─── 11. dismissWatched ───

describe('dismissWatched', () => {
    test('adds item to _watchedIds', () => {
        traktBridge.dismissWatched('tt0111161');
        expect(traktBridge._watchedIds.has('tt0111161')).toBe(true);
    });

    test('item now in getDismissedIds', () => {
        traktBridge.dismissWatched('tt0111161');
        expect(traktBridge.isItemDismissed('tt0111161')).toBe(true);
    });

    test('_notify called', () => {
        const fn = jest.fn();
        traktBridge.onChange(fn);
        traktBridge.dismissWatched('tt0111161');
        expect(fn).toHaveBeenCalled();
    });

    test('REGRESSION: markWatched + dismissWatched = item in both _watchedItemsData and _watchedIds', () => {
        traktBridge.markWatched('tt0110912', 'movie', 'Pulp Fiction');
        // At this point: in _watchedItemsData, NOT in _watchedIds
        expect(traktBridge._watchedIds.has('tt0110912')).toBe(false);
        // User finishes with rating overlay
        traktBridge.dismissWatched('tt0110912');
        // Now in both
        expect(traktBridge._watchedIds.has('tt0110912')).toBe(true);
        expect(traktBridge._watchedItemsData.some((i) => i.id === 'tt0110912')).toBe(true);
    });
});

// ─── 12. _scheduleRefresh debouncing ───

describe('_scheduleRefresh', () => {
    test('debounces multiple rapid calls', () => {
        const spy = jest.spyOn(traktBridge, '_refreshWatchlistData').mockResolvedValue();
        traktBridge._scheduleRefresh('watchlist');
        traktBridge._scheduleRefresh('watchlist');
        traktBridge._scheduleRefresh('watchlist');
        jest.advanceTimersByTime(1500);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    test('does not fire before 1500ms', () => {
        const spy = jest.spyOn(traktBridge, '_refreshWatchlistData').mockResolvedValue();
        traktBridge._scheduleRefresh('watchlist');
        jest.advanceTimersByTime(1499);
        expect(spy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    test('watched refresh is triggered after markWatched', async () => {
        const spy = jest.spyOn(traktBridge, '_refreshWatchedData').mockResolvedValue();
        await traktBridge.markWatched('tt0111161', 'movie', 'Test');
        jest.advanceTimersByTime(1500);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    test('watched refresh is triggered after rateItem', async () => {
        const spy = jest.spyOn(traktBridge, '_refreshWatchedData').mockResolvedValue();
        await traktBridge.rateItem('tt0111161', 'movie', 4);
        jest.advanceTimersByTime(1500);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

// ─── 13. _doSync (page refresh simulation) ───

describe('_doSync / page refresh', () => {
    test('populates all lists from API', async () => {
        await simulatePageRefresh(buildSyncResponses({
            ratedMovies: [makeRatingMovie('tt0001', 100, 'RatedMovie', 8)],
            ratedShows: [makeRatingShow('tt0002', 200, 'RatedShow', 7)],
            watchedMovies: [makeWatchedMovie('tt0003', 300, 'WatchedMovie')],
            watchedShows: [makeWatchedShow('tt0004', 400, 'WatchedShow')],
            watchlistMovies: [makeWatchlistMovie('tt0005', 500, 'WatchlistMovie')],
            watchlistShows: [makeWatchlistShow('tt0006', 600, 'WatchlistShow')],
            niItems: [makeNIEntry('tt0007', 700, 'NIMovie')],
        }));

        expect(traktBridge._ratedIds.has('tt0001')).toBe(true);
        expect(traktBridge._ratedIds.has('tt0002')).toBe(true);
        expect(traktBridge._watchedIds.has('tt0003')).toBe(true);
        expect(traktBridge._watchedIds.has('tt0004')).toBe(true);
        expect(traktBridge._watchlistIds.has('tt0005')).toBe(true);
        expect(traktBridge._watchlistIds.has('tt0006')).toBe(true);
        expect(traktBridge._notInterestedIds.has('tt0007')).toBe(true);
        expect(traktBridge._watchedItemsData).toHaveLength(2);
        expect(traktBridge._watchlistItemsData).toHaveLength(2);
        expect(traktBridge._notInterestedItemsData).toHaveLength(1);
    });

    test('watched items include both movies and shows after sync', async () => {
        await simulatePageRefresh(buildSyncResponses({
            watchedMovies: [
                makeWatchedMovie('tt0001', 100, 'MovieA'),
                makeWatchedMovie('tt0002', 200, 'MovieB'),
            ],
            watchedShows: [
                makeWatchedShow('tt0003', 300, 'ShowA'),
            ],
        }));
        const movies = traktBridge._watchedItemsData.filter((i) => i.type === 'movie');
        const shows = traktBridge._watchedItemsData.filter((i) => i.type === 'series');
        expect(movies).toHaveLength(2);
        expect(shows).toHaveLength(1);
    });

    test('deduplicates items with both IMDB and TMDB IDs', async () => {
        await simulatePageRefresh(buildSyncResponses({
            watchedMovies: [makeWatchedMovie('tt0111161', 389, 'The Shawshank Redemption')],
        }));
        // Both ID formats should be in _watchedIds
        expect(traktBridge._watchedIds.has('tt0111161')).toBe(true);
        expect(traktBridge._watchedIds.has('tmdb:389')).toBe(true);
        // But only one entry in data array
        expect(traktBridge._watchedItemsData).toHaveLength(1);
    });

    test('dismissed IDs built correctly from all sources', async () => {
        await simulatePageRefresh(buildSyncResponses({
            ratedMovies: [makeRatingMovie('tt0001', 100, 'Rated')],
            watchedMovies: [makeWatchedMovie('tt0002', 200, 'Watched')],
            watchlistMovies: [makeWatchlistMovie('tt0003', 300, 'Watchlisted')],
            niItems: [makeNIEntry('tt0004', 400, 'NotInterested')],
        }));
        expect(traktBridge.isItemDismissed('tt0001')).toBe(true);
        expect(traktBridge.isItemDismissed('tt0002')).toBe(true);
        expect(traktBridge.isItemDismissed('tt0003')).toBe(true);
        expect(traktBridge.isItemDismissed('tt0004')).toBe(true);
        expect(traktBridge.isItemDismissed('tt9999')).toBe(false);
    });

    test('Not Interested items sorted by listedAt descending', async () => {
        await simulatePageRefresh(buildSyncResponses({
            niItems: [
                makeNIEntry('tt0001', 100, 'OldItem', false, '2026-03-01T00:00:00.000Z'),
                makeNIEntry('tt0002', 200, 'NewItem', false, '2026-03-28T00:00:00.000Z'),
                makeNIEntry('tt0003', 300, 'MidItem', false, '2026-03-15T00:00:00.000Z'),
            ],
        }));
        const ni = traktBridge.getNotInterestedItems();
        expect(ni[0].name).toBe('NewItem');
        expect(ni[1].name).toBe('MidItem');
        expect(ni[2].name).toBe('OldItem');
    });
});

// ─── 14. _refreshWatchedData ───

describe('_refreshWatchedData', () => {
    test('updates _watchedItemsData from API', async () => {
        mockFetch({
            '/sync/watched/movies': [makeWatchedMovie('tt0001', 100, 'MovieA')],
            '/sync/watched/shows': [makeWatchedShow('tt0002', 200, 'ShowA')],
            '/sync/ratings/movies': [],
            '/sync/ratings/shows': [],
        });
        await traktBridge._refreshWatchedData();
        expect(traktBridge._watchedItemsData).toHaveLength(2);
        expect(traktBridge._watchedIds.has('tt0001')).toBe(true);
        expect(traktBridge._watchedIds.has('tt0002')).toBe(true);
    });

    test('updates rated IDs from API', async () => {
        mockFetch({
            '/sync/watched/movies': [],
            '/sync/watched/shows': [],
            '/sync/ratings/movies': [makeRatingMovie('tt0001', 100, 'RatedA')],
            '/sync/ratings/shows': [makeRatingShow('tt0002', 200, 'RatedB')],
        });
        await traktBridge._refreshWatchedData();
        expect(traktBridge._ratedImdbIds.has('tt0001')).toBe(true);
        expect(traktBridge._ratedImdbIds.has('tt0002')).toBe(true);
    });

    test('rebuilds dismissed and notifies', async () => {
        const fn = jest.fn();
        traktBridge.onChange(fn);
        mockFetch({
            '/sync/watched/movies': [makeWatchedMovie('tt0001', 100, 'A')],
            '/sync/watched/shows': [],
            '/sync/ratings/movies': [],
            '/sync/ratings/shows': [],
        });
        await traktBridge._refreshWatchedData();
        expect(fn).toHaveBeenCalled();
        expect(traktBridge.isItemDismissed('tt0001')).toBe(true);
    });
});

// ─── 15. Cross-operation integration scenarios ───

describe('Cross-operation workflows', () => {
    describe('Discovery → Already Watched → Rate', () => {
        test('item goes through full lifecycle', async () => {
            const id = 'tt0111161';
            // 1. Mark as watched
            await traktBridge.markWatched(id, 'movie', 'The Shawshank Redemption');
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(true);
            expect(traktBridge.isItemDismissed(id)).toBe(false); // Overlay still visible

            // 2. Rate it
            await traktBridge.rateItem(id, 'movie', 5);
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(false);
            expect(traktBridge.isItemDismissed(id)).toBe(true);

            // 3. Dismiss (user closed overlay)
            traktBridge.dismissWatched(id);
            expect(traktBridge._watchedIds.has(id)).toBe(true);

            // 4. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                watchedMovies: [makeWatchedMovie('tt0111161', 389, 'The Shawshank Redemption')],
                ratedMovies: [makeRatingMovie('tt0111161', 389, 'The Shawshank Redemption', 10)],
            }));
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(false);
            expect(traktBridge._ratedImdbIds.has(id)).toBe(true);
        });
    });

    describe('Discovery → Already Watched → Skip Rating', () => {
        test('item stays in Watched (Not Rated) after skip and refresh', async () => {
            const id = 'tt0110912';
            // 1. Mark as watched (don't await — user skips fast)
            traktBridge.markWatched(id, 'movie', 'Pulp Fiction');

            // 2. Skip rating
            traktBridge.dismissWatched(id);
            expect(traktBridge._watchedIds.has(id)).toBe(true);
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(true);

            // 3. Page refresh — watched but not rated on server
            await simulatePageRefresh(buildSyncResponses({
                watchedMovies: [makeWatchedMovie('tt0110912', 680, 'Pulp Fiction')],
                ratedMovies: [], // NOT rated
            }));
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(true);
        });
    });

    describe('Watchlist → Not Interested (move via "-" button)', () => {
        test('item moves from watchlist to NI', async () => {
            const id = 'tt0068646';
            // 1. Start in watchlist
            await traktBridge.addToWatchlist(id, 'movie', 'The Godfather');
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);

            // 2. Remove from watchlist
            await traktBridge.removeFromWatchlist(id, 'movie');
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(false);

            // 3. Add to NI
            await traktBridge.addToNotInterested(id, 'movie', 'The Godfather');
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === id)).toBe(true);

            // 4. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                watchlistMovies: [], // Gone from watchlist
                niItems: [makeNIEntry('tt0068646', 550, 'The Godfather')],
            }));
            expect(traktBridge.getWatchlistItems()).toHaveLength(0);
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === id)).toBe(true);
        });
    });

    describe('Not Interested → Watchlist (rescue via "+" button)', () => {
        test('item moves from NI to watchlist', async () => {
            const id = 'tt0114369';
            // 1. Start in NI
            await traktBridge.addToNotInterested(id, 'movie', 'The Sixth Sense');
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === id)).toBe(true);

            // 2. Remove from NI
            await traktBridge.removeFromNotInterested(id, 'movie');
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === id)).toBe(false);

            // 3. Add to watchlist
            await traktBridge.addToWatchlist(id, 'movie', 'The Sixth Sense');
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);

            // 4. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                niItems: [], // Gone from NI
                watchlistMovies: [makeWatchlistMovie('tt0114369', 745, 'The Sixth Sense')],
            }));
            expect(traktBridge.getNotInterestedItems()).toHaveLength(0);
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);
        });
    });

    describe('Rate from Watched (Not Rated) row', () => {
        test('item leaves Watched (Not Rated) row after rating and refresh', async () => {
            const id = 'tt0903747';
            // 1. Item is watched but not rated (from sync)
            await simulatePageRefresh(buildSyncResponses({
                watchedShows: [makeWatchedShow('tt0903747', 1396, 'Breaking Bad')],
            }));
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(true);

            // 2. User rates it
            await traktBridge.rateItem(id, 'series', 5);
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(false);

            // 3. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                watchedShows: [makeWatchedShow('tt0903747', 1396, 'Breaking Bad')],
                ratedShows: [makeRatingShow('tt0903747', 1396, 'Breaking Bad', 10)],
            }));
            expect(traktBridge.getWatchedNotRated().some((i) => i.id === id)).toBe(false);
        });
    });

    describe('Full cycle: Discovery → Watchlist → remove → NI → remove → Watchlist again', () => {
        test('item survives full round-trip with page refreshes', async () => {
            const id = 'tt0133093';
            const name = 'The Matrix';

            // 1. Add to watchlist
            await traktBridge.addToWatchlist(id, 'movie', name);
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);

            // 2. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                watchlistMovies: [makeWatchlistMovie('tt0133093', 603, 'The Matrix')],
            }));
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);

            // 3. Move to NI
            await traktBridge.removeFromWatchlist(id, 'movie');
            await traktBridge.addToNotInterested(id, 'movie', name);

            // 4. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                watchlistMovies: [],
                niItems: [makeNIEntry('tt0133093', 603, 'The Matrix')],
            }));
            expect(traktBridge.getWatchlistItems()).toHaveLength(0);
            expect(traktBridge.getNotInterestedItems().some((i) => i.id === id)).toBe(true);

            // 5. Rescue back to watchlist
            await traktBridge.removeFromNotInterested(id, 'movie');
            await traktBridge.addToWatchlist(id, 'movie', name);

            // 6. Page refresh
            await simulatePageRefresh(buildSyncResponses({
                niItems: [],
                watchlistMovies: [makeWatchlistMovie('tt0133093', 603, 'The Matrix')],
            }));
            expect(traktBridge.getNotInterestedItems()).toHaveLength(0);
            expect(traktBridge.getWatchlistItems().some((i) => i.id === id)).toBe(true);
        });
    });
});

// ─── 16. ID format consistency regression ───

describe('ID format consistency', () => {
    test('IMDB item added and removed by IMDB ID', async () => {
        await traktBridge.addToWatchlist('tt0111161', 'movie', 'Test');
        await traktBridge.removeFromWatchlist('tt0111161', 'movie');
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
    });

    test('TMDB-only item added and removed by tmdb: ID', async () => {
        await traktBridge.addToWatchlist('tmdb:12345', 'movie', 'Test');
        await traktBridge.removeFromWatchlist('tmdb:12345', 'movie');
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
    });

    test('API returns item with both IDs, removeFromWatchlist with IMDB clears item from data', async () => {
        // Simulate sync that populates with both IDs
        await simulatePageRefresh(buildSyncResponses({
            watchlistMovies: [makeWatchlistMovie('tt0111161', 389, 'The Shawshank Redemption')],
        }));
        expect(traktBridge._watchlistIds.has('tt0111161')).toBe(true);
        expect(traktBridge._watchlistIds.has('tmdb:389')).toBe(true);

        await traktBridge.removeFromWatchlist('tt0111161', 'movie');
        // Item removed from data array (the important part for UI)
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
        expect(traktBridge._watchlistIds.has('tt0111161')).toBe(false);
        // tmdb:389 stale entry cleaned up on next sync
        await simulatePageRefresh(buildSyncResponses({ watchlistMovies: [] }));
        expect(traktBridge._watchlistIds.has('tmdb:389')).toBe(false);
    });

    test('NI: item stored with IMDB primary, tmdbId as number — filter matches', async () => {
        await simulatePageRefresh(buildSyncResponses({
            niItems: [makeNIEntry('tt0114369', 745, 'The Sixth Sense')],
        }));
        // Remove using IMDB ID
        await traktBridge.removeFromNotInterested('tt0114369', 'movie');
        expect(traktBridge.getNotInterestedItems()).toHaveLength(0);
    });

    test('mixed: addToWatchlist with IMDB, sync returns both, remove with IMDB', async () => {
        await traktBridge.addToWatchlist('tt0068646', 'movie', 'The Godfather');
        // Sync brings in both IDs
        await simulatePageRefresh(buildSyncResponses({
            watchlistMovies: [makeWatchlistMovie('tt0068646', 238, 'The Godfather')],
        }));
        const items = traktBridge.getWatchlistItems();
        expect(items).toHaveLength(1);
        expect(items[0].imdbId).toBe('tt0068646');
        expect(items[0].tmdbId).toBe(238);

        // Remove with IMDB
        await traktBridge.removeFromWatchlist('tt0068646', 'movie');
        expect(traktBridge.getWatchlistItems()).toHaveLength(0);
    });
});

// ─── 17. Shows across all operations ───

describe('Show operations (parity with movies)', () => {
    test('addToWatchlist for shows', async () => {
        await traktBridge.addToWatchlist('tt0903747', 'series', 'Breaking Bad');
        const items = traktBridge.getWatchlistItems();
        expect(items.some((i) => i.id === 'tt0903747' && i.type === 'series')).toBe(true);
    });

    test('addToNotInterested for shows', async () => {
        await traktBridge.addToNotInterested('tt0903747', 'series', 'Breaking Bad');
        const items = traktBridge.getNotInterestedItems();
        expect(items.some((i) => i.id === 'tt0903747' && i.type === 'series')).toBe(true);
    });

    test('markWatched for shows', () => {
        traktBridge.markWatched('tt0903747', 'series', 'Breaking Bad');
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0903747' && i.type === 'series')).toBe(true);
    });

    test('rateItem for shows', async () => {
        await traktBridge.markWatched('tt0903747', 'series', 'Breaking Bad');
        await traktBridge.rateItem('tt0903747', 'series', 4);
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0903747')).toBe(false);
        expect(traktBridge._ratedIds.has('tt0903747')).toBe(true);
    });

    test('show watchlist survives page refresh', async () => {
        await traktBridge.addToWatchlist('tt0903747', 'series', 'Breaking Bad');
        await simulatePageRefresh(buildSyncResponses({
            watchlistShows: [makeWatchlistShow('tt0903747', 1396, 'Breaking Bad')],
        }));
        expect(traktBridge.getWatchlistItems().some((i) => i.id === 'tt0903747')).toBe(true);
    });

    test('show NI survives page refresh', async () => {
        await traktBridge.addToNotInterested('tt0903747', 'series', 'Breaking Bad');
        await simulatePageRefresh(buildSyncResponses({
            niItems: [makeNIEntry('tt0903747', 1396, 'Breaking Bad', true)],
        }));
        expect(traktBridge.getNotInterestedItems().some((i) => i.id === 'tt0903747')).toBe(true);
    });

    test('show watched not rated survives page refresh', async () => {
        await traktBridge.markWatched('tt0903747', 'series', 'Breaking Bad');
        await simulatePageRefresh(buildSyncResponses({
            watchedShows: [makeWatchedShow('tt0903747', 1396, 'Breaking Bad')],
        }));
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0903747')).toBe(true);
    });
});

// ─── 18. Multiple items — verify one operation doesn't affect others ───

describe('Isolation — operations on one item do not affect others', () => {
    test('removing one watchlist item does not remove others', async () => {
        await traktBridge.addToWatchlist('tt0001', 'movie', 'MovieA');
        await traktBridge.addToWatchlist('tt0002', 'movie', 'MovieB');
        await traktBridge.addToWatchlist('tt0003', 'movie', 'MovieC');

        await traktBridge.removeFromWatchlist('tt0002', 'movie');
        const items = traktBridge.getWatchlistItems();
        expect(items).toHaveLength(2);
        expect(items.some((i) => i.id === 'tt0001')).toBe(true);
        expect(items.some((i) => i.id === 'tt0003')).toBe(true);
        expect(items.some((i) => i.id === 'tt0002')).toBe(false);
    });

    test('removing one NI item does not remove others', async () => {
        await traktBridge.addToNotInterested('tt0001', 'movie', 'MovieA');
        await traktBridge.addToNotInterested('tt0002', 'movie', 'MovieB');

        await traktBridge.removeFromNotInterested('tt0001', 'movie');
        const items = traktBridge.getNotInterestedItems();
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('tt0002');
    });

    test('rating one item does not affect other unrated items', async () => {
        await traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        await traktBridge.markWatched('tt0002', 'movie', 'MovieB');

        await traktBridge.rateItem('tt0001', 'movie', 4);
        const unrated = traktBridge.getWatchedNotRated();
        expect(unrated).toHaveLength(1);
        expect(unrated[0].id).toBe('tt0002');
    });

    test('isolation persists after page refresh', async () => {
        await traktBridge.addToWatchlist('tt0001', 'movie', 'MovieA');
        await traktBridge.addToWatchlist('tt0002', 'movie', 'MovieB');
        await traktBridge.removeFromWatchlist('tt0002', 'movie');

        await simulatePageRefresh(buildSyncResponses({
            watchlistMovies: [makeWatchlistMovie('tt0001', 100, 'MovieA')],
        }));
        expect(traktBridge.getWatchlistItems()).toHaveLength(1);
        expect(traktBridge.getWatchlistItems()[0].id).toBe('tt0001');
    });
});

// ═══════════════════════════════════════════════════════════════
// 19. Board-level filtering tests
//
// Tests the filterCatalogItems and filterItems functions that the Board uses
// to filter discovery rows, recommendation rows, etc. These are extracted
// from Board.js for unit testing. The key rules:
//
//   - Discovery/catalog rows: filtered by combinedDismissedSet (rated+watched+watchlist+NI+library+names)
//   - Recommendation rows (TMDB, Trakt): filtered same way
//   - Watchlist row: NOT filtered by dismissed — shows all watchlist items
//   - Watched (Not Rated) row: NOT filtered by dismissed — shows all unrated
//   - Not Interested row: NOT filtered by dismissed — shows all NI items
//   - Deduplication: same name across rows should be filtered from later rows
// ═══════════════════════════════════════════════════════════════

// Re-implement the Board filtering functions here for unit testing
// (they are not exported from Board.js)
function filterCatalogItems(catalog, dismissedSet, seenNames) {
    if (catalog.content?.type !== 'Ready' || !Array.isArray(catalog.content.content)) return catalog;
    const filtered = catalog.content.content.filter((item) => {
        if (dismissedSet.size > 0 && dismissedSet.has(item.id)) return false;
        if (seenNames && item.name) {
            const key = item.name.toLowerCase().trim();
            if (seenNames.has(key)) return false;
            seenNames.add(key);
        }
        return true;
    });
    if (filtered.length === catalog.content.content.length) return catalog;
    if (filtered.length === 0) return null;
    return { ...catalog, content: { ...catalog.content, content: filtered } };
}

function filterItems(items, dismissedSet, seenNames) {
    return items.filter((item) => {
        if (dismissedSet.size > 0 && dismissedSet.has(item.id)) return false;
        if (seenNames && item.name) {
            const key = item.name.toLowerCase().trim();
            if (seenNames.has(key)) return false;
            seenNames.add(key);
        }
        return true;
    });
}

// Build a combinedDismissedSet that mirrors Board.js logic
function buildCombinedDismissedSet(dismissedIds, libraryIds, niIds, dismissedNames) {
    return {
        size: dismissedIds.size + libraryIds.size + niIds.size + dismissedNames.size,
        has(id) {
            return dismissedIds.has(id) || libraryIds.has(id) || niIds.has(id);
        },
        hasItem(item) {
            if (dismissedIds.has(item.id)) return true;
            if (libraryIds.has(item.id)) return true;
            if (niIds.has(item.id)) return true;
            if (item.name && dismissedNames.has(item.name.toLowerCase().trim())) return true;
            return false;
        },
    };
}

function makeCatalog(items) {
    return { content: { type: 'Ready', content: items } };
}

function makeMetaItem(id, name, type = 'movie') {
    return { id, name, type, poster: '', posterShape: 'landscape' };
}

// ─── filterCatalogItems (Discovery / addon catalog rows) ───

describe('filterCatalogItems — Discovery rows', () => {
    test('does not filter items that are not dismissed', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'MovieA'),
            makeMetaItem('tt0002', 'MovieB'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(2);
    });

    test('filters out rated items', () => {
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'RatedMovie'),
            makeMetaItem('tt0002', 'UnratedMovie'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });

    test('filters out watched items', () => {
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'WatchedMovie'),
            makeMetaItem('tt0002', 'NotWatched'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });

    test('filters out watchlisted items', () => {
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'WatchlistedMovie'),
            makeMetaItem('tt0002', 'Other'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
    });

    test('filters out Not Interested items by NI ID set', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(['tt0001']), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'NIMovie'),
            makeMetaItem('tt0002', 'Other'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });

    test('filters out library items', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(['tt0001']), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'LibraryMovie'),
            makeMetaItem('tt0002', 'Other'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
    });

    test('returns null when all items are filtered', () => {
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001', 'tt0002']), new Set(), new Set(), new Set());
        const catalog = makeCatalog([
            makeMetaItem('tt0001', 'A'),
            makeMetaItem('tt0002', 'B'),
        ]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result).toBeNull();
    });

    test('returns original catalog when nothing is filtered', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const catalog = makeCatalog([makeMetaItem('tt0001', 'A')]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result).toBe(catalog); // Same reference — no copy needed
    });

    test('handles non-Ready catalog gracefully', () => {
        const catalog = { content: { type: 'Loading' } };
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), new Set());
        expect(filterCatalogItems(catalog, dismissed, new Set())).toBe(catalog);
    });
});

// ─── filterItems (TMDB recommendation rows, Trakt recommendation rows) ───

describe('filterItems — Recommendation rows', () => {
    test('filters dismissed items from TMDB recommendations', () => {
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), new Set());
        const items = [makeMetaItem('tt0001', 'Dismissed'), makeMetaItem('tt0002', 'Kept')];
        const result = filterItems(items, dismissed, new Set());
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('tt0002');
    });

    test('filters NI items from recommendations', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(['tt0001']), new Set());
        const items = [makeMetaItem('tt0001', 'NI'), makeMetaItem('tt0002', 'Good')];
        const result = filterItems(items, dismissed, new Set());
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('tt0002');
    });

    test('filters library items from recommendations', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(['tt0001']), new Set(), new Set());
        const items = [makeMetaItem('tt0001', 'InLibrary'), makeMetaItem('tt0002', 'New')];
        const result = filterItems(items, dismissed, new Set());
        expect(result).toHaveLength(1);
    });

    test('does not filter undismissed items', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const items = [makeMetaItem('tt0001', 'A'), makeMetaItem('tt0002', 'B')];
        const result = filterItems(items, dismissed, new Set());
        expect(result).toHaveLength(2);
    });
});

// ─── Deduplication across rows ───

describe('Deduplication via seenNames', () => {
    test('same name in two catalogs — second occurrence is filtered', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const seenNames = new Set();
        const cat1 = makeCatalog([makeMetaItem('tt0001', 'The Matrix')]);
        const cat2 = makeCatalog([makeMetaItem('tt0002', 'The Matrix')]); // Different ID, same name

        filterCatalogItems(cat1, dismissed, seenNames);
        const result2 = filterCatalogItems(cat2, dismissed, seenNames);
        expect(result2).toBeNull(); // All items filtered → null
    });

    test('name dedup is case-insensitive', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const seenNames = new Set();
        filterCatalogItems(makeCatalog([makeMetaItem('tt0001', 'The Matrix')]), dismissed, seenNames);
        const result = filterCatalogItems(makeCatalog([makeMetaItem('tt0002', 'the matrix')]), dismissed, seenNames);
        expect(result).toBeNull();
    });

    test('different names are not deduped', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const seenNames = new Set();
        filterCatalogItems(makeCatalog([makeMetaItem('tt0001', 'Movie A')]), dismissed, seenNames);
        const result = filterCatalogItems(makeCatalog([makeMetaItem('tt0002', 'Movie B')]), dismissed, seenNames);
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].name).toBe('Movie B');
    });

    test('dedup works across filterItems too', () => {
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), new Set());
        const seenNames = new Set();
        // First in a catalog
        filterCatalogItems(makeCatalog([makeMetaItem('tt0001', 'Inception')]), dismissed, seenNames);
        // Same name in a recommendation row
        const result = filterItems([makeMetaItem('tt0002', 'Inception')], dismissed, seenNames);
        expect(result).toHaveLength(0);
    });
});

// ─── Watchlist row is NOT filtered by dismissed ───

describe('Watchlist row — NOT filtered by dismissed', () => {
    test('watchlist items are NOT passed through filterCatalogItems/filterItems', async () => {
        // This tests the principle: watchlist items should show even if
        // the item is in _allDismissedIds (which it is, since _watchlistIds
        // is part of _allDismissedIds). The Board renders them directly
        // without filtering.
        await simulatePageRefresh(buildSyncResponses({
            watchlistMovies: [makeWatchlistMovie('tt0001', 100, 'WatchlistMovie')],
        }));
        // Item IS in dismissed (via _watchlistIds → _allDismissedIds)
        expect(traktBridge.isItemDismissed('tt0001')).toBe(true);
        // But getWatchlistItems still returns it (no filtering applied)
        expect(traktBridge.getWatchlistItems().some((i) => i.id === 'tt0001')).toBe(true);

        // If someone mistakenly passed watchlist through filterItems, it would disappear:
        const dismissed = traktBridge.getDismissedIds();
        const filtered = filterItems(
            traktBridge.getWatchlistItems().map((i) => makeMetaItem(i.id, i.name)),
            { size: dismissed.size, has: (id) => dismissed.has(id) },
            new Set()
        );
        // This proves filterItems WOULD remove it — so the Board must NOT filter watchlist
        expect(filtered).toHaveLength(0);
    });
});

// ─── Watched (Not Rated) row is NOT filtered by dismissed ───

describe('Watched (Not Rated) row — NOT filtered by dismissed', () => {
    test('watched-not-rated items show even though they are not in _watchedIds after markWatched', () => {
        traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        // NOT dismissed yet (no dismissWatched called)
        expect(traktBridge.isItemDismissed('tt0001')).toBe(false);
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0001')).toBe(true);
    });

    test('after dismissWatched, item is dismissed but still in getWatchedNotRated (if not rated)', () => {
        traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        traktBridge.dismissWatched('tt0001');
        // Now dismissed
        expect(traktBridge.isItemDismissed('tt0001')).toBe(true);
        // But still in watched not rated (not filtered by dismissed)
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0001')).toBe(true);
    });

    test('item only leaves Watched (Not Rated) when rated', async () => {
        traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        traktBridge.dismissWatched('tt0001');
        // Still there
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0001')).toBe(true);
        // Rate it
        await traktBridge.rateItem('tt0001', 'movie', 4);
        // Now gone
        expect(traktBridge.getWatchedNotRated().some((i) => i.id === 'tt0001')).toBe(false);
    });
});

// ─── Not Interested row is NOT filtered by dismissed ───

describe('Not Interested row — NOT filtered by dismissed', () => {
    test('NI items show even though they are in _allDismissedIds', async () => {
        await traktBridge.addToNotInterested('tt0001', 'movie', 'NIMovie');
        expect(traktBridge.isItemDismissed('tt0001')).toBe(true);
        expect(traktBridge.getNotInterestedItems().some((i) => i.id === 'tt0001')).toBe(true);
    });

    test('NI items should be filtered from discovery rows', async () => {
        await traktBridge.addToNotInterested('tt0001', 'movie', 'NIMovie');
        const dismissed = buildCombinedDismissedSet(
            traktBridge.getDismissedIds(), new Set(), new Set(['tt0001']), new Set()
        );
        const catalog = makeCatalog([makeMetaItem('tt0001', 'NIMovie'), makeMetaItem('tt0002', 'Other')]);
        const result = filterCatalogItems(catalog, dismissed, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });
});

// ─── Dismissed name-based cross-ID filtering ───

describe('Name-based cross-ID filtering (dismissedNames)', () => {
    test('item with different ID but same name as dismissed item is filtered', () => {
        // Item 'tt0001' is dismissed and has name 'The Matrix'
        const dismissedNames = new Set(['the matrix']);
        const dismissed = buildCombinedDismissedSet(new Set(['tt0001']), new Set(), new Set(), dismissedNames);

        // 'tmdb:603' is a different ID for same movie
        const catalog = makeCatalog([makeMetaItem('tmdb:603', 'The Matrix')]);
        // Use hasItem which checks names
        const filtered = catalog.content.content.filter((item) => !dismissed.hasItem(item));
        expect(filtered).toHaveLength(0);
    });

    test('item with different name is NOT filtered by dismissedNames', () => {
        const dismissedNames = new Set(['the matrix']);
        const dismissed = buildCombinedDismissedSet(new Set(), new Set(), new Set(), dismissedNames);
        const catalog = makeCatalog([makeMetaItem('tt0002', 'Inception')]);
        const filtered = catalog.content.content.filter((item) => !dismissed.hasItem(item));
        expect(filtered).toHaveLength(1);
    });
});

// ─── Integration: Trakt operations affect filtering in discovery rows ───

describe('Trakt operations affect discovery row filtering', () => {
    test('addToWatchlist causes item to be filtered from discovery', async () => {
        await traktBridge.addToWatchlist('tt0001', 'movie', 'MovieA');
        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'MovieA'), makeMetaItem('tt0002', 'MovieB')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });

    test('addToNotInterested causes item to be filtered from discovery', async () => {
        await traktBridge.addToNotInterested('tt0001', 'movie', 'MovieA');
        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'MovieA'), makeMetaItem('tt0002', 'MovieB')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        expect(result.content.content).toHaveLength(1);
    });

    test('rateItem causes item to be filtered from discovery', async () => {
        await traktBridge.rateItem('tt0001', 'movie', 4);
        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'RatedMovie'), makeMetaItem('tt0002', 'Unrated')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        expect(result.content.content).toHaveLength(1);
        expect(result.content.content[0].id).toBe('tt0002');
    });

    test('markWatched does NOT cause item to be filtered from discovery (overlay needs it)', () => {
        traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'MovieA')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        // Item should NOT be filtered — rating overlay needs it visible
        expect(result.content.content).toHaveLength(1);
    });

    test('dismissWatched causes item to be filtered from discovery', () => {
        traktBridge.markWatched('tt0001', 'movie', 'MovieA');
        traktBridge.dismissWatched('tt0001');
        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'MovieA')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        expect(result).toBeNull(); // All filtered → null
    });

    test('removeFromWatchlist + page refresh: item reappears in discovery', async () => {
        await traktBridge.addToWatchlist('tt0001', 'movie', 'MovieA');
        await traktBridge.removeFromWatchlist('tt0001', 'movie');
        await simulatePageRefresh(buildSyncResponses({ watchlistMovies: [] }));

        const dismissed = traktBridge.getDismissedIds();
        const dismissedSet = { size: dismissed.size, has: (id) => dismissed.has(id) };
        const catalog = makeCatalog([makeMetaItem('tt0001', 'MovieA')]);
        const result = filterCatalogItems(catalog, dismissedSet, new Set());
        expect(result.content.content).toHaveLength(1);
    });
});
