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

    it('reads the total from Content-Range when present (206)', async () => {
        const originalFetch = global.fetch;
        const headers = {
            'content-range': 'bytes 0-1/2119075',
            'content-type': 'video/mp4',
            'content-length': '2',
        };
        global.fetch = jest.fn().mockResolvedValue({
            status: 206,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        });

        await expect(probeContentLength('http://test/proxy', null)).resolves.toBe(2119075);

        global.fetch = originalFetch;
    });

    it('trusts a small video Content-Length when the proxy drops Range (shell .exe stub case)', async () => {
        // The launcher CORS proxy does not forward Range, so the ~2 MB copyright
        // stub comes back as 200 + full Content-Length and NO Content-Range.
        const originalFetch = global.fetch;
        const headers = {
            'content-type': 'video/mp4',
            'content-length': '2119075',
        };
        global.fetch = jest.fn().mockResolvedValue({
            status: 200,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        });

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBe(2119075);
        expect(isStubSize(total)).toBe(true);

        global.fetch = originalFetch;
    });

    it('trusts a small octet-stream Content-Length when the proxy drops Range (shell stub case)', async () => {
        const originalFetch = global.fetch;
        const headers = {
            'content-type': 'application/octet-stream',
            'content-length': '2119075',
        };
        global.fetch = jest.fn().mockResolvedValue({
            status: 200,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        });

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBe(2119075);
        expect(isStubSize(total)).toBe(true);

        global.fetch = originalFetch;
    });

    it('probes Range-first even against the loopback CORS proxy', async () => {
        const originalFetch = global.fetch;
        const headers = {
            'content-range': 'bytes 0-1/2119075',
            'content-type': 'application/octet-stream',
            'content-length': '2',
        };
        global.fetch = jest.fn().mockResolvedValue({
            status: 206,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        });

        const total = await probeContentLength('http://127.0.0.1:12470/proxy/test', null);
        expect(total).toBe(2119075);
        // The very first probe carries the Range header (2-byte body).
        expect(global.fetch.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-1' });

        global.fetch = originalFetch;
    });

    it('retries without Range when the ranged probe yields no size, then reads Content-Length', async () => {
        const originalFetch = global.fetch;
        // First (ranged) response: proxy answered chunked, no size at all.
        const ranged = {
            status: 200,
            headers: { get: () => null },
        };
        // Second (no-Range) response: full Content-Length of the ~2 MB stub.
        const plain = {
            status: 200,
            headers: {
                get: (name) => ({ 'content-type': 'video/mp4', 'content-length': '2119075' }[name.toLowerCase()] ?? null),
            },
        };
        global.fetch = jest.fn()
            .mockResolvedValueOnce(ranged)
            .mockResolvedValueOnce(plain);

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBe(2119075);
        expect(isStubSize(total)).toBe(true);
        // Two attempts: ranged, then the no-Range retry.
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-1' });
        expect(global.fetch.mock.calls[1][1].headers).toEqual({});

        global.fetch = originalFetch;
    });

    it('ignores a tiny HTML error body served as 200 (does not treat it as a stub)', async () => {
        const originalFetch = global.fetch;
        const headers = {
            'content-type': 'text/html',
            'content-length': '148',
        };
        global.fetch = jest.fn().mockResolvedValue({
            status: 200,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        });

        await expect(probeContentLength('http://test/proxy', null)).resolves.toBeNull();

        global.fetch = originalFetch;
    });
});
