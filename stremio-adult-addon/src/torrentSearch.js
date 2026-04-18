// Generic (non-adult) Prowlarr torrent search.
//
// Returns one meta per raw Prowlarr result — NO deduplication. Each item
// carries its magnet/infoHash payload inline in the meta id, so the web
// client can play it without a follow-up /meta or /stream call.
//
// Meta id format: `torrent:<base64url(JSON.stringify({infoHash, name, title}))>`
// The stremio-web `/torrent/<payload>` route decodes this and dispatches
// CreateTorrent + navigates to the Player.

const { LRUCache } = require('lru-cache');
const { searchProwlarr } = require('./prowlarr');
const { getConfig } = require('./config');

// Categories: 2000 movies, 5000 TV, 3000 audio, 7000 books, 8000 other
const GENERAL_CATEGORIES = [
    2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070, 2080,
    5000, 5010, 5020, 5030, 5040, 5050, 5060, 5070, 5080,
    3000, 3010, 3020, 3030, 3040, 3050, 3060,
    7000, 7010, 7020, 7030,
    8000, 8010,
];

const cache = new LRUCache({ max: 200, ttl: 15 * 60 * 1000 });

function base64UrlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function formatSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(0)} MB`;
}

function qualityFromTitle(title) {
    const t = (title || '').toLowerCase();
    if (/\b2160p|4k|uhd\b/.test(t)) return '4K';
    if (/\b1080p|fullhd\b/.test(t)) return '1080p';
    if (/\b720p|hd\b/.test(t)) return '720p';
    if (/\b480p|sd\b/.test(t)) return '480p';
    return '';
}

function hashToHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

function placeholderPoster(title) {
    const hue = hashToHue(title || 'x');
    const initial = (title || 'T').trim().charAt(0).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 600'>
<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
<stop offset='0%' stop-color='hsl(${hue},55%,28%)'/>
<stop offset='100%' stop-color='hsl(${(hue + 40) % 360},55%,14%)'/>
</linearGradient></defs>
<rect width='400' height='600' fill='url(#g)'/>
<text x='200' y='310' font-family='system-ui,sans-serif' font-size='220' font-weight='700' fill='rgba(255,255,255,0.18)' text-anchor='middle' dominant-baseline='middle'>${initial}</text>
<text x='200' y='560' font-family='system-ui,sans-serif' font-size='18' fill='rgba(255,255,255,0.5)' text-anchor='middle'>TORRENT</text>
</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function itemToMeta(item) {
    if (!item.infoHash) return null;
    const payload = {
        infoHash: item.infoHash,
        name: item.title,
        title: item.title,
    };
    const id = 'torrent:' + base64UrlEncode(JSON.stringify(payload));
    const quality = qualityFromTitle(item.title);
    const size = formatSize(item.size);
    const descParts = [];
    if (quality) descParts.push(quality);
    if (size) descParts.push(size);
    if (item.seeders) descParts.push(`${item.seeders} seeders`);
    if (item.indexer) descParts.push(item.indexer);

    const poster = item.poster && item.poster.trim().length > 0
        ? item.poster.trim()
        : placeholderPoster(item.title);

    const href = `#/torrent/${encodeURIComponent(id.slice('torrent:'.length))}`;

    return {
        id,
        type: 'other',
        name: item.title,
        poster,
        posterShape: 'poster',
        background: poster,
        description: descParts.join(' · '),
        releaseInfo: item.pubDate ? new Date(item.pubDate).getFullYear().toString() : undefined,
        behaviorHints: {
            // No adult flag here — this is the generic (movies/TV/etc) row.
        },
        deepLinks: {
            metaDetailsStreams: href,
            metaDetailsVideos: href,
            player: href,
        },
    };
}

async function handleTorrentSearch(query, extra = {}) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return { metas: [] };
    }

    const config = getConfig();
    const skip = parseInt(extra.skip || '0', 10);
    const cacheKey = `torrent-search:${query}:${skip}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let items;
    try {
        items = await searchProwlarr({
            query,
            offset: skip,
            limit: config.pageSize,
            sortBy: 'seeders',
            categories: GENERAL_CATEGORIES,
        });
    } catch (err) {
        console.error('[torrent-search]', err.message);
        return { metas: [] };
    }

    // Keep only items with a valid 40-char infoHash — anything else can't
    // be resolved by the streaming server and just produces dead cards.
    const playableItems = items.filter(it =>
        typeof it.infoHash === 'string' && /^[a-f0-9]{40}$/i.test(it.infoHash)
    );

    const metas = playableItems
        .map(itemToMeta)
        .filter(Boolean)
        .slice(0, config.pageSize);

    const result = { metas };
    cache.set(cacheKey, result);
    return result;
}

module.exports = { handleTorrentSearch, GENERAL_CATEGORIES };
