// Hook that returns Trakt Watchlist and Not Interested list items as Stremio-compatible catalog items.
// Caches enriched items so only new items trigger TMDB lookups.
// Listens to TraktBridge changes for immediate UI updates after add/remove operations.

const React = require('react');
const traktBridge = require('stremio/services/TraktBridge');
const tmdbService = require('stremio/services/TMDBService');
// Mobile (iOS/Android): the personal Trakt list rows are intentionally dropped
// to keep the home page light and stable, so this hook no-ops there.
const { isMobile } = require('stremio/common/Platform/device');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Convert a TraktBridge item into a Stremio-compatible MetaItem with TMDB poster.
async function enrichItem(item) {
    let poster = '';
    let background = '';
    let posterFallback = '';
    try {
        const mediaType = item.type === 'series' ? 'tv' : 'movie';
        let tmdbId = item.tmdbId;

        if (!tmdbId && item.imdbId) {
            const found = await tmdbService.findByImdbId(item.imdbId);
            if (found) tmdbId = found.id;
        }

        if (tmdbId) {
            const details = await tmdbService.getDetails(tmdbId, mediaType);
            if (details?.backdrop_path) {
                background = `${TMDB_IMAGE_BASE}/original${details.backdrop_path}`;
                poster = `${TMDB_IMAGE_BASE}/w1280${details.backdrop_path}`;
            }
            if (details?.poster_path) {
                posterFallback = `${TMDB_IMAGE_BASE}/w500${details.poster_path}`;
            }
        }
    } catch { /* silent */ }

    const stremioType = item.type === 'series' ? 'series' : 'movie';
    return {
        id: item.id,
        name: item.name,
        type: stremioType,
        poster: poster || posterFallback,
        background: background,
        posterShape: 'landscape',
        releaseInfo: item.year ? String(item.year) : '',
        deepLinks: {
            metaDetailsStreams: `#/metadetails/${stremioType}/${item.id}`,
            metaDetailsVideos: `#/metadetails/${stremioType}/${item.id}`,
        },
    };
}

// Incrementally enrich: reuse already-enriched items, only fetch TMDB for new ones.
// Returns items in the same order as rawItems.
async function enrichIncremental(rawItems, cache) {
    const result = [];
    const toEnrich = [];
    const toEnrichIndices = [];

    for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        if (cache.has(raw.id)) {
            result[i] = cache.get(raw.id);
        } else {
            result[i] = null; // placeholder
            toEnrich.push(raw);
            toEnrichIndices.push(i);
        }
    }

    if (toEnrich.length > 0) {
        const enriched = await Promise.all(toEnrich.map(enrichItem));
        for (let j = 0; j < enriched.length; j++) {
            const item = enriched[j];
            if (item.name) {
                result[toEnrichIndices[j]] = item;
                cache.set(item.id, item);
            }
        }
    }

    return result.filter(Boolean);
}

function useTraktLists() {
    const [watchlistItems, setWatchlistItems] = React.useState([]);
    const [notInterestedItems, setNotInterestedItems] = React.useState([]);

    // Persistent enrichment caches (survive re-renders, cleared on unmount)
    const watchlistCacheRef = React.useRef(new Map());
    const niCacheRef = React.useRef(new Map());

    // Build counter to prevent stale async builds from overwriting fresh state.
    // When a new buildItems() starts, it increments the counter; when the async
    // enrichment completes, it only applies state if its counter still matches.
    const buildCounterRef = React.useRef(0);

    React.useEffect(() => {
        if (isMobile) return;
        let cancelled = false;

        const buildItems = async () => {
            if (!traktBridge.isConfigured()) return;

            const myBuildId = ++buildCounterRef.current;

            // Build watchlist items (incremental enrichment)
            const rawWatchlist = traktBridge.getWatchlistItems();
            if (rawWatchlist.length === 0) {
                if (!cancelled && myBuildId === buildCounterRef.current) setWatchlistItems([]);
            } else {
                const batch = rawWatchlist.slice(0, 40);
                const enriched = await enrichIncremental(batch, watchlistCacheRef.current);
                if (!cancelled && myBuildId === buildCounterRef.current) setWatchlistItems(enriched);
            }

            // Build not-interested items (incremental enrichment)
            const rawNi = traktBridge.getNotInterestedItems();
            if (rawNi.length === 0) {
                if (!cancelled && myBuildId === buildCounterRef.current) setNotInterestedItems([]);
            } else {
                const batch = rawNi.slice(0, 40);
                const enriched = await enrichIncremental(batch, niCacheRef.current);
                if (!cancelled && myBuildId === buildCounterRef.current) setNotInterestedItems(enriched);
            }
        };

        buildItems();

        // Re-build when TraktBridge data changes (add/remove/sync)
        const unsub = traktBridge.onChange(() => {
            if (!cancelled) buildItems();
        });

        return () => {
            cancelled = true;
            unsub();
        };
    }, []);

    return { watchlistItems, notInterestedItems };
}

module.exports = useTraktLists;
