// Copyright (C) 2017-2026 Smart code 203358507

const history = require('../src/common/copyrightCheckHistory');

const {
    CLEAN_RUNS_TO_CLEAR,
    BLOCK_MEMORY_MS,
    HISTORY_LIMIT,
    getCopyrightCheckState,
    shouldCheckCopyright,
    recordCopyrightCheckRun,
    recordCopyrightBlockObserved,
    setCopyrightCheckManual,
    clearCopyrightCheckHistory,
} = history;

function createStorageMock() {
    const store = {};
    return {
        getItem: jest.fn((key) => store[key] || null),
        setItem: jest.fn((key, value) => {
            store[key] = String(value);
        }),
        removeItem: jest.fn((key) => {
            delete store[key];
        }),
    };
}

const TYPE = 'series';
const ID = 'tt0903747';
const NOW = 1_700_000_000_000;

beforeEach(() => {
    global.localStorage = createStorageMock();
    global.sessionStorage = createStorageMock();
});

function recordClean(count, startAt) {
    for (let i = 0; i < count; i += 1) {
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, startAt + i * 1000);
    }
}

describe('off by default', () => {
    it('does not check a show it has never seen', () => {
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(false);
        expect(state.auto).toBe(false);
        expect(state.manual).toBe(null);
        expect(state.known).toBe(false);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);
    });

    it('stays off no matter how many clean picks accumulate', () => {
        recordClean(HISTORY_LIMIT, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(false);
        expect(state.blocks).toBe(0);
        expect(state.lastBlockAt).toBe(null);
    });

    it('stays off for a show with no usable type/metaId', () => {
        expect(shouldCheckCopyright(null, null, NOW)).toBe(false);
        expect(shouldCheckCopyright(TYPE, '', NOW)).toBe(false);
        expect(() => recordCopyrightBlockObserved(null, null, NOW)).not.toThrow();
    });
});

describe('a block switches it on', () => {
    it('turns on the moment a blocked file is seen', () => {
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);

        const state = recordCopyrightBlockObserved(TYPE, ID, NOW);
        expect(state.enabled).toBe(true);
        expect(state.auto).toBe(true);
        expect(state.blocks).toBe(1);
        expect(state.lastBlockAt).toBe(NOW);
        expect(state.cleanSinceBlock).toBe(0);
    });

    it('turns on from a preflight block too, not just a playback failure', () => {
        recordCopyrightCheckRun(TYPE, ID, { clean: false }, NOW);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
    });

    it('only affects the show it happened on', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
        expect(shouldCheckCopyright(TYPE, 'tt0944947', NOW)).toBe(false);
        expect(shouldCheckCopyright('movie', ID, NOW)).toBe(false);
    });

    it('stays on while clean picks are still short of the clearing run', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        recordClean(CLEAN_RUNS_TO_CLEAR - 1, NOW + 1000);

        const state = getCopyrightCheckState(TYPE, ID, NOW + 10_000);
        expect(state.cleanSinceBlock).toBe(CLEAN_RUNS_TO_CLEAR - 1);
        expect(state.enabled).toBe(true);
    });
});

describe('switching back off', () => {
    it('clears after a full run of clean probes', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        recordClean(CLEAN_RUNS_TO_CLEAR, NOW + 1000);

        const state = getCopyrightCheckState(TYPE, ID, NOW + 10_000);
        expect(state.cleanSinceBlock).toBe(CLEAN_RUNS_TO_CLEAR);
        expect(state.enabled).toBe(false);
    });

    it('clears once the block ages out of memory, even with no clean probes', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        expect(shouldCheckCopyright(TYPE, ID, NOW + BLOCK_MEMORY_MS - 1000)).toBe(true);
        expect(shouldCheckCopyright(TYPE, ID, NOW + BLOCK_MEMORY_MS + 1000)).toBe(false);
    });

    it('re-arms on a second block and needs the full clean run again', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        recordClean(CLEAN_RUNS_TO_CLEAR, NOW + 1000);
        expect(shouldCheckCopyright(TYPE, ID, NOW + 10_000)).toBe(false);

        recordCopyrightBlockObserved(TYPE, ID, NOW + 20_000);
        const state = getCopyrightCheckState(TYPE, ID, NOW + 20_000);
        expect(state.enabled).toBe(true);
        expect(state.cleanSinceBlock).toBe(0);
        expect(state.blocks).toBe(2);

        recordClean(CLEAN_RUNS_TO_CLEAR - 1, NOW + 21_000);
        expect(shouldCheckCopyright(TYPE, ID, NOW + 30_000)).toBe(true);
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, NOW + 31_000);
        expect(shouldCheckCopyright(TYPE, ID, NOW + 31_000)).toBe(false);
    });
});

