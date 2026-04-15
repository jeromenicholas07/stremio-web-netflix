const { LRUCache } = require('lru-cache');

const metaCache = new LRUCache({
    max: 500,
    ttl: 30 * 60 * 1000,
});

// Registry to store group data between catalog and meta/stream requests.
const groupRegistry = new Map();

function registerGroup(group) {
    groupRegistry.set(group.id, group);
    // Auto-expire after 1 hour
    setTimeout(() => groupRegistry.delete(group.id), 60 * 60 * 1000);
}

function getGroupData(id) {
    return groupRegistry.get(id);
}

/**
 * Handle a meta request for a grouped item.
 * Returns full meta with quality variants as "videos".
 */
async function handleMeta(id) {
    const cached = metaCache.get(id);
    if (cached) return cached;

    const groupData = groupRegistry.get(id);
    if (!groupData) {
        return { meta: null };
    }

    const meta = {
        id: groupData.id,
        type: 'other',
        name: groupData.name,
        poster: groupData.poster || undefined,
        posterShape: 'poster',
        description: groupData.description,
        releaseInfo: groupData.pubDate ? new Date(groupData.pubDate).getFullYear().toString() : undefined,
        videos: groupData.variants.map(variant => ({
            id: variant.id,
            title: variant.title,
            released: groupData.pubDate || undefined,
            streams: [],
        })),
        behaviorHints: {
            defaultVideoId: groupData.variants[0]?.id,
        },
    };

    const result = { meta };
    metaCache.set(id, result);
    return result;
}

module.exports = { handleMeta, registerGroup, getGroupData };
