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

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// ─── Lifecycle ───────────────────────────────────────────────────────────
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// ─── Precache (injected by Workbox at build time) ────────────────────────
precacheAndRoute(self.__WB_MANIFEST || []);

// ─── Random per-URL expiry plugin ────────────────────────────────────────
// Each cached image gets a deterministic TTL between 7 and 21 days, derived
// from a hash of its URL. The same poster keeps the same effective expiry
// across reloads so the cache doesn't get re-shuffled on every visit.
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
    cachedResponseWillBeUsed: async ({ request, cachedResponse, cacheName, event, state }) => {
        if (!cachedResponse) return null;
        // Date header is set by upstream (TMDB / Cinemeta / YT all send it).
        // If it's missing for any reason, fall through and let the hard
        // ExpirationPlugin enforce the 21-day ceiling.
        const dateHeader = cachedResponse.headers.get('date');
        if (!dateHeader) return cachedResponse;
        const cachedAt = new Date(dateHeader).getTime();
        if (!cachedAt || Number.isNaN(cachedAt)) return cachedResponse;
        if (Date.now() - cachedAt > ttlForUrl(request.url)) return null;
        return cachedResponse;
    },
};

// ─── TMDB images (posters, backdrops, logos) ────────────────────────────
registerRoute(
    ({ url }) => url.hostname === 'image.tmdb.org',
    new CacheFirst({
        cacheName: 'tmdb-images-v1',
        // Force CORS so the cached response carries headers (incl. Date).
        // image.tmdb.org sends Access-Control-Allow-Origin: *.
        fetchOptions: { mode: 'cors', credentials: 'omit' },
        plugins: [
            RandomExpiryPlugin,
            new ExpirationPlugin({
                maxEntries: 15000,
                maxAgeSeconds: 21 * 24 * 60 * 60,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

// ─── Cinemeta posters / logos ───────────────────────────────────────────
registerRoute(
    ({ url }) => url.hostname === 'images.metahub.space',
    new CacheFirst({
        cacheName: 'metahub-images-v1',
        fetchOptions: { mode: 'cors', credentials: 'omit' },
        plugins: [
            RandomExpiryPlugin,
            new ExpirationPlugin({
                maxEntries: 10000,
                maxAgeSeconds: 21 * 24 * 60 * 60,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

// ─── YouTube thumbnails (used for trailer letterbox detection) ──────────
registerRoute(
    ({ url }) => url.hostname === 'i.ytimg.com',
    new CacheFirst({
        cacheName: 'ytimg-thumbnails-v1',
        fetchOptions: { mode: 'cors', credentials: 'omit' },
        plugins: [
            RandomExpiryPlugin,
            new ExpirationPlugin({
                maxEntries: 5000,
                maxAgeSeconds: 21 * 24 * 60 * 60,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);
