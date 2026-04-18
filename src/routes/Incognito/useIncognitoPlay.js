// Drives click-to-play from the Incognito detail page.
//
// Flow:
//   1. Build a magnet URI from the stream's infoHash.
//   2. Tell stremio-core's streaming server to fetch it (so the torrent is
//      already queued by the time Player mounts).
//   3. Encode the stream descriptor the way stremio-core's decodeStream
//      understands (base64url of JSON) and navigate to #/player/<encoded>.
//
// No addon needs to be installed in core — Player's streamRequest/metaRequest
// are only built when transport URLs are provided, so we omit them and
// core-core handles the infoHash through the streaming server path.
//
// Real-Debrid: if the user has RD configured in Stremio Settings, core will
// auto-swap the magnet for an HTTPS RD URL when the stream resolves. Nothing
// extra is needed here.

const React = require('react');
const { useServices } = require('stremio/services');

function base64UrlEncode(str) {
    // btoa handles only Latin1; encode to UTF-8 first via encodeURIComponent.
    const utf8 = unescape(encodeURIComponent(str));
    return btoa(utf8)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce'
];

function buildMagnet(stream) {
    const dn = stream.title ? `&dn=${encodeURIComponent(stream.title)}` : '';
    const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${stream.infoHash}${dn}${tr}`;
}

const useIncognitoPlay = () => {
    const { core } = useServices();

    return React.useCallback(async (stream) => {
        if (!stream || typeof stream.infoHash !== 'string' || stream.infoHash.length < 16) {
            console.warn('[incognito-play] stream has no valid infoHash', stream);
            return;
        }

        // 1. Queue the torrent in the streaming server (RD auto-swaps if configured)
        const magnet = buildMagnet(stream);
        try {
            core.transport.dispatch({
                action: 'StreamingServer',
                args: { action: 'CreateTorrent', args: magnet }
            });
        } catch (err) {
            console.error('[incognito-play] CreateTorrent dispatch failed', err);
        }

        // 2. Shape the stream for stremio-core's decodeStream.
        //    Torrent variant needs `infoHash` and explicit `announce` array —
        //    without the latter, serde fails to select the Torrent variant
        //    and Player renders blank.
        const streamObj = {
            name: stream.name || 'Torrent',
            description: stream.title || stream.name || '',
            infoHash: stream.infoHash.toLowerCase(),
            announce: DEFAULT_TRACKERS,
            behaviorHints: {
                bingeGroup: stream.behaviorHints?.bingeGroup || `incognito:${stream.infoHash}`,
                ...(stream.behaviorHints || {})
            }
        };
        if (typeof stream.fileIdx === 'number') streamObj.fileIdx = stream.fileIdx;
        else if (typeof stream.fileIndex === 'number') streamObj.fileIdx = stream.fileIndex;

        const json = JSON.stringify(streamObj);
        const encoded = base64UrlEncode(json);

        // 3. Verify stremio-core can decode our payload; bail loud if not.
        try {
            const decoded = await core.transport.decodeStream(encoded);
            if (!decoded) {
                console.error('[incognito-play] decodeStream returned null for', streamObj);
                alert('Stremio could not parse this stream. Check DevTools console for payload.');
                return;
            }
        } catch (err) {
            console.error('[incognito-play] decodeStream threw', err);
            alert('Stremio rejected the stream payload. Check DevTools console.');
            return;
        }

        // 4. Navigate to Player.
        window.location.hash = `#/player/${encoded}`;
    }, [core]);
};

module.exports = useIncognitoPlay;
