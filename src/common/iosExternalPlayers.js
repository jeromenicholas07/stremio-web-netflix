// iOS external-player deep links.
//
// iOS Safari can't decode MKV / HEVC / AC3 inline, so when inline playback isn't
// possible we hand the stream off to a native player app via its URL scheme.
// These links are built here (not by stremio-core) so the UI can present a *row*
// of one-tap choices rather than the single player configured in Settings.
//
// icon: a name from @stremio/stremio-icons ('vlc' is a real logo; the others
// fall back to a neutral play glyph inside a branded pill).

function enc(url) {
    return encodeURIComponent(url);
}

const IOS_EXTERNAL_PLAYERS = [
    { value: 'infuse', label: 'Infuse', icon: 'play', build: (url) => `infuse://x-callback-url/play?url=${enc(url)}` },
    { value: 'vlc', label: 'VLC', icon: 'vlc', build: (url) => `vlc-x-callback://x-callback-url/stream?url=${enc(url)}` },
    { value: 'outplayer', label: 'Outplayer', icon: 'play', build: (url) => `outplayer://${url}` },
    { value: 'vidhub', label: 'VidHub', icon: 'play', build: (url) => `open-vidhub://x-callback-url/open?url=${enc(url)}` },
];

// The best media URL to hand to an external app. On iOS we deliberately run with
// NO streaming server, so the core's server-generated deep links
// (externalPlayer.streaming / .playlist) are null — the real playable URL is the
// stream's own direct HTTP(S) URL (e.g. a Real-Debrid link). Prefer the server
// links when they exist (desktop/self-hosted), otherwise fall back to the direct
// stream URL so the hand-off row still works serverless.
function getExternalMediaUrl(externalPlayer, stream) {
    return (externalPlayer && (externalPlayer.streaming || externalPlayer.playlist)) ||
        (stream && (stream.url || stream.externalUrl)) ||
        null;
}

module.exports = { IOS_EXTERNAL_PLAYERS, getExternalMediaUrl };
