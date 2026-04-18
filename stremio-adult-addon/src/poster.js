// Poster resolution and deepLinks helpers.
//
// The fallback poster is an inline SVG data URI — avoids shipping binary
// assets, works offline, and renders consistently on any Stremio client.
// Picks a per-group color from the group id hash so each card has a
// distinct hue instead of a sea of identical grey placeholders.

function hashToHue(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 360;
}

function fallbackPoster(group) {
    const hue = hashToHue(group.id || 'x');
    const initial = (group.name || 'X').trim().charAt(0).toUpperCase() || 'X';
    // 400x600 poster-shape (2:3)
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 600'>
<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
<stop offset='0%' stop-color='hsl(${hue},55%,28%)'/>
<stop offset='100%' stop-color='hsl(${(hue + 40) % 360},55%,14%)'/>
</linearGradient></defs>
<rect width='400' height='600' fill='url(#g)'/>
<text x='200' y='310' font-family='system-ui,sans-serif' font-size='220' font-weight='700' fill='rgba(255,255,255,0.18)' text-anchor='middle' dominant-baseline='middle'>${initial}</text>
<text x='200' y='560' font-family='system-ui,sans-serif' font-size='20' fill='rgba(255,255,255,0.5)' text-anchor='middle'>INCOGNITO</text>
</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function resolvePoster(group) {
    if (group && typeof group.poster === 'string' && group.poster.trim().length > 0) {
        return group.poster.trim();
    }
    return fallbackPoster(group || {});
}

function buildDeepLinks(groupId) {
    const href = `#/incognito/details/${encodeURIComponent(groupId)}`;
    return {
        metaDetailsStreams: href,
        metaDetailsVideos: href,
    };
}

module.exports = { resolvePoster, buildDeepLinks, fallbackPoster };
