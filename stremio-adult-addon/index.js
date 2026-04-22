const http = require('http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { handleCatalog, clearCatalogCache } = require('./src/catalog');
const { handleSearch } = require('./src/search');
const { handleMeta } = require('./src/meta');
const { handleStream } = require('./src/stream');
const { handleTorrentSearch } = require('./src/torrentSearch');
const { handleResolve: handleRdResolve, handleFiles: handleRdFiles } = require('./src/rd');
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

    if (pathname === '/cache/clear') {
        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST' && req.method !== 'GET') {
            res.statusCode = 405; res.end(); return;
        }
        try {
            const cleared = clearCatalogCache();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, cleared }));
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
    console.log(`Incognito Catalogs addon running on port ${config.addonPort}`);
    console.log(`Manifest: http://127.0.0.1:${config.addonPort}/manifest.json`);
    console.log(`Config:   http://127.0.0.1:${config.addonPort}/config`);
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
