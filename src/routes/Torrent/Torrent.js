// /torrent/<payload> — thin play-through route.
//
// The payload is base64url(JSON.stringify({infoHash, name, title})), produced
// by the addon's torrent-search handler. We:
//   1. Decode the payload.
//   2. Build a magnet URI and tell stremio-core's streaming server to queue it.
//   3. Redirect to #/player/<encoded-stream>.
//
// No PIN gate here — this is the regular (non-Incognito) torrent play path
// used by the Prowlarr row in the main Search page.

const React = require('react');
const { useServices } = require('stremio/services');
const { MainNavBars } = require('stremio/components');

function base64UrlDecode(s) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    try {
        const utf8 = atob(b64);
        return decodeURIComponent(escape(utf8));
    } catch {
        return null;
    }
}

function base64UrlEncode(str) {
    const utf8 = unescape(encodeURIComponent(str));
    return btoa(utf8)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

const ADDON_URL = 'http://127.0.0.1:7000';
const RD_TOKEN_KEY = 'rd_token';

async function resolveViaRD(infoHash, title) {
    let token = '';
    try { token = localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { /* ignore */ }
    if (!token) return null;
    try {
        const res = await fetch(`${ADDON_URL}/rd/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ infoHash, title, token }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && typeof data.url === 'string') return data;
        return null;
    } catch { return null; }
}

const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce'
];

function buildMagnet(infoHash, title) {
    const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
    const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

const Torrent = ({ urlParams }) => {
    const { core } = useServices();
    const [error, setError] = React.useState(null);
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        (async () => {
            const raw = urlParams && urlParams.payload;
            if (!raw) { setError('Missing torrent payload'); return; }

            const json = base64UrlDecode(decodeURIComponent(raw));
            if (!json) { setError('Invalid torrent payload'); return; }

            let payload;
            try { payload = JSON.parse(json); } catch { setError('Corrupt torrent payload'); return; }

            const infoHash = payload && typeof payload.infoHash === 'string' ? payload.infoHash.toLowerCase() : null;
            if (!infoHash || infoHash.length < 16) { setError('Torrent has no infoHash'); return; }

            const title = payload.name || payload.title || '';

            // Try Real-Debrid first (HTTPS URL, no local torrenting).
            const rd = await resolveViaRD(infoHash, title);
            if (rd && rd.url) {
                const rdStream = {
                    name: payload.name || 'RD',
                    description: rd.filename || title || 'Torrent',
                    url: rd.url,
                    behaviorHints: { bingeGroup: `torrent-rd:${infoHash}` },
                };
                const rdEncoded = base64UrlEncode(JSON.stringify(rdStream));
                try {
                    const decoded = await core.transport.decodeStream(rdEncoded);
                    if (decoded) {
                        window.location.replace(`#/player/${rdEncoded}`);
                        return;
                    }
                } catch (err) {
                    console.warn('[torrent-route] RD decodeStream failed, falling back to magnet', err);
                }
            }

            // Queue the torrent in the streaming server (fallback).
            try {
                core.transport.dispatch({
                    action: 'StreamingServer',
                    args: { action: 'CreateTorrent', args: buildMagnet(infoHash, title) }
                });
            } catch (err) {
                console.error('[torrent-route] CreateTorrent dispatch failed', err);
            }

            // Stream shape matching stremio-core's Stream::Torrent variant.
            // `announce` is required for serde to pick the Torrent variant.
            const streamObj = {
                name: payload.name || 'Torrent',
                description: title || 'Torrent',
                infoHash,
                announce: DEFAULT_TRACKERS,
                behaviorHints: { bingeGroup: `torrent:${infoHash}` }
            };
            const encoded = base64UrlEncode(JSON.stringify(streamObj));

            try {
                const decoded = await core.transport.decodeStream(encoded);
                if (!decoded) {
                    setError('Stremio rejected the stream payload (see DevTools console).');
                    console.error('[torrent-route] decodeStream returned null for', streamObj);
                    return;
                }
            } catch (err) {
                setError('Stremio threw decoding the stream (see DevTools console).');
                console.error('[torrent-route] decodeStream threw', err);
                return;
            }

            window.location.replace(`#/player/${encoded}`);
        })();
    }, [core, urlParams]);

    return (
        <MainNavBars route={'search'}>
            <div style={{ padding: 40, color: 'white', textAlign: 'center' }}>
                {error ? `Error: ${error}` : 'Starting torrent…'}
            </div>
        </MainNavBars>
    );
};

module.exports = Torrent;
