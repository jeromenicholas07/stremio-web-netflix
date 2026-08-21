// Copyright (C) 2017-2026 Smart code 203358507

const history = require('../src/common/copyrightCheckHistory');

const {
    CLEAN_RUNS_TO_TRUST,
    TRUST_TTL_MS,
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

// Push `count` clean first-picks, one per simulated day.
function recordClean(count, startAt = NOW) {
    for (let i = 0; i < count; i += 1) {
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, startAt + i * 1000);
    }
}

describe('default behaviour', () => {
    it('checks a show it has never seen', () => {
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(true);
        expect(state.auto).toBe(true);
        expect(state.manual).toBe(null);
        expect(state.known).toBe(false);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
    });

    it('keeps checking while the clean streak is short of the threshold', () => {
        recordClean(CLEAN_RUNS_TO_TRUST - 1);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.cleanStreak).toBe(CLEAN_RUNS_TO_TRUST - 1);
        expect(state.enabled).toBe(true);
    });

    it('stops checking once the show has enough consecutive clean picks', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.cleanStreak).toBe(CLEAN_RUNS_TO_TRUST);
        expect(state.auto).toBe(false);
        expect(state.enabled).toBe(false);
    });

    it('ignores a show with no usable type/metaId', () => {
        expect(shouldCheckCopyright(null, null, NOW)).toBe(true);
        expect(shouldCheckCopyright(TYPE, '', NOW)).toBe(true);
        // Recording against an unusable key must not throw or persist.
        expect(() => recordCopyrightCheckRun(null, null, { clean: true }, NOW)).not.toThrow();
    });
});

describe('losing trust', () => {
    it('a single block re-enables checking immediately', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        expect(getCopyrightCheckState(TYPE, ID, NOW).enabled).toBe(false);

        recordCopyrightBlockObserved(TYPE, ID, NOW + 5000);
        const state = getCopyrightCheckState(TYPE, ID, NOW + 5000);
        expect(state.cleanStreak).toBe(0);
        expect(state.enabled).toBe(true);
        expect(state.blocks).toBe(1);
    });

    it('requires the full streak again after a block', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        recordCopyrightBlockObserved(TYPE, ID, NOW + 5000);

        recordClean(CLEAN_RUNS_TO_TRUST - 1, NOW + 10_000);
        expect(getCopyrightCheckState(TYPE, ID, NOW + 20_000).enabled).toBe(true);

        recordCopyrightCheckRun(TYPE, ID, { clean: true }, NOW + 20_000);
        expect(getCopyrightCheckState(TYPE, ID, NOW + 20_000).enabled).toBe(false);
    });

    it('expires trust once the newest clean pick ages past the TTL', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        expect(getCopyrightCheckState(TYPE, ID, NOW).enabled).toBe(false);

        // Past the TTL for every recorded pick, not just the oldest.
        const later = NOW + TRUST_TTL_MS + 5000;
        const state = getCopyrightCheckState(TYPE, ID, later);
        expect(state.cleanStreak).toBe(0);
        expect(state.enabled).toBe(true);
    });

    it('only counts clean picks that are still inside the TTL', () => {
        // One ancient clean pick plus two recent ones is not a streak of three.
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, NOW);
        const recent = NOW + TRUST_TTL_MS - 1000;
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, recent);
        recordCopyrightCheckRun(TYPE, ID, { clean: true }, recent + 1000);

        const at = recent + 2000;
        expect(getCopyrightCheckState(TYPE, ID, at).cleanStreak).toBe(2);
        expect(getCopyrightCheckState(TYPE, ID, at).enabled).toBe(true);
    });
});

describe('inconclusive results', () => {
    it('does not treat a missing verdict as evidence', () => {
        recordClean(CLEAN_RUNS_TO_TRUST - 1);
        recordCopyrightCheckRun(TYPE, ID, {}, NOW + 5000);
        recordCopyrightCheckRun(TYPE, ID, { clean: 'yes' }, NOW + 6000);

        const state = getCopyrightCheckState(TYPE, ID, NOW + 7000);
        expect(state.runs).toBe(CLEAN_RUNS_TO_TRUST - 1);
        expect(state.cleanStreak).toBe(CLEAN_RUNS_TO_TRUST - 1);
        expect(state.enabled).toBe(true);
    });
});

describe('manual override', () => {
    it('can force checking off before any history exists', () => {
        setCopyrightCheckManual(TYPE, ID, false, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(false);
        expect(state.auto).toBe(true);
        expect(state.manual).toBe(false);
    });

    it('can force checking on despite a clean streak', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        setCopyrightCheckManual(TYPE, ID, true, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.enabled).toBe(true);
        expect(state.auto).toBe(false);
        expect(state.manual).toBe(true);
    });

    it('returns the show to automatic when cleared', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        setCopyrightCheckManual(TYPE, ID, true, NOW);
        setCopyrightCheckManual(TYPE, ID, null, NOW);
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.manual).toBe(null);
        expect(state.enabled).toBe(false);
    });

    it('is cleared by an observed block so a forced-off show self-corrects', () => {
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
    it('keeps history per show', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);
        expect(shouldCheckCopyright(TYPE, 'tt0944947', NOW)).toBe(true);
        expect(shouldCheckCopyright('movie', ID, NOW)).toBe(true);
    });

    it('mirrors writes to sessionStorage and reads them back when local is empty', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        expect(global.sessionStorage.setItem).toHaveBeenCalled();

        const mirrored = global.sessionStorage.getItem('netflix_ui_rdcheck_history');
        global.localStorage = createStorageMock();
        global.sessionStorage.getItem.mockReturnValue(mirrored);

        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(false);
    });

    it('caps the stored run log', () => {
        recordClean(HISTORY_LIMIT + 5);
        expect(getCopyrightCheckState(TYPE, ID, NOW).runs).toBe(HISTORY_LIMIT);
    });

    it('survives corrupt stored data', () => {
        global.localStorage.getItem.mockReturnValue('not json');
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);

        global.localStorage.getItem.mockReturnValue(JSON.stringify({
            [`${TYPE}:${ID}`]: { runs: [{ clean: 'nope' }, null, 7], manual: 'yes' },
        }));
        const state = getCopyrightCheckState(TYPE, ID, NOW);
        expect(state.runs).toBe(0);
        expect(state.manual).toBe(null);
        expect(state.enabled).toBe(true);
    });

    it('forgets a show on demand', () => {
        recordClean(CLEAN_RUNS_TO_TRUST);
        clearCopyrightCheckHistory(TYPE, ID);
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
    });

    it('does not throw when storage is unavailable', () => {
        global.localStorage.setItem.mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        global.sessionStorage.setItem.mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        expect(() => recordCopyrightCheckRun(TYPE, ID, { clean: true }, NOW)).not.toThrow();
        expect(shouldCheckCopyright(TYPE, ID, NOW)).toBe(true);
    });
});
