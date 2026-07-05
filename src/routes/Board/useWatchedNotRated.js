// Hook that returns Trakt watched-but-not-rated items as Stremio-compatible catalog items.
// Fetches TMDB posters for each item so they can be rendered as MetaItems.

const React = require('react');
const traktBridge = require('stremio/services/TraktBridge');
const tmdbService = require('stremio/services/TMDBService');
// Mobile: the Watched-Not-Rated row is dropped for a lighter home page.
const { isMobile } = require('stremio/common/Platform/device');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function useWatchedNotRated() {
    const [items, setItems] = React.useState([]);
    const buildCounterRef = React.useRef(0);

    React.useEffect(() => {
        if (isMobile) return;
        let cancelled = false;

        const buildItems = async () => {
            if (!traktBridge.isConfigured()) return;

            const myBuildId = ++buildCounterRef.current;

            const unrated = traktBridge.getWatchedNotRated();
            if (unrated.length === 0) {
                if (!cancelled && myBuildId === buildCounterRef.current) setItems([]);
                return;
            }

            // Take up to 20 most recent unrated items
            const batch = unrated.slice(0, 20);

            // Fetch TMDB posters in parallel
            const enriched = await Promise.all(batch.map(async (item) => {
                let poster = '';
                let background = '';
                let posterFallback = '';
                try {
                    const mediaType = item.type === 'series' ? 'tv' : 'movie';
                    let tmdbId = item.tmdbId;

                    // If we only have IMDB ID, resolve to TMDB
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

                // Build Stremio-compatible item
                const stremioType = item.type === 'series' ? 'series' : 'movie';
                return {
                    id: item.id,
                    name: item.name,
                    type: stremioType,
                    poster: poster || posterFallback, // landscape backdrop preferred
                    background: background,
                    posterShape: 'landscape',
                    releaseInfo: item.year ? String(item.year) : '',
                    deepLinks: {
                        metaDetailsStreams: `#/metadetails/${stremioType}/${item.id}`,
                        metaDetailsVideos: `#/metadetails/${stremioType}/${item.id}`,
                    },
                    watchedAt: item.watchedAt,
                };
            }));

            if (!cancelled && myBuildId === buildCounterRef.current) {
                setItems(enriched.filter((i) => i.name));
            }
        };

        buildItems();

        // Re-build when TraktBridge data changes (e.g. after rating)
        const unsub = traktBridge.onChange(() => {
            if (!cancelled) buildItems();
        });

        return () => {
            cancelled = true;
            unsub();
        };
    }, []);

    return items;
}

module.exports = useWatchedNotRated;
