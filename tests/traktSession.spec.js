// Copyright (C) 2017-2026 Smart Code OOD
// Trakt session persistence.
//
// The reported symptom was "my Trakt account keeps getting logged out in the
// Stremio shell". Two things caused it, and these cover both:
//
//   1. When Trakt 401s a token that still looks valid locally, the code
//      refreshes and retries. Every failure in that block -- a dropped
//      connection, a 5xx, even a retry that failed *after* a successful
//      refresh -- used to clear the tokens, so one bad moment signed the user
//      out for good. Only Trakt rejecting the grant should do that.
//   2. The shell's localStorage lives inside the Stremio install directory, so
//      a repair install or a cleared profile loses the session outright. The
//      launcher holds a copy that the UI restores from.

'use strict';

const storage = {};
global.localStorage = {
    getItem: jest.fn((key) => (key in storage ? storage[key] : null)),
    setItem: jest.fn((key, val) => { storage[key] = String(val); }),
    removeItem: jest.fn((key) => { delete storage[key]; }),
    clear: jest.fn(() => { Object.keys(storage).forEach((k) => delete storage[k]); }),
};

let fetchHandler = () => Promise.resolve(okResponse({}));
global.fetch = jest.fn((...args) => fetchHandler(...args));

const traktBridge = require('../src/services/TraktBridge');

function okResponse(body, status = 200) {
    return {
        ok: true,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        json: () => Promise.resolve(body),
        headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) },
    };
}

function errResponse(status) {
    return {
        ok: false,
        status,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
        headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) },
    };
}

const isTokenEndpoint = (url) => String(url).includes('/oauth/token');
const isLauncher = (url) => String(url).includes('/_launcher/');

function connect({ expired = false } = {}) {
    traktBridge.setAccessToken('access-1');
    traktBridge.setRefreshToken('refresh-1');
    traktBridge.setTokenExpiry(expired ? Date.now() - 1000 : Date.now() + 3600000);
    traktBridge.setUsername('someone');
}

// `refresh` drives the /oauth/token response, `authed` the actual API call.
// 'network' rejects the fetch outright; a number is an HTTP status.
function mockTrakt({ refresh = 'ok', authed = 'ok' } = {}) {
    fetchHandler = (url) => {
        if (isLauncher(url)) return Promise.resolve(okResponse({ ok: true }));
        if (isTokenEndpoint(url)) {
            if (refresh === 'network') return Promise.reject(new Error('offline'));
            if (typeof refresh === 'number') return Promise.resolve(errResponse(refresh));
            return Promise.resolve(okResponse({
                access_token: 'access-2',
                refresh_token: 'refresh-2',
                expires_in: 7776000,
                created_at: Math.floor(Date.now() / 1000),
            }));
        }
        if (authed === 'network') return Promise.reject(new Error('offline'));
        if (typeof authed === 'number') return Promise.resolve(errResponse(authed));
        return Promise.resolve(okResponse({ username: 'someone' }));
    };
}

beforeEach(() => {
    localStorage.clear();
    fetchHandler = () => Promise.resolve(okResponse({}));
});

describe('a bad moment must not sign the user out', () => {
    test('network failure while refreshing keeps the session', async () => {
        connect({ expired: true });
        mockTrakt({ refresh: 'network' });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getRefreshToken()).toBe('refresh-1');
        expect(traktBridge.isConnected()).toBe(true);
    });

    test('Trakt 5xx while refreshing keeps the session', async () => {
        connect({ expired: true });
        mockTrakt({ refresh: 503 });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getRefreshToken()).toBe('refresh-1');
        expect(traktBridge.isConnected()).toBe(true);
    });

    // The path that actually bit in the field: the stored token still looks
    // valid locally (so _ensureToken waves it through), Trakt 401s it anyway --
    // clock skew, or a server-side revocation -- and the refresh that follows
    // hits a bad connection. The old code took that as "session over".
    test('a 401 plus a flaky refresh keeps the session', async () => {
        connect();
        mockTrakt({ refresh: 'network', authed: 401 });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getRefreshToken()).toBe('refresh-1');
        expect(traktBridge.isConnected()).toBe(true);
    });

    test('a 401 plus a refresh 5xx keeps the session', async () => {
        connect();
        mockTrakt({ refresh: 502, authed: 401 });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getRefreshToken()).toBe('refresh-1');
        expect(traktBridge.isConnected()).toBe(true);
    });

    test('a request dropped after a good refresh keeps the new session', async () => {
        connect();
        mockTrakt({ refresh: 'ok', authed: 401 });

        // Let the refresh succeed, then kill the retry. The tokens just stored
        // are known good and must not go down with the failed request.
        const inner = fetchHandler;
        let apiCalls = 0;
        fetchHandler = (url, opts) => {
            if (!isTokenEndpoint(url) && !isLauncher(url)) {
                apiCalls += 1;
                if (apiCalls > 1) return Promise.reject(new Error('offline'));
            }
            return inner(url, opts);
        };

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getAccessToken()).toBe('access-2');
        expect(traktBridge.getRefreshToken()).toBe('refresh-2');
        expect(traktBridge.isConnected()).toBe(true);
    });
});

