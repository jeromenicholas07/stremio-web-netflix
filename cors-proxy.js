#!/usr/bin/env node
// Tiny CORS proxy for Stremio streaming server.
// Forwards requests from port 12470 → 11470, adding CORS headers.
// Run: node cors-proxy.js

const http = require('http');
const SS = { host: '127.0.0.1', port: 11470 };

http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }

    const opts = {
        hostname: SS.host, port: SS.port,
        path: req.url, method: req.method,
        headers: { ...req.headers, host: `${SS.host}:${SS.port}` },
    };
    delete opts.headers['origin'];
    delete opts.headers['referer'];

    const proxy = http.request(opts, (pRes) => {
        const h = { ...pRes.headers, 'access-control-allow-origin': '*' };
        res.writeHead(pRes.statusCode, h);
        pRes.pipe(res);
    });
    proxy.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); res.end('Streaming server unavailable'); }
    });
    req.pipe(proxy);
}).listen(12470, '127.0.0.1', () => {
    console.log('\n  Stremio CORS Proxy running on http://127.0.0.1:12470');
    console.log('  Forwarding to streaming server at http://127.0.0.1:11470\n');
});
