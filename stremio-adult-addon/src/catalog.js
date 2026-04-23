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

// Stable fingerprint for items we can't resolve to an infoHash — used as
// the dedupe key and baked into the encoded id so click-to-play can lazy
// resolve via /rd/resolve-url on the addon side.
function fingerprint(downloadUrl, title) {
    const seed = `${downloadUrl || ''}|${title || ''}`;
    let h = 5381;
    for (let i = 0; i < seed.length; i++) {
        h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Convert a raw Prowlarr torrent item into a catalog meta. Always returns
 * a meta — items without a resolved infoHash carry their `downloadUrl` so
 * Torrent.js can lazy-resolve them at click time via /rd/resolve-url.
 * Dropping un-enriched items entirely would leave the catalog looking
 * empty whenever enrichment hits a run of "Invalid torrent file contents"
 * errors from Prowlarr — which is common on adult indexers where the
 * upstream tracker serves HTML instead of .torrent bytes.
 */
// Pull a 40-hex infoHash out of any field that might carry one. Priority:
//   1. Explicit `infoHash` field (already validated 40-hex).
//   2. `magnetUrl` — regex `btih:<hash>`. Free win when the indexer emits
//      a magnet in its Torznab feed; no network round-trip needed and
//      bypasses Prowlarr's `.torrent` fetch which frequently 500s on
//      adult indexers serving HTML instead of bencode.
//   3. `downloadUrl` — some Prowlarr download links are themselves magnets
//      (rare, but cheap to check).
// Returns '' if nothing yields a valid 40-hex hash.
function extractInfoHash(item) {
    const raw = typeof item.infoHash === 'string' ? item.infoHash.toLowerCase() : '';
    if (/^[a-f0-9]{40}$/.test(raw)) return raw;

    const tryMagnet = (s) => {
        if (typeof s !== 'string') return '';
        const m = s.match(/btih:([a-fA-F0-9]{40})/i);
        return m ? m[1].toLowerCase() : '';
    };

    const fromMagnet = tryMagnet(item.magnetUrl);
    if (fromMagnet) return fromMagnet;

    const fromDownload = tryMagnet(item.downloadUrl);
    if (fromDownload) return fromDownload;

    return '';
}

function itemToMeta(item) {
    const infoHash = extractInfoHash(item);
    const downloadUrl = typeof item.downloadUrl === 'string' ? item.downloadUrl : '';
    const magnetUrl = typeof item.magnetUrl === 'string' ? item.magnetUrl : '';

    // Must have SOMETHING we can use to play this later — otherwise the
    // card is pure noise.
    if (!infoHash && !downloadUrl && !magnetUrl) return null;

    const displayName = cleanTitle(item.title) || item.title || 'Untitled';
    const quality = qualityFromTitle(item.title);
    const sizeBytes = Number(item.size) || 0;
    const sizeStr = formatSize(sizeBytes);
    const seeders = Number(item.seeders) || 0;
    const peers = Number(item.peers) || 0;
    const indexer = typeof item.indexer === 'string' ? item.indexer : '';

    // The torrent payload encoded in the id also powers the "Resolving via
    // Real-Debrid…" screen — carry the full at-a-glance metadata so that
    // screen doesn't need a second fetch to display seeders/size/indexer.
    const payload = {
        infoHash,
        // Carry the downloadUrl for lazy resolve when the aggregate couldn't
        // enrich the item. Torrent.js asks the addon to resolve → infoHash
        // on click, then proceeds with the normal RD/magnet flow.
        downloadUrl: infoHash ? '' : downloadUrl,
        magnetUrl: infoHash ? '' : magnetUrl,
        name: displayName,
        title: item.title,
        indexer,
        seeders,
        peers,
        size: sizeBytes,
        quality,
    };
    const id = 'torrent:' + base64UrlEncode(JSON.stringify(payload));
    const href = `#/torrent/${encodeURIComponent(id.slice('torrent:'.length))}`;

    // Compact description: seeders · leechers · size · quality · indexer
    // Users want seeders/leechers at a glance so we lead with them.
    const parts = [];
    parts.push(`S ${seeders}`);
    parts.push(`L ${peers}`);
    if (sizeStr) parts.push(sizeStr);
    if (quality) parts.push(quality);
    if (indexer) parts.push(indexer);
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
        // Explicit structured fields so the Incognito MetaItem variant can
        // render badges without parsing the description string.
        seeders,
        peers,
        leechers: peers,
        sizeBytes,
        size: sizeStr,
        quality,
        indexer,
        // Exposed on the meta so handleCatalog can dedupe on infoHash
        // when present (collapsing cross-indexer duplicates).
        infoHash,
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
    // Allow the client to request a custom page size up to a hard ceiling.
    // Bigger pages = fewer round-trips when scrolling; the ceiling (200)
    // keeps Prowlarr happy and the JSON payload under ~120 KB.
    const rawLimit = parseInt(extra.limit || '0', 10);
    const limit = rawLimit > 0 ? Math.min(rawLimit, 200) : config.pageSize;

    const cacheKey = `catalog:${catalogId}:${skip}:${limit}:${genre}:${search}`;
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
            limit,
            sortBy,
        });
    } catch (err) {
        console.error('[catalog]', catalogId, err.message);
        return { metas: [] };
    }

    // Map to meta; items without a resolvable infoHash still come through
    // carrying their `downloadUrl` — Torrent.js lazy-resolves on click.
    // Dedupe on infoHash when present, else on a fingerprint of
    // downloadUrl+title so duplicate cross-indexer releases collapse.
    const seen = new Set();
    const metas = [];
    for (const item of items) {
        const meta = itemToMeta(item);
        if (!meta) continue;
        const dedupeKey = meta.infoHash
            ? `h:${meta.infoHash}`
            : `f:${fingerprint(item.downloadUrl || '', item.title || '')}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
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

    const result = { metas: metas.slice(0, limit) };
    // Don't cache empty results — an indexer blip or aggregate timeout
    // that yielded zero items should NOT poison the next 3 hours of
    // requests. Retry on the next request instead.
    if (result.metas.length > 0) {
        cache.set(cacheKey, result);
    }
    return result;
}

function clearCatalogCache() {
    const size = cache.size;
    cache.clear();
    return size;
}

module.exports = { handleCatalog, itemToMeta, clearCatalogCache };