describe('a dead grant still signs the user out', () => {
    test('Trakt rejecting the refresh clears the session', async () => {
        connect({ expired: true });
        mockTrakt({ refresh: 401 });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.getAccessToken()).toBe('');
        expect(traktBridge.getRefreshToken()).toBe('');
        expect(traktBridge.isConnected()).toBe(false);
    });

    test('a freshly refreshed token still rejected clears the session', async () => {
        connect();
        mockTrakt({ refresh: 'ok', authed: 401 });

        await expect(traktBridge._fetch('/users/me')).rejects.toThrow();

        expect(traktBridge.isConnected()).toBe(false);
    });
});

describe('session survives a lost webview profile', () => {
    test('restores from the launcher when localStorage is empty', async () => {
        const saved = {
            access_token: 'from-launcher',
            refresh_token: 'refresh-from-launcher',
            token_expiry: Date.now() + 3600000,
            username: 'someone',
        };
        fetchHandler = (url) => (String(url).includes('/_launcher/trakt-session') ?
            Promise.resolve(okResponse(saved)) : Promise.resolve(okResponse({})));

        expect(traktBridge.isConnected()).toBe(false);
        await expect(traktBridge.restoreSessionFromLauncher()).resolves.toBe(true);

        expect(traktBridge.getAccessToken()).toBe('from-launcher');
        expect(traktBridge.getRefreshToken()).toBe('refresh-from-launcher');
        expect(traktBridge.getUsername()).toBe('someone');
        expect(traktBridge.isConnected()).toBe(true);
    });

    test('never overwrites a session already in localStorage', async () => {
        traktBridge.setAccessToken('local-token');
        fetchHandler = () => Promise.resolve(okResponse({ access_token: 'stale-from-launcher' }));

        await expect(traktBridge.restoreSessionFromLauncher()).resolves.toBe(false);
        expect(traktBridge.getAccessToken()).toBe('local-token');
    });

    test('no launcher listening is not an error', async () => {
        fetchHandler = () => Promise.reject(new Error('ECONNREFUSED'));

        await expect(traktBridge.restoreSessionFromLauncher()).resolves.toBe(false);
        expect(traktBridge.isConnected()).toBe(false);
    });

    test('an empty backup restores nothing', async () => {
        fetchHandler = () => Promise.resolve(okResponse({}));

        await expect(traktBridge.restoreSessionFromLauncher()).resolves.toBe(false);
        expect(traktBridge.isConnected()).toBe(false);
    });

    test('storing tokens backs them up to the launcher', async () => {
        const posted = [];
        fetchHandler = (url, opts) => {
            if (String(url).includes('/_launcher/trakt-session')) {
                posted.push({ method: opts && opts.method, body: JSON.parse(opts.body) });
            }
            return Promise.resolve(okResponse({ ok: true }));
        };

        traktBridge._storeTokens({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 7776000,
            created_at: Math.floor(Date.now() / 1000),
        });
        await Promise.resolve();

        expect(posted).toHaveLength(1);
        expect(posted[0].method).toBe('POST');
        expect(posted[0].body.refresh_token).toBe('r');
    });

    test('disconnecting forgets the backup too', async () => {
        connect();
        const methods = [];
        fetchHandler = (url, opts) => {
            if (String(url).includes('/_launcher/trakt-session')) {
                methods.push(opts && opts.method);
            }
            return Promise.resolve(okResponse({ ok: true }));
        };

        traktBridge.disconnect();
        await Promise.resolve();

        expect(methods).toContain('DELETE');
        expect(traktBridge.isConnected()).toBe(false);
    });
});