describe('inconclusive results', () => {
    it('are not evidence in either direction', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        recordCopyrightCheckRun(TYPE, ID, {}, NOW + 1000);
        recordCopyrightCheckRun(TYPE, ID, { clean: 'yes' }, NOW + 2000);

        const state = getCopyrightCheckState(TYPE, ID, NOW + 3000);
        expect(state.runs).toBe(1);
        expect(state.cleanSinceBlock).toBe(0);
        expect(state.enabled).toBe(true);
    });
});

describe('manual override', () => {
    it('can force checking on for a show with no history', () => {
        setCopyrightCheckManual(TYPE, ID, true, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(true);
        expect(state.auto).toBe(false);
        expect(state.manual).toBe(true);
    });

    it('can force checking off for a show that was blocked', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        setCopyrightCheckManual(TYPE, ID, false, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(false);
        expect(state.auto).toBe(true);
        expect(state.manual).toBe(false);
    });

    it('returns the show to automatic when cleared', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        setCopyrightCheckManual(TYPE, ID, false, NOW);
        setCopyrightCheckManual(TYPE, ID, null, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.manual).toBe(null);
        expect(state.enabled).toBe(true);
    });

    it('is cleared by a fresh block so a forced-off show self-corrects', () => {
        setCopyrightCheckManual(TYPE, ID, false, NOW);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);

        recordCopyrightBlockObserved(TYPE, ID, NOW + 1000);
        const state = getCopyrightCheckState(TYPE, ID, NOW + 1000);
        expect(state.manual).toBe(null);
        expect(state.enabled).toBe(true);
    });

    it('survives a clean run', () => {
        setCopyrightCheckManual(TYPE, ID, true, NOW);
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, NOW + 1000);
        expect(getCopyrightCheckState(TYPE, ID, NOW + 1000).manual).toBe(true);
    });
});

describe('storage', () => {
    it('mirrors writes to sessionStorage and reads them back when local is empty', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        expect(global.sessionStorage.setItem).toHaveBeenCalled();

        const mirrored = global.sessionStorage.getItem('netflix_ui_rdcheck_history');
        global.localStorage = createStorageMock();
        global.sessionStorage.getItem.mockReturnValue(mirrored);

        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
    });

    it('caps the stored run log', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        recordClean(HISTORY_LIMIT + 5, NOW + 1000);
        expect(getCopyrightCheckState(TYPE, ID, NOW + 60_000).runs).toBe(HISTORY_LIMIT);
    });

    it('survives corrupt stored data by falling back to off', () => {
        global.localStorage.getItem.mockReturnValue('not json');
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);

        global.localStorage.getItem.mockReturnValue(JSON.stringify({
            [`${TYPE}:${ID}`]: { runs: [{ clean: 'nope' }, null, 7], manual: 'yes' },
        }));
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.runs).toBe(0);
        expect(state.manual).toBe(null);
        expect(state.enabled).toBe(false);
    });

    it('forgets a show on demand', () => {
        recordCopyrightBlockObserved(TYPE, ID, NOW);
        clearCopyrightCheckHistory(TYPE, ID);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);
    });

    it('does not throw when storage is unavailable', () => {
        global.localStorage.setItem.mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        global.sessionStorage.setItem.mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        expect(() => recordCopyrightBlockObserved(TYPE, ID, NOW)).not.toThrow();
    });
});
