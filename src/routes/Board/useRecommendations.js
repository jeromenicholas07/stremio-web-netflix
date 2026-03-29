// Copyright (C) 2017-2024 Smart code 203358507

const React = require('react');
const tmdbService = require('stremio/services/TMDBService');
const useContinueWatchingPreview = require('./useContinueWatchingPreview');

const useRecommendations = () => {
    const continueWatching = useContinueWatchingPreview();
    const [recommendations, setRecommendations] = React.useState([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!tmdbService.getApiKey()) {
            setRecommendations([]);
            return;
        }

        const items = continueWatching?.items;
        if (!Array.isArray(items) || items.length === 0) {
            setRecommendations([]);
            return;
        }

        let cancelled = false;
        const fetchRecs = async () => {
            setLoading(true);
            const recentItems = items.slice(0, 3);
            const results = [];

            for (const item of recentItems) {
                try {
                    const imdbId = item._id || item.id;
                    if (!imdbId || !imdbId.startsWith('tt')) continue;

                    const tmdbResult = await tmdbService.findByImdbId(imdbId);
                    if (!tmdbResult) continue;

                    const mediaType = tmdbResult.type === 'tv' ? 'tv' : 'movie';
                    const recs = await tmdbService.getRecommendations(tmdbResult.id, mediaType);
                    if (recs.length === 0) continue;

                    const mappedItems = recs.map(r => tmdbService.mapToStremioItem(r, mediaType));

                    results.push({
                        title: `Because You Watched ${item.name}`,
                        items: mappedItems,
                        posterShape: 'poster',
                    });
                } catch {
                    // skip failed lookups
                }
            }

            if (!cancelled) {
                setRecommendations(results);
                setLoading(false);
            }

            // Enrich items with IMDB IDs in background (so detail pages work with addons)
            for (const rec of results) {
                if (cancelled) break;
                await tmdbService.enrichWithImdbIds(rec.items);
            }
            if (!cancelled) {
                setRecommendations([...results]);
            }
        };

        fetchRecs();
        return () => { cancelled = true; };
    }, [continueWatching?.items?.length]);

    return { recommendations, loading };
};

module.exports = useRecommendations;
