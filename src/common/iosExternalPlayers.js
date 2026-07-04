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

// The best media URL to hand to an external app: the direct/proxied streaming
// URL when present, else the .m3u playlist the core generates.
function getExternalMediaUrl(externalPlayer) {
    if (!externalPlayer) return null;
    return externalPlayer.streaming || externalPlayer.playlist || null;
}

module.exports = { IOS_EXTERNAL_PLAYERS, getExternalMediaUrl };
