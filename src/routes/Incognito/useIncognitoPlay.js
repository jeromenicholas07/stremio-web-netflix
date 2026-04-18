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

function buildMagnet(stream) {
    const trackers = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://exodus.desync.com:6969/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://open.stealth.si:80/announce'
    ];
    const dn = stream.title ? `&dn=${encodeURIComponent(stream.title)}` : '';
    const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${stream.infoHash}${dn}${tr}`;
}

const useIncognitoPlay = () => {
    const { core } = useServices();

    return React.useCallback((stream) => {
        if (!stream || typeof stream.infoHash !== 'string') {
            console.warn('useIncognitoPlay: stream has no infoHash', stream);
            return;
        }

        // 1. Queue the torrent in the streaming server
        const magnet = buildMagnet(stream);
        try {
            core.transport.dispatch({
                action: 'StreamingServer',
                args: {
                    action: 'CreateTorrent',
                    args: magnet
                }
            });
        } catch (err) {
            console.error('useIncognitoPlay: CreateTorrent dispatch failed', err);
        }

        // 2. Shape the stream the way stremio-core's decodeStream expects
        const streamObj = {
            name: stream.name || '',
            title: stream.title || stream.name || '',
            infoHash: stream.infoHash,
            behaviorHints: stream.behaviorHints || {}
        };
        if (typeof stream.fileIdx === 'number') streamObj.fileIdx = stream.fileIdx;
        if (typeof stream.fileIndex === 'number') streamObj.fileIdx = stream.fileIndex;

        const encoded = base64UrlEncode(JSON.stringify(streamObj));

        // 3. Navigate to Player with only the encoded stream (no transport URLs,
        //    no meta — Player handles that gracefully per usePlayer.js:47-70).
        window.location.hash = `#/player/${encoded}`;
    }, [core]);
};

module.exports = useIncognitoPlay;
