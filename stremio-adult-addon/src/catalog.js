// Adult catalogs — one card per torrent.
//
// Each meta carries its playable payload inline in a `torrent:<base64>` id,
// so the card's deepLink points at /torrent/<payload> and click-to-play
// works without an intermediate details page. Torrent.js decodes the
// payload, tries RD via the addon's /rd/resolve endpoint, and falls back
// to the streaming server magnet flow if RD isn't configured or fails.
//
// We deliberately skip the old dedup-into-groups pipeline here. Adult
// torrents are rarely re-released in multiple qualities and users care
// more about seeders than quality variant consolidation. One card per
// Prowlarr result is simpler and matches what the main-Search torrent row
// already does, so the two flows share the /torrent/<payload> route.

const { searchProwlarr } = require('./prowlarr');
const { getConfig } = require('./config');
const { fallbackPoster } = require('./poster');
const { LRUCache } = require('lru-cache');

// 3h TTL: aggregate Prowlarr searches take 2–5s cold (slowest indexer
// dominates), and adult catalogs don't churn fast enough to warrant
// revalidating more often. Users hitting the tab multiple times per
// evening should see instant renders after the first fetch.
const cache = new LRUCache({ max: 200, ttl: 3 * 60 * 60 * 1000 });

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
    if (/\b1080p|fullhd|fhd\b/.test(t)) return '1080p';
    if (/\b720p|hd\b/.test(t)) return '720p';
    if (/\b480p|sd\b/.test(t)) return '480p';
    return '';
}

// Strip noisy tags so catalog cards show a reasonably clean title rather
// than the raw release name. Keeps the quality/seeders signal in the
// description where it's easier to scan.
function cleanTitle(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/\b(2160p|1080p|720p|480p|360p|4k|uhd|hdr|x264|x265|h\.?264|h\.?265|hevc|avc|web-?dl|webrip|bdrip|brrip|bluray|hdrip|remux|10bit|aac|ac3|dts|mp4|mkv|avi)\b/gi, ' ')
        .replace(/[._]+/g, ' ')
        .replace(/\s+-\s+/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Convert a raw Prowlarr torrent item into a catalog meta. Returns null
 * if the item isn't playable (no infoHash could be resolved).
 */
function itemToMeta(item) {
    const infoHash = typeof item.infoHash === 'string' ? item.infoHash.toLowerCase() : '';
    if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;

    const displayName = cleanTitle(item.title) || item.title || 'Untitled';
    const payload = {
        infoHash,
        name: displayName,
        title: item.title,
    };
    const id = 'torrent:' + base64UrlEncode(JSON.stringify(payload));
    const href = `#/torrent/${encodeURIComponent(id.slice('torrent:'.length))}`;

    // Compact description: seeders · leechers · size · quality · indexer
    // Users want seeders/leechers at a glance so we lead with them.
    const quality = qualityFromTitle(item.title);
    const size = formatSize(item.size);
    const parts = [];
    parts.push(`S ${item.seeders || 0}`);
    parts.push(`L ${item.peers || 0}`);
    if (size) parts.push(size);
    if (quality) parts.push(quality);
    if (item.indexer) parts.push(item.indexer);
    const description = parts.join(' · ');

    const poster = item.poster && item.poster.trim().length > 0
        ? item.poster.trim()
        : fallbackPoster({ id: infoHash, name: displayName });

    return {
        id,
        type: 'other',
        name: displayName,
        poster,
        posterShape: 'poster',
        background: poster,
        description,
        releaseInfo: item.pubDate ? new Date(item.pubDate).getFullYear().toString() : undefined,
        behaviorHints: {
            adult: true,
        },
        deepLinks: {
            metaDetailsStreams: href,
            metaDetailsVideos: href,
            player: href,
        },
    };
}

/**
 * Handle a catalog request for the adult-latest / adult-popular / adult-search
 * catalogs. Returns one meta per playable torrent.
 */
async function handleCatalog(catalogId, extra = {}) {
    const config = getConfig();
    const skip = parseInt(extra.skip || '0', 10);
    const genre = extra.genre || '';
    const search = extra.search || '';

    const cacheKey = `catalog:${catalogId}:${skip}:${genre}:${search}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let sortBy = catalogId === 'adult-popular' ? 'seeders' : 'date';
    let query = '';
    if (search) {
        query = search;
        sortBy = 'seeders';
    } else if (genre) {
        query = genre;
    }

    let items;
    try {
        items = await searchProwlarr({
            query,
            offset: skip,
            limit: config.pageSize,
            sortBy,
        });
    } catch (err) {
        console.error('[catalog]', catalogId, err.message);
        return { metas: [] };
    }

    // Map to meta; drop items with no resolvable infoHash (can't be played).
    // Then dedupe by infoHash so duplicate cross-indexer releases don't
    // show up as multiple identical cards.
    const seen = new Set();
    const metas = [];
    for (const item of items) {
        const meta = itemToMeta(item);
        if (!meta) continue;
        const hash = meta.id; // already includes infoHash in the encoded payload
        if (seen.has(hash)) continue;
        seen.add(hash);
        metas.push(meta);
    }

    // Seeders-first for popular / search — the user asked to see the most
    // playable torrents at the top.
    if (sortBy === 'seeders') {
        metas.sort((a, b) => {
            const as = parseInt((a.description || '').match(/S (\d+)/)?.[1] || '0', 10);
            const bs = parseInt((b.description || '').match(/S (\d+)/)?.[1] || '0', 10);
            return bs - as;
        });
    }

    const result = { metas: metas.slice(0, config.pageSize) };
    cache.set(cacheKey, result);
    return result;
}

function clearCatalogCache() {
    const size = cache.size;
    cache.clear();
    return size;
}

module.exports = { handleCatalog, itemToMeta, clearCatalogCache };
