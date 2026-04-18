const fetch = require('node-fetch');
const { parseString } = require('xml2js');
const { getConfig } = require('./config');

function parseXml(xml) {
    return new Promise((resolve, reject) => {
        parseString(xml, { explicitArray: false, ignoreAttrs: false }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

function extractTorznabAttrs(item) {
    const attrs = {};
    const torznabAttrs = item['torznab:attr'];
    if (!torznabAttrs) return attrs;
    const list = Array.isArray(torznabAttrs) ? torznabAttrs : [torznabAttrs];
    for (const attr of list) {
        const name = attr?.$ ?.name;
        const value = attr?.$ ?.value;
        if (name && value !== undefined) {
            attrs[name] = value;
        }
    }
    return attrs;
}

function parseItem(item) {
    const attrs = extractTorznabAttrs(item);
    return {
        title: item.title || '',
        link: item.link || '',
        guid: typeof item.guid === 'object' ? item.guid._ || item.guid : item.guid || '',
        pubDate: item.pubDate || '',
        size: parseInt(item.size || attrs.size || '0', 10),
        seeders: parseInt(attrs.seeders || '0', 10),
        peers: parseInt(attrs.peers || '0', 10),
        infoHash: attrs.infohash || '',
        magnetUrl: attrs.magneturl || '',
        downloadUrl: item.link || '',
        category: attrs.category || '',
        poster: attrs.poster || attrs.coverurl || '',
    };
}

/**
 * Search Prowlarr via its API for adult content.
 * @param {object} options
 * @param {string} [options.query] - Search query (empty for latest/browse)
 * @param {number} [options.offset] - Result offset for pagination
 * @param {number} [options.limit] - Max results to return
 * @param {string} [options.sortBy] - 'seeders' or 'date' (default: date)
 * @returns {Promise<Array>} Array of parsed torrent items
 */
async function searchProwlarr({ query = '', offset = 0, limit, sortBy = 'date', categories: categoriesOpt } = {}) {
    const config = getConfig();
    if (!config.prowlarrApiKey) {
        throw new Error('Prowlarr API key not configured');
    }

    limit = limit || config.pageSize;
    const categoryList = Array.isArray(categoriesOpt) && categoriesOpt.length > 0
        ? categoriesOpt
        : config.adultCategories;
    const categories = categoryList.join(',');

    // Use Prowlarr's search API endpoint
    const params = new URLSearchParams({
        query: query,
        categories: categories,
        offset: String(offset),
        limit: String(limit),
        type: 'search',
    });

    const url = `${config.prowlarrUrl}/api/v1/search?${params}`;
    const response = await fetch(url, {
        headers: {
            'X-Api-Key': config.prowlarrApiKey,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        // Fallback: try Torznab API directly via indexers
        return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
    }

    const data = await response.json();

    // Prowlarr JSON API returns array of release objects
    const items = data.map(release => ({
        title: release.title || '',
        link: release.downloadUrl || release.magnetUrl || '',
        guid: release.guid || release.title || '',
        pubDate: release.publishDate || '',
        size: release.size || 0,
        seeders: release.seeders || 0,
        peers: release.leechers || 0,
        infoHash: release.infoHash || '',
        magnetUrl: release.magnetUrl || '',
        downloadUrl: release.downloadUrl || '',
        category: String(release.categories?.[0]?.id || '6000'),
        poster: release.posterUrl || '',
        indexer: release.indexer || '',
    }));

    // Sort
    if (sortBy === 'seeders') {
        items.sort((a, b) => b.seeders - a.seeders);
    } else {
        items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }

    return items;
}

/**
 * Fallback: search via Torznab XML API on individual indexers
 */
async function searchViaTorznab({ query = '', offset = 0, limit = 50, sortBy = 'date', categories: categoriesOpt } = {}) {
    const config = getConfig();
    const categoryList = Array.isArray(categoriesOpt) && categoriesOpt.length > 0
        ? categoriesOpt
        : config.adultCategories;

    // Get list of indexers from Prowlarr
    const indexersRes = await fetch(`${config.prowlarrUrl}/api/v1/indexer`, {
        headers: { 'X-Api-Key': config.prowlarrApiKey },
    });

    if (!indexersRes.ok) {
        throw new Error(`Failed to fetch Prowlarr indexers: ${indexersRes.status}`);
    }

    const indexers = await indexersRes.json();

    // Filter to indexers that support the requested categories
    const matchingIndexers = indexers.filter(idx => {
        const caps = idx.capabilities?.categories || [];
        return caps.some(cat => categoryList.includes(cat.id));
    });

    if (matchingIndexers.length === 0) {
        return [];
    }

    // Query each indexer via Torznab
    const allItems = [];
    const fetchPromises = matchingIndexers.map(async (indexer) => {
        try {
            const torznabUrl = `${config.prowlarrUrl}/${indexer.id}/api?apikey=${config.prowlarrApiKey}&t=search&cat=${categoryList.join(',')}&q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`;

            const res = await fetch(torznabUrl, { timeout: 10000 });
            if (!res.ok) return [];

            const xml = await res.text();
            const parsed = await parseXml(xml);
            const channel = parsed?.rss?.channel;
            if (!channel?.item) return [];

            const items = Array.isArray(channel.item) ? channel.item : [channel.item];
            return items.map(item => ({
                ...parseItem(item),
                indexer: indexer.name || '',
            }));
        } catch {
            return [];
        }
    });

    const results = await Promise.allSettled(fetchPromises);
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            allItems.push(...result.value);
        }
    }

    // Sort
    if (sortBy === 'seeders') {
        allItems.sort((a, b) => b.seeders - a.seeders);
    } else {
        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }

    return allItems.slice(0, limit);
}

module.exports = { searchProwlarr };
