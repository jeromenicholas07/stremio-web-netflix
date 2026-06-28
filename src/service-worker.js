// Copyright (C) 2017-2024 Smart code 203358507
//
// Custom service worker — bundled by Workbox InjectManifest.
//
// Two jobs:
//   1. Precache the build artifacts (the manifest is injected at build time).
//   2. Runtime-cache poster / logo / thumbnail images so they load instantly
//      on repeat visits and survive page reloads.
//
// Image caches use a CacheFirst strategy with a custom random-expiry plugin
// (7-21 days, deterministic per URL) layered on top of Workbox's hard
// ExpirationPlugin (LRU + 21-day ceiling + purge-on-quota-error).
//
// Note on opaque responses: cross-origin <img> requests run in `no-cors`
// mode by default, which yields opaque responses (status 0, no readable
// headers/body). We allow opaque caching via CacheableResponsePlugin and
// track expiry in our own IndexedDB store rather than relying on the
// `Date` header (which is unreadable on opaque responses).

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

// ─── Lifecycle ───────────────────────────────────────────────────────────
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// ─── Precache (injected by Workbox at build time) ────────────────────────
precacheAndRoute(self.__WB_MANIFEST || []);

// ─── HTML navigation: always network-first ───────────────────────────────
// The HTML document references the hashed bundle (scripts/main.<hash>.js).
// GitHub Pages serves index.html with `Cache-Control: max-age=600`, so the
// Stremio shell's HTTP disk cache pins a STALE index.html — and therefore a
// stale bundle — for up to 10 minutes after every deploy. That is the root
// cause of "I deployed a UI fix but the exe still shows the old behaviour".
//
// Serving navigations network-first (bypassing the HTTP cache with
// cache:'reload') means a fresh deploy is picked up on the very next launch.
// Falls back to the last cached copy when offline so the app still opens.
const navigationHandler = new NetworkFirst({
    cacheName: 'html-navigations-v1',
    networkTimeoutSeconds: 8,
    fetchOptions: { cache: 'reload' },
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
});
registerRoute(new NavigationRoute(navigationHandler));

// ─── IndexedDB-backed expiry store ───────────────────────────────────────
// Workbox's ExpirationPlugin uses a single global maxAge; we want a random
// per-URL TTL between 7 and 21 days, deterministic from a hash of the URL
// so the same poster keeps the same effective lifetime across sessions.
const EXPIRY_DB_NAME = 'sw-image-expiry';
const EXPIRY_STORE = 'entries';
let _expiryDbPromise = null;

function openExpiryDb() {
    if (_expiryDbPromise) return _expiryDbPromise;
    _expiryDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(EXPIRY_DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(EXPIRY_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _expiryDbPromise;
}

async function setExpiry(url, expiresAt) {
    try {
        const db = await openExpiryDb();
        await new Promise((resolve) => {
            const tx = db.transaction(EXPIRY_STORE, 'readwrite');
            tx.objectStore(EXPIRY_STORE).put(expiresAt, url);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch { /* never let cache writes break image loads */ }
}

async function getExpiry(url) {
    try {
        const db = await openExpiryDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(EXPIRY_STORE, 'readonly');
            const req = tx.objectStore(EXPIRY_STORE).get(url);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
        });
    } catch {
        return undefined;
    }
}

// ─── Random per-URL expiry plugin ────────────────────────────────────────
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RANGE_MS = 14 * 24 * 60 * 60 * 1000;

function fnv1a(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function ttlForUrl(url) {
    return SEVEN_DAYS_MS + (fnv1a(url) % RANGE_MS);
}

const RandomExpiryPlugin = {
    // Stamp each newly-cached entry with a random expiry timestamp.
    cacheDidUpdate: async ({ request }) => {
        await setExpiry(request.url, Date.now() + ttlForUrl(request.url));
    },
    // On read, treat as miss if past the per-URL expiry.
    cachedResponseWillBeUsed: async ({ request, cachedResponse }) => {
        if (!cachedResponse) return null;
        const expiresAt = await getExpiry(request.url);
        if (!expiresAt) return cachedResponse; // unknown — keep
        if (Date.now() > expiresAt) return null;
        return cachedResponse;
    },
};

// ─── Image route factory ────────────────────────────────────────────────
function imageRoute(cacheName, maxEntries) {
    return new CacheFirst({
        cacheName,
        plugins: [
            // Cache opaque (status 0) responses too — cross-origin <img>
            // tags fetch with no-cors mode which yields opaque responses.
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            RandomExpiryPlugin,
            new ExpirationPlugin({
                maxEntries,
                maxAgeSeconds: 21 * 24 * 60 * 60,
                purgeOnQuotaError: true,
            }),
        ],
    });
}

// ─── TMDB images (posters, backdrops, logos) ────────────────────────────
registerRoute(({ url }) => url.hostname === 'image.tmdb.org', imageRoute('tmdb-images-v1', 15000));

// ─── Cinemeta posters / logos ───────────────────────────────────────────
registerRoute(({ url }) => url.hostname === 'images.metahub.space', imageRoute('metahub-images-v1', 10000));

// ─── YouTube thumbnails (used for trailer letterbox detection) ──────────
registerRoute(({ url }) => url.hostname === 'i.ytimg.com', imageRoute('ytimg-thumbnails-v1', 5000));
