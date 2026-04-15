const { formatSize } = require('./dedup');
const { LRUCache } = require('lru-cache');

// Lazy-load meta module to avoid circular dependency
let _metaModule = null;
function getMetaModule() {
    if (!_metaModule) _metaModule = require('./meta');
    return _metaModule;
}

const streamCache = new LRUCache({
    max: 500,
    ttl: 15 * 60 * 1000,
});

/**
 * Handle a stream request.
 * The videoId format is: "adult-{hash}:{quality}" or just "adult-{hash}"
 */
async function handleStream(videoId) {
    const cached = streamCache.get(videoId);
    if (cached) return cached;

    // Parse the videoId to find the group and quality
    const colonIdx = videoId.indexOf(':');
    const groupId = colonIdx >= 0 ? videoId.slice(0, colonIdx) : videoId;
    const quality = colonIdx >= 0 ? videoId.slice(colonIdx + 1) : null;

    // Try to get the group data from the meta registry
    const { getGroupData } = getMetaModule();
    const groupData = getGroupData(groupId);

    if (groupData) {
        const streams = buildStreamsFromGroup(groupData, quality);
        const result = { streams };
        streamCache.set(videoId, result);
        return result;
    }

    return { streams: [] };
}

function buildStreamsFromGroup(groupData, preferredQuality) {
    const streams = [];

    const variants = preferredQuality
        ? groupData.variants.filter(v => v.quality === preferredQuality)
        : groupData.variants;

    const sourceVariants = variants.length > 0 ? variants : groupData.variants;

    for (const variant of sourceVariants) {
        const stream = {
            name: `${variant.quality}`,
            title: `${variant.originalTitle || groupData.name}\n${variant.seeders} seeders${variant.size ? ' | ' + formatSize(variant.size) : ''}`,
        };

        if (variant.infoHash) {
            stream.infoHash = variant.infoHash;
        } else if (variant.magnetUrl) {
            const match = variant.magnetUrl.match(/btih:([a-fA-F0-9]+)/);
            if (match) {
                stream.infoHash = match[1].toLowerCase();
            } else {
                stream.url = variant.magnetUrl;
            }
        } else if (variant.downloadUrl) {
            stream.url = variant.downloadUrl;
        }

        if (stream.infoHash || stream.url) {
            streams.push(stream);
        }
    }

    return streams;
}

module.exports = { handleStream };
