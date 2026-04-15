const { searchProwlarr } = require('./prowlarr');
const { deduplicateItems } = require('./dedup');
const { registerGroup } = require('./meta');
const { getConfig } = require('./config');
const { LRUCache } = require('lru-cache');

const cache = new LRUCache({
    max: 100,
    ttl: 15 * 60 * 1000, // 15 minutes
});

/**
 * Build a Stremio meta preview object from a deduplicated group.
 */
function groupToMeta(group) {
    return {
        id: group.id,
        type: 'other',
        name: group.name,
        poster: group.poster || undefined,
        posterShape: 'poster',
        description: group.description,
        releaseInfo: group.pubDate ? new Date(group.pubDate).getFullYear().toString() : undefined,
        links: [],
        behaviorHints: {
            defaultVideoId: group.variants[0]?.id,
        },
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

    // Build cache key
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
