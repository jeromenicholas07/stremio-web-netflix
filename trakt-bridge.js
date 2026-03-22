#!/usr/bin/env node
// Trakt API Bridge Server
// Runs locally to bypass CORS restrictions when calling Trakt API from the browser.
// Usage: node trakt-bridge.js
// Default port: 7700 (override with PORT env var)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.TRAKT_BRIDGE_PORT || '7700', 10);
const TRAKT_API = 'https://api.trakt.tv';
const CONFIG_PATH = path.join(__dirname, '.trakt-bridge-config.json');

// Load persisted config
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return { clientId: '', accessToken: '', username: '' };
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Proxy a request to Trakt API
function proxyToTrakt(method, traktPath, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(traktPath, TRAKT_API);
        const headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': config.clientId,
        };
        if (config.accessToken) {
            headers['Authorization'] = `Bearer ${config.accessToken}`;
        }

        const payload = body ? JSON.stringify(body) : null;
        if (payload) {
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request(url, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString();
                let parsed;
                try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Parse request body
function parseBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
    });
}

// CORS headers
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, data) {
    setCors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    setCors(res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    try {
        // ─── Health check ───
        if (pathname === '/health') {
            sendJson(res, 200, {
                ok: true,
                configured: !!(config.clientId && config.accessToken),
                username: config.username || null,
            });
            return;
        }

        // ─── Get/Set config ───
        if (pathname === '/config') {
            if (req.method === 'GET') {
                sendJson(res, 200, {
                    clientId: config.clientId ? '***configured***' : '',
                    accessToken: config.accessToken ? '***configured***' : '',
                    username: config.username || '',
                });
                return;
            }
            if (req.method === 'POST') {
                const body = await parseBody(req);
                if (body.clientId !== undefined) config.clientId = body.clientId;
                if (body.accessToken !== undefined) config.accessToken = body.accessToken;
                if (body.username !== undefined) config.username = body.username;
                saveConfig(config);
                sendJson(res, 200, { ok: true, message: 'Config saved' });
                return;
            }
        }

        // ─── Test connection ───
        if (pathname === '/test' && req.method === 'GET') {
            if (!config.clientId || !config.accessToken) {
                sendJson(res, 400, { ok: false, message: 'Missing clientId or accessToken' });
                return;
            }
            const result = await proxyToTrakt('GET', '/users/settings');
            if (result.status === 200) {
                const user = result.data?.user;
                if (user?.username) {
                    config.username = user.username;
                    saveConfig(config);
                }
                sendJson(res, 200, {
                    ok: true,
                    message: `Connected as ${user?.username || 'unknown'}`,
                    user: {
                        username: user?.username,
                        name: user?.name,
                        vip: user?.vip,
                    },
                });
            } else {
                sendJson(res, result.status, {
                    ok: false,
                    message: `Trakt returned ${result.status}`,
                    data: result.data,
                });
            }
            return;
        }

        // ─── Rate item ───
        // POST /rate { type: "movie"|"show", imdb: "tt1234567", rating: 1-10 }
        if (pathname === '/rate' && req.method === 'POST') {
            const body = await parseBody(req);
            const { type, imdb, tmdb, rating } = body;
            if (!rating || rating < 1 || rating > 10) {
                sendJson(res, 400, { ok: false, message: 'Rating must be 1-10' });
                return;
            }

            const item = { rated_at: new Date().toISOString(), rating };
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
            else {
                sendJson(res, 400, { ok: false, message: 'Must provide imdb or tmdb id' });
                return;
            }

            const traktType = type === 'series' ? 'shows' : 'movies';
            const result = await proxyToTrakt('POST', '/sync/ratings', { [traktType]: [item] });
            sendJson(res, result.status === 201 ? 200 : result.status, {
                ok: result.status === 201,
                message: result.status === 201 ? 'Rating saved to Trakt' : `Trakt returned ${result.status}`,
                data: result.data,
            });
            return;
        }

        // ─── Get ratings ───
        // GET /ratings?type=movies|shows
        if (pathname === '/ratings' && req.method === 'GET') {
            const type = url.searchParams.get('type') || 'movies';
            const result = await proxyToTrakt('GET', `/sync/ratings/${type}`);
            sendJson(res, result.status, {
                ok: result.status === 200,
                data: result.data,
            });
            return;
        }

        // ─── Add to watchlist ───
        // POST /watchlist { type: "movie"|"show", imdb: "tt1234567" }
        if (pathname === '/watchlist' && req.method === 'POST') {
            const body = await parseBody(req);
            const { type, imdb, tmdb } = body;

            const item = {};
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };
            else {
                sendJson(res, 400, { ok: false, message: 'Must provide imdb or tmdb id' });
                return;
            }

            const traktType = type === 'series' ? 'shows' : 'movies';
            const result = await proxyToTrakt('POST', '/sync/watchlist', { [traktType]: [item] });
            sendJson(res, result.status === 201 ? 200 : result.status, {
                ok: result.status === 201,
                message: result.status === 201 ? 'Added to Trakt watchlist' : `Trakt returned ${result.status}`,
                data: result.data,
            });
            return;
        }

        // ─── Remove from watchlist ───
        // DELETE /watchlist { type: "movie"|"show", imdb: "tt1234567" }
        if (pathname === '/watchlist' && req.method === 'DELETE') {
            const body = await parseBody(req);
            const { type, imdb, tmdb } = body;

            const item = {};
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

            const traktType = type === 'series' ? 'shows' : 'movies';
            const result = await proxyToTrakt('POST', '/sync/watchlist/remove', { [traktType]: [item] });
            sendJson(res, result.status === 200 ? 200 : result.status, {
                ok: result.status === 200,
                data: result.data,
            });
            return;
        }

        // ─── Add to custom list (e.g. "Not Interested") ───
        // POST /list/:listId { type: "movie"|"show", imdb: "tt1234567" }
        if (pathname.startsWith('/list/') && req.method === 'POST') {
            const listId = pathname.split('/list/')[1];
            const body = await parseBody(req);
            const { type, imdb, tmdb } = body;

            const item = {};
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

            const traktType = type === 'series' ? 'shows' : 'movies';
            const username = config.username || 'me';
            const result = await proxyToTrakt('POST', `/users/${username}/lists/${listId}/items`, { [traktType]: [item] });
            sendJson(res, result.status === 201 ? 200 : result.status, {
                ok: result.status === 201,
                message: result.status === 201 ? 'Added to list' : `Trakt returned ${result.status}`,
                data: result.data,
            });
            return;
        }

        // ─── Remove from custom list ───
        // DELETE /list/:listId { type: "movie"|"show", imdb: "tt1234567" }
        if (pathname.startsWith('/list/') && req.method === 'DELETE') {
            const listId = pathname.split('/list/')[1];
            const body = await parseBody(req);
            const { type, imdb, tmdb } = body;

            const item = {};
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

            const traktType = type === 'series' ? 'shows' : 'movies';
            const username = config.username || 'me';
            const result = await proxyToTrakt('POST', `/users/${username}/lists/${listId}/items/remove`, { [traktType]: [item] });
            sendJson(res, result.status === 200 ? 200 : result.status, {
                ok: result.status === 200,
                data: result.data,
            });
            return;
        }

        // ─── Mark as watched (scrobble/history) ───
        // POST /watched { type: "movie"|"show", imdb: "tt1234567" }
        if (pathname === '/watched' && req.method === 'POST') {
            const body = await parseBody(req);
            const { type, imdb, tmdb } = body;

            const item = { watched_at: new Date().toISOString() };
            if (imdb) item.ids = { imdb };
            else if (tmdb) item.ids = { tmdb: parseInt(tmdb, 10) };

            const traktType = type === 'series' ? 'shows' : 'movies';
            const result = await proxyToTrakt('POST', '/sync/history', { [traktType]: [item] });
            sendJson(res, result.status === 201 ? 200 : result.status, {
                ok: result.status === 201,
                message: result.status === 201 ? 'Marked as watched on Trakt' : `Trakt returned ${result.status}`,
                data: result.data,
            });
            return;
        }

        // ─── Get watched history ───
        if (pathname === '/watched' && req.method === 'GET') {
            const type = url.searchParams.get('type') || 'movies';
            const result = await proxyToTrakt('GET', `/sync/watched/${type}`);
            sendJson(res, result.status, {
                ok: result.status === 200,
                data: result.data,
            });
            return;
        }

        // ─── Get user lists ───
        if (pathname === '/lists' && req.method === 'GET') {
            const username = config.username || 'me';
            const result = await proxyToTrakt('GET', `/users/${username}/lists`);
            sendJson(res, result.status, {
                ok: result.status === 200,
                data: result.data,
            });
            return;
        }

        // 404
        sendJson(res, 404, { ok: false, message: 'Not found' });

    } catch (err) {
        sendJson(res, 500, { ok: false, message: err.message });
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Trakt Bridge running on http://127.0.0.1:${PORT}`);
    console.log(`Config: ${config.clientId ? 'Client ID set' : 'No client ID'} | ${config.accessToken ? 'Token set' : 'No token'}`);
});
