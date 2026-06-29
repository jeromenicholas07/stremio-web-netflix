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

    // Build a fetch Response whose body streams `totalBytes` in `chunk`-sized
    // pieces and exposes NO Content-Length / Content-Range — the shell .exe
    // case where the proxy returns a chunked 200 after following the RD
    // redirect. A fresh one is returned per fetch call (bodies are single-use).
    function streamResponse({ status = 200, contentType = 'video/mp4', totalBytes, chunk = 256 * 1024 } = {}) {
        const hdr = { 'content-type': contentType };
        let sent = 0;
        return {
            status,
            headers: { get: (name) => hdr[name.toLowerCase()] ?? null },
            body: {
                getReader: () => ({
                    read: () => {
                        if (sent >= totalBytes) return Promise.resolve({ done: true, value: undefined });
                        const n = Math.min(chunk, totalBytes - sent);
                        sent += n;
                        return Promise.resolve({ done: false, value: new Uint8Array(n) });
                    },
                    cancel: () => Promise.resolve(),
                }),
            },
        };
    }

    it('measures the chunked stub body when no length headers are present (shell case)', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(() => Promise.resolve(streamResponse({
            contentType: 'application/octet-stream',
            totalBytes: 2119075,
            chunk: 512 * 1024,
        })));

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBe(2119075);
        expect(isStubSize(total)).toBe(true);
        // Ranged probe yields no size → no-Range retry → body measured.
        expect(global.fetch).toHaveBeenCalledTimes(2);

        global.fetch = originalFetch;
    });

    it('treats a large no-length body as real and aborts after the cap', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(() => Promise.resolve(streamResponse({
            contentType: 'video/mp4',
            totalBytes: 50 * 1024 * 1024,
            chunk: 1024 * 1024,
        })));

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBeGreaterThan(STUB_KNOWN_MAX_BYTES);
        expect(isStubSize(total)).toBe(false);

        global.fetch = originalFetch;
    });

    it('fails open when a no-length body is a tiny error page', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(() => Promise.resolve(streamResponse({
            contentType: 'text/html',
            totalBytes: 148,
            chunk: 148,
        })));

        await expect(probeContentLength('http://test/proxy', null)).resolves.toBeNull();

        global.fetch = originalFetch;
    });

    it('retries without Range when the ranged probe errors (Torrentio resolve 500), then body-measures', async () => {
        const originalFetch = global.fetch;
        const err500 = {
            status: 500,
            headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '148' : null) },
        };
        global.fetch = jest.fn()
            .mockResolvedValueOnce(err500)
            .mockResolvedValueOnce(streamResponse({
                contentType: 'application/octet-stream',
                totalBytes: 2119075,
                chunk: 512 * 1024,
            }));

        const total = await probeContentLength('http://test/proxy', null);
        expect(total).toBe(2119075);
        expect(isStubSize(total)).toBe(true);
        // Ranged probe 500s → plain-GET retry → body measured.
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-1' });
        expect(global.fetch.mock.calls[1][1].headers).toEqual({});

        global.fetch = originalFetch;
    });
});
