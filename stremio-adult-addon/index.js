const http = require('http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

// Bump this when shipping any addon change. Logged on startup so the
// launcher console makes it obvious which addon is actually running —
// invaluable when diagnosing "it's still the old version" reports
// (zombie node processes, stale extracts, AV-blocked overwrites).
const ADDON_INTERNAL_VERSION = '2026-04-30-strict-quota';

const { handleCatalog, clearCatalogCache } = require('./src/catalog');
const { handleSearch } = require('./src/search');
const { handleMeta } = require('./src/meta');
const { handleStream } = require('./src/stream');
const { handleTorrentSearch } = require('./src/torrentSearch');
const {
    handleResolve: handleRdResolve,
    handleFiles: handleRdFiles,
    handleResolveUrl: handleRdResolveUrl,
} = require('./src/rd');
const { clearAllColdState } = require('./src/prowlarr');
const { getConfig } = require('./src/config');

const GENRES = [
    'Amateur', 'Anal', 'Asian', 'BBW', 'Big Tits', 'Blonde', 'Brunette',
    'Creampie', 'Cumshot', 'Ebony', 'Facial', 'Fetish', 'Group',
    'Interracial', 'Latina', 'Lesbian', 'MILF', 'Mature', 'POV',
    'Redhead', 'Solo', 'Teen', 'Threesome', 'Vintage',
];

const manifest = {
    id: 'community.incognito-catalogs',
    version: '1.0.0',
    name: 'Incognito Catalogs',
    description: 'Adult content catalogs powered by Prowlarr indexers. Requires Prowlarr with adult indexers configured.',
    types: ['other'],
    catalogs: [
        {
            id: 'adult-latest',
            type: 'other',
            name: 'Latest',
            extra: [
                { name: 'skip' },
                { name: 'genre', options: GENRES },
            ],
        },
        {
            id: 'adult-popular',
            type: 'other',
            name: 'Popular',
            extra: [
                { name: 'skip' },
                { name: 'genre', options: GENRES },
            ],
        },
        {
            id: 'adult-search',
            type: 'other',
            name: 'Search',
            extra: [
                { name: 'search', isRequired: true },
                { name: 'skip' },
            ],
        },
        {
            id: 'torrent-search',
            type: 'other',
            name: 'Torrents',
            extra: [
                { name: 'search', isRequired: true },
                { name: 'skip' },
            ],
        },
    ],
    resources: ['catalog', 'meta', 'stream'],
    behaviorHints: {
        adult: true,
        configurable: false,
    },
    idPrefixes: ['adult-', 'torrent:'],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        if (id === 'torrent-search' && extra.search) {
            return await handleTorrentSearch(extra.search, extra);
        }
        if (id === 'adult-search' && extra.search) {
            return await handleSearch(extra.search, extra);
        }
        return await handleCatalog(id, extra);
    } catch (err) {
        console.error(`Catalog error [${id}]:`, err.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    try {
        const result = await handleMeta(id);
        return result.meta ? result : { meta: null };
    } catch (err) {
        console.error(`Meta error [${id}]:`, err.message);
        return { meta: null };
    }
});

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        return await handleStream(id);
    } catch (err) {
        console.error(`Stream error [${id}]:`, err.message);
        return { streams: [] };
    }
});

// CORS headers used by both the addon router and /config endpoints
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handleStatusEndpoint(req, res) {
    // Read-only diagnostic endpoint. No POST — config is auto-discovered now.
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
    }

    const cfg = getConfig();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        ok: true,
        prowlarrUrl: cfg.prowlarrUrl,
        prowlarrApiKeySet: Boolean(cfg.prowlarrApiKey),
        addonPort: cfg.addonPort,
    }));
}

const config = getConfig();
const router = getRouter(builder.getInterface());

const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/status' || pathname === '/config' || pathname === '/config.json') {
        handleStatusEndpoint(req, res);
        return;
    }

    // /version — quick way to confirm which addon code is actually
    // listening on this port. Useful when diagnosing "still on the old
    // version" reports.
    if (pathname === '/version') {
        setCors(res);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            version: ADDON_INTERNAL_VERSION,
            endpoints: ['/rd/resolve', '/rd/files', '/rd/resolve-url', '/cache/clear', '/version', '/status'],
        }));
        return;
    }

    if (pathname === '/rd/resolve') {
        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        handleRdResolve(req, res);
        return;
    }

    if (pathname === '/rd/files') {
        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        handleRdFiles(req, res);
        return;
    }

    if (pathname === '/rd/resolve-url') {
        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        handleRdResolveUrl(req, res);
        return;
    }

    if (pathname === '/cache/clear') {
        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST' && req.method !== 'GET') {
            res.statusCode = 405; res.end(); return;
        }
        try {
            const cleared = clearCatalogCache();
            // Also wipe per-indexer cold flags. A user clicking "Clear cache"
            // is signalling "give me a fresh slate" — carrying over cold flags
            // (which may have been wrongly set by an older buggy version)
            // would defeat the purpose.
            const coldCleared = clearAllColdState();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, cleared, coldCleared }));
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    setCors(res);
    router(req, res, () => {
        res.statusCode = 404;
        res.end();
    });
});

server.listen(config.addonPort, () => {
    console.log(`=== Incognito Catalogs addon ${ADDON_INTERNAL_VERSION} ===`);
    console.log(`Listening on port ${config.addonPort}`);
    console.log(`Manifest: http://127.0.0.1:${config.addonPort}/manifest.json`);
    console.log(`Config:   http://127.0.0.1:${config.addonPort}/config`);
    console.log(`Endpoints: /rd/resolve, /rd/files, /rd/resolve-url, /cache/clear, /catalog/...`);
    console.log(`Prowlarr URL: ${config.prowlarrUrl}`);
    console.log(`Prowlarr API Key: ${config.prowlarrApiKey ? '(configured)' : '(NOT SET)'}`);

    // Fire-and-forget prefetch so the very first user request is warm.
    // 2s settle-delay gives Prowlarr a chance to finish booting — on
    // fresh first-run machines Prowlarr needs a few seconds to become
    // reachable, and we'd rather the prefetch land than the cache stay
    // cold.
    setTimeout(() => {
        console.log('[prefetch] warming catalog caches');
        const started = Date.now();
        Promise.allSettled([
            handleCatalog('adult-latest'),
            handleCatalog('adult-popular'),
        ]).then(() => {
            console.log(`[prefetch] catalog caches warm in ${Date.now() - started}ms`);
        });
    }, 2000);
});
