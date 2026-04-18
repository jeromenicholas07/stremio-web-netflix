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

function buildMagnet(infoHash, title) {
    const trackers = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://exodus.desync.com:6969/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://open.stealth.si:80/announce'
    ];
    const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
    const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

const Torrent = ({ urlParams }) => {
    const { core } = useServices();
    const [error, setError] = React.useState(null);
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        const raw = urlParams && urlParams.payload;
        if (!raw) { setError('Missing torrent payload'); return; }

        const json = base64UrlDecode(decodeURIComponent(raw));
        if (!json) { setError('Invalid torrent payload'); return; }

        let payload;
        try { payload = JSON.parse(json); } catch { setError('Corrupt torrent payload'); return; }

        const infoHash = payload && typeof payload.infoHash === 'string' ? payload.infoHash : null;
        if (!infoHash) { setError('Torrent has no infoHash'); return; }

        const title = payload.name || payload.title || '';

        // Queue the torrent in the streaming server (RD auto-swaps if configured).
        try {
            core.transport.dispatch({
                action: 'StreamingServer',
                args: { action: 'CreateTorrent', args: buildMagnet(infoHash, title) }
            });
        } catch (err) {
            console.error('Torrent route: CreateTorrent dispatch failed', err);
        }

        // Build the stream object Player/decodeStream expects.
        const streamObj = {
            name: payload.name || 'Torrent',
            title: title || 'Torrent',
            infoHash,
            behaviorHints: {}
        };
        const encoded = base64UrlEncode(JSON.stringify(streamObj));
        window.location.replace(`#/player/${encoded}`);
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
