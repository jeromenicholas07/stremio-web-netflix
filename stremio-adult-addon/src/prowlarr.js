const fetch = require('node-fetch');
const { parseString } = require('xml2js');
const { LRUCache } = require('lru-cache');
const parseTorrent = require('parse-torrent');
const { getConfig, invalidateApiKeyCache } = require('./config');

// Cache resolved infoHashes keyed by downloadUrl — the HTTP 302 redirect
// from Prowlarr's /download endpoint is deterministic per release.
const infoHashCache = new LRUCache({ max: 2000, ttl: 6 * 60 * 60 * 1000 });

/**
 * Many Prowlarr indexers return releases with no `infoHash` and no
 * `magnetUrl`, just a `downloadUrl`. Prowlarr's /download endpoint can
 * either:
 *   (a) 302-redirect to a magnet URI (handled via Location header), or
 *   (b) return the raw .torrent bytes (handled by bencode-parsing the
 *       response body to extract the info-dict SHA-1).
 *
 * Case (b) is the common one for indexers that scrape HTTP-only trackers
 * (MyPornClub, OneJAV, PornRips): Prowlarr fetches the .torrent file from
 * the upstream and streams its bytes back. We need to parse those bytes
 * to get the infoHash — without that, every such item gets dropped and
 * the catalog looks empty.
 *
 * Returns lowercase 40-char hex infoHash or null.
 */
async function resolveInfoHashFromDownloadUrl(downloadUrl) {
    if (!downloadUrl) return null;
    const cached = infoHashCache.get(downloadUrl);
    if (cached !== undefined) return cached;

    try {
        // Manual redirect so we can see the Location header directly —
        // node-fetch errors ("Only absolute URLs are supported") when it
        // tries to follow a magnet: URI, which is exactly what Prowlarr
        // sends for case (a). We must intercept the 301/302 ourselves.
        const res = await fetch(downloadUrl, {
            redirect: 'manual',
            timeout: 7000,
        });

        let result = null;

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location') || '';
            // Case (a): Location is a magnet URI with btih.
            const magnetMatch = loc.match(/btih:([a-fA-F0-9]{40})/i);
            if (magnetMatch) {
                result = magnetMatch[1].toLowerCase();
            }
            // Other HTTP redirect targets are rare from Prowlarr — skip
            // chained follow-ups to keep latency bounded.
        } else if (res.ok) {
            // Case (b): body IS the .torrent bytes. Bencoded dicts start
            // with ASCII 'd' (0x64). Parse to extract info-dict SHA-1.
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 0 && buf[0] === 0x64) {
                try {
                    const parsed = parseTorrent(buf);
                    if (parsed && typeof parsed.infoHash === 'string' && /^[a-f0-9]{40}$/i.test(parsed.infoHash)) {
                        result = parsed.infoHash.toLowerCase();
                    }
                } catch { /* not a valid torrent file; fall through */ }
            }
        }

        infoHashCache.set(downloadUrl, result);
        return result;
    } catch {
        infoHashCache.set(downloadUrl, null);
        return null;
    }
}

/**
 * Enrich items missing infoHash/magnetUrl by following their downloadUrl
 * redirect. Runs in parallel with a small concurrency cap.
 */
