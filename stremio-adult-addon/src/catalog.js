const { searchProwlarr } = require('./prowlarr');
const { deduplicateItems } = require('./dedup');
const { registerGroup } = require('./meta');
const { getConfig } = require('./config');
const { buildDeepLinks, resolvePoster } = require('./poster');
const { LRUCache } = require('lru-cache');

const cache = new LRUCache({
    max: 100,
    ttl: 15 * 60 * 1000, // 15 minutes
});

/**
 * Build a Stremio meta preview object from a deduplicated group.
 *
 * IMPORTANT: deepLinks.metaDetailsStreams points at the Incognito-specific
 * route in stremio-web. MetaItem uses it as the click target, so omitting
 * deepLinks makes catalog items unclickable — that was the root cause of
 * the "grey unclickable cards" symptom.
 */
function groupToMeta(group) {
    return {
        id: group.id,
        type: 'other',
        name: group.name,
        poster: resolvePoster(group),
        posterShape: 'poster',
        background: resolvePoster(group),
        description: group.description,
        releaseInfo: group.pubDate ? new Date(group.pubDate).getFullYear().toString() : undefined,
        links: [],
        behaviorHints: {
            adult: true,
            defaultVideoId: group.variants[0]?.id,
        },
        deepLinks: buildDeepLinks(group.id),
    };
}

/**
 * Handle a catalog request.
 * @param {string} catalogId - 'adult-latest' or 'adult-popular'
 * @param {object} extra - Extra parameters (skip, genre, search)
 */
async function handleCatalog(catalogId, extra = {}) {
    const config = getConfig();
    const skip = parseInt(extra.skip || '0', 10);
    const genre = extra.genre || '';
    const search = extra.search || '';

    const cacheKey = `catalog:${catalogId}:${skip}:${genre}:${search}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let sortBy = 'date';
    let query = '';

    if (catalogId === 'adult-popular') {
        sortBy = 'seeders';
    }

    if (search) {
        query = search;
        // When searching, "most seeders first" is what users expect.
        sortBy = 'seeders';
    } else if (genre) {
        query = genre;
    }

    const items = await searchProwlarr({
        query,
        offset: skip,
        limit: config.pageSize,
        sortBy,
    });

    const groups = deduplicateItems(items);

    // When searching, push the groups with the most seeders to the top.
    if (sortBy === 'seeders') {
        groups.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    }

    // Register each group for later meta/stream lookups
    for (const group of groups) {
        registerGroup(group);
    }

    const metas = groups.map(groupToMeta);

    const result = { metas };
    cache.set(cacheKey, result);
    return result;
}

module.exports = { handleCatalog, groupToMeta };
