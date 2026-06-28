// Copyright (C) 2017-2026 Smart code 203358507

const {
    isStubSize,
    parseAdvertisedSizeBytes,
    probeContentLength,
    STUB_KNOWN_MAX_BYTES,
} = require('../src/common/streamPreflight');

describe('streamPreflight', () => {
    it('detects the known ~2 MB copyright stub', () => {
        expect(isStubSize(2119075)).toBe(true);
        expect(isStubSize(STUB_KNOWN_MAX_BYTES)).toBe(true);
    });

    it('treats real (large) episode/movie payloads as playable', () => {
        expect(isStubSize(180 * 1024 ** 2)).toBe(false); // ~180 MB x265 episode
        expect(isStubSize(525 * 1024 ** 2)).toBe(false); // MeGusta 525 MB
        expect(isStubSize(2.33 * 1024 ** 3)).toBe(false); // 2.33 GB
    });

    it('does not block on missing/zero sizes (fail open)', () => {
        expect(isStubSize(0)).toBe(false);
        expect(isStubSize(null)).toBe(false);
        expect(isStubSize(NaN)).toBe(false);
    });

    it('parses advertised sizes', () => {
        expect(parseAdvertisedSizeBytes('💾 525.66 MB')).toBeGreaterThan(0);
    });

    it('returns null on proxy/upstream HTTP errors (fail open)', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({
            status: 500,
            headers: {
                get: (name) => (name === 'content-length' ? '148' : null),
            },
        });

        await expect(probeContentLength('http://test/proxy', null)).resolves.toBeNull();

        global.fetch = originalFetch;
    });
});