async function enrichMissingInfoHashes(items) {
    const needsResolution = items.filter(it =>
        !it.infoHash &&
        !(it.magnetUrl && /btih:/i.test(it.magnetUrl)) &&
        it.downloadUrl
    );
    // Prowlarr is loopback but each resolve triggers an upstream fetch
    // against the real indexer site, which is slow and rate-limited. Too
    // much concurrency → upstream starts 429-ing or dropping connections
    // and most of them time out. 6 is a conservative sweet spot.
    const CONCURRENCY = 6;
    let idx = 0;
    async function worker() {
        while (idx < needsResolution.length) {
            const it = needsResolution[idx++];
            const hash = await resolveInfoHashFromDownloadUrl(it.downloadUrl);
            if (hash) it.infoHash = hash;
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

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
    let config = getConfig();
    if (!config.prowlarrApiKey) {
        // Force-reload once in case Prowlarr only just wrote config.xml
        invalidateApiKeyCache();
        config = getConfig();
        if (!config.prowlarrApiKey) {
            throw new Error('Prowlarr API key not configured');
        }
    }

    limit = limit || config.pageSize;
    const categoryList = Array.isArray(categoriesOpt) && categoriesOpt.length > 0
        ? categoriesOpt
        : config.adultCategories;

    // Prowlarr accepts X-Api-Key header OR apikey query param. Sending both
    // is belt-and-braces: works even when AuthenticationRequired=Enabled and
    // the header gets dropped by an intermediary.
    //
    // IMPORTANT: Prowlarr 1.28+ rejects `categories=6000,6010,...` as a
    // single comma-separated string (HTTP 400 "not a valid value"). It
    // expects `categories` to be a repeated query parameter — one entry
    // per category. Hence the explicit append loop below instead of a
    // single `categories: list.join(',')` entry in the initial map.
    async function doFetch(apiKey) {
        const params = new URLSearchParams({
            query: query,
            offset: String(offset),
            limit: String(limit),
            type: 'search',
            apikey: apiKey,
        });
        for (const cat of categoryList) params.append('categories', String(cat));
        const url = `${config.prowlarrUrl}/api/v1/search?${params}`;
        // Hard 5s timeout. Prowlarr's aggregate /search endpoint waits for
        // the SLOWEST indexer — so a single broken/slow indexer (e.g.
        // MyPornClub, PornRips going 30s+ with empty query) hangs the whole
        // call. The per-indexer Torznab fallback uses Promise.allSettled
        // with individual timeouts, so it's immune to any single bad indexer.
        // Keeping this short means we fail fast to Torznab rather than
        // blocking the catalog for 10+ seconds.
        return fetch(url, {
            headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
            timeout: 5000,
        });
    }

    let response;
    try {
        response = await doFetch(config.prowlarrApiKey);
    } catch (err) {
        console.warn('[prowlarr] aggregate /search failed, falling through to Torznab:', err.message);
        return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
    }

    // On 401, the on-disk key may have rotated (first-run Prowlarr writes a
    // fresh key on boot, possibly after we cached an earlier stub). Bust the
    // cache, re-read, retry once.
    if (response.status === 401) {
        console.warn('[prowlarr] 401 — re-reading API key from config.xml and retrying');
        invalidateApiKeyCache();
        config = getConfig();
        if (config.prowlarrApiKey) {
            try {
                response = await doFetch(config.prowlarrApiKey);
            } catch (err) {
                console.warn('[prowlarr] retry failed, falling through to Torznab:', err.message);
                return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
            }
        }
    }

    if (!response.ok) {
        // Fallback: try Torznab API directly via indexers
        return searchViaTorznab({ query, offset, limit, sortBy, categories: categoryList });
    }

    const data = await response.json();

    // Prowlarr JSON API returns array of release objects
    const items = data.map(release => {
        let infoHash = (release.infoHash || '').toLowerCase();
        const magnetUrl = release.magnetUrl || '';
        // Extract from magnet if infoHash is missing but magnet is present
        if (!infoHash && magnetUrl) {
            const m = magnetUrl.match(/btih:([a-fA-F0-9]{40})/);
            if (m) infoHash = m[1].toLowerCase();
        }
        return {
            title: release.title || '',
            link: release.downloadUrl || release.magnetUrl || '',
            guid: release.guid || release.title || '',
            pubDate: release.publishDate || '',
            size: release.size || 0,
            seeders: release.seeders || 0,
            peers: release.leechers || 0,
            infoHash,
            magnetUrl,
            downloadUrl: release.downloadUrl || '',
            category: String(release.categories?.[0]?.id || '6000'),
            poster: release.posterUrl || '',
            indexer: release.indexer || '',
        };
    });

    // For items still missing infoHash, follow the downloadUrl redirect
    // (Prowlarr usually 302s to a magnet URI).
    await enrichMissingInfoHashes(items);

    // Sort (now that infoHashes are resolved, seeders is the useful signal)
    if (sortBy === 'seeders') {
        items.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
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

    // Get list of indexers from Prowlarr. Send key in header AND query-string.
    async function fetchIndexers(apiKey) {
        return fetch(`${config.prowlarrUrl}/api/v1/indexer?apikey=${encodeURIComponent(apiKey)}`, {
            headers: { 'X-Api-Key': apiKey },
        });
    }
    let indexersRes = await fetchIndexers(config.prowlarrApiKey);

    if (indexersRes.status === 401) {
        console.warn('[prowlarr/torznab] 401 on /indexer — re-reading key and retrying');
        invalidateApiKeyCache();
        const reloaded = getConfig();
        if (reloaded.prowlarrApiKey) {
            indexersRes = await fetchIndexers(reloaded.prowlarrApiKey);
        }
    }

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

    // Sort FIRST so we enrich only the top-N we actually return. Torznab
    // can aggregate hundreds of items across indexers and enriching all of
    // them (each a 302 redirect fetch) would take 30s+. We sort on the raw
    // seeders/pubDate fields which are always present from Torznab.
    if (sortBy === 'seeders') {
        allItems.sort((a, b) => b.seeders - a.seeders);
    } else {
        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }

    const sliced = allItems.slice(0, limit);

    // Torznab responses usually expose only a downloadUrl that 302-redirects
    // to a magnet — the `infohash`/`magneturl` torznab:attr fields are often
    // missing. Without enrichment, every such item gets dropped downstream
    // by the hex-regex filter in itemToMeta (which in turn leaves catalogs
    // showing 0 cards even when Torznab returned hundreds of results).
    await enrichMissingInfoHashes(sliced);

    return sliced;
}

module.exports = { searchProwlarr };
