// Centralised image-URL resolution upgrader.
//
// Stremio's stock catalogs hand back medium-resolution Cinemeta thumbnails
// (e.g. `images.metahub.space/poster/medium/tt.../img`) which look noticeably
// soft when stretched onto a 4K display — both as poster cards and as the
// fullscreen MetaDetails background. We rewrite the size segment to the
// largest variant the host actually serves so the browser pulls a sharper
// image without any other code changes.
//
// We only touch URLs from known image hosts. Anything else passes through
// untouched so we don't accidentally over-fetch icons / sprites / favicons.

const UPGRADERS = [
    // ── Cinemeta / metahub.space ──
    // /poster/{small|medium}/...  →  /poster/large/...
    // Same for /background/ and /logo/
    {
        match: /^https?:\/\/(?:images|live)\.metahub\.space\/(poster|background|logo)\/(small|medium)\//i,
        upgrade: (url) => url.replace(
            /\/(poster|background|logo)\/(small|medium)\//i,
            '/$1/large/',
        ),
    },

    // ── TMDB image.tmdb.org/t/p/<size>/<path> ──
    // For posters, anything below w780 looks soft on retina/4K cards →
    // bump to w780. Backdrops should ideally be `original`, but we can't
    // tell from the URL alone whether a path is a poster or a backdrop.
    // We bump small sizes conservatively to w780 (a safe poster size that
    // still doesn't waste much bandwidth on backdrops).
    {
        match: /^https?:\/\/image\.tmdb\.org\/t\/p\/w(92|154|185|300|342|500)\//i,
        upgrade: (url) => url.replace(
            /\/t\/p\/w(?:92|154|185|300|342|500)\//i,
            '/t/p/w780/',
        ),
    },
];

/**
 * Return a higher-resolution variant of the given image URL, or the original
 * URL if no rule matches. Always safe to call: returns the input unchanged
 * when handed null/undefined/non-string values.
 */
function upgradeImageUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return url;
    for (const rule of UPGRADERS) {
        if (rule.match.test(url)) {
            try { return rule.upgrade(url); } catch { /* fall through */ }
        }
    }
    return url;
}

module.exports = upgradeImageUrl;
