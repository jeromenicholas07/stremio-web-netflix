// Copyright (C) 2017-2024 Smart code 203358507
// Fetches additional discovery rows from TMDB (trending, popular, top-rated, etc.)
// These supplement the Trakt addon catalogs and TMDB "Because You Watched" rows.

const React = require('react');
const tmdbService = require('stremio/services/TMDBService');

const useTraktRecommendations = () => {
    const [rows, setRows] = React.useState([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        const fetchRows = async () => {
            setLoading(true);

            const [
                trendingMovies,
                trendingSeries,
                popularMovies,
                popularSeries,
                topRatedMovies,
                topRatedSeries,
                nowPlaying,
                upcoming,
                airingToday,
                highRatedRecent,
                actionMovies,
                sciFiMovies,
                comedySeries,
                dramaSeries,
            ] = await Promise.all([
                tmdbService.getTrending('movie', 'week').catch(() => []),
                tmdbService.getTrending('tv', 'week').catch(() => []),
                tmdbService.getPopular('movie').catch(() => []),
                tmdbService.getPopular('tv').catch(() => []),
                tmdbService.getTopRated('movie').catch(() => []),
                tmdbService.getTopRated('tv').catch(() => []),
                tmdbService.getNowPlaying().catch(() => []),
                tmdbService.getUpcoming().catch(() => []),
                tmdbService.getAiringToday().catch(() => []),
                // High-rated recent movies (2024+)
                tmdbService.getDiscover('movie', {
                    sort_by: 'vote_average.desc',
                    'vote_count.gte': '200',
                    'primary_release_date.gte': '2024-01-01',
                }).catch(() => []),
                // Action movies
                tmdbService.getDiscover('movie', {
                    with_genres: '28',
                    sort_by: 'popularity.desc',
                }).catch(() => []),
                // Sci-Fi movies
                tmdbService.getDiscover('movie', {
                    with_genres: '878',
                    sort_by: 'popularity.desc',
                }).catch(() => []),
                // Comedy series
                tmdbService.getDiscover('tv', {
                    with_genres: '35',
                    sort_by: 'popularity.desc',
                }).catch(() => []),
                // Drama series
                tmdbService.getDiscover('tv', {
                    with_genres: '18',
                    sort_by: 'popularity.desc',
                }).catch(() => []),
            ]);

            if (cancelled) return;

            const rowDefs = [
                { title: 'Trending Movies', items: trendingMovies, type: 'movie' },
                { title: 'Trending Series', items: trendingSeries, type: 'tv' },
                { title: 'Now Playing in Theaters', items: nowPlaying, type: 'movie' },
                { title: 'Popular Movies', items: popularMovies, type: 'movie' },
                { title: 'Popular Series', items: popularSeries, type: 'tv' },
                { title: 'Airing Today', items: airingToday, type: 'tv' },
                { title: 'Upcoming Movies', items: upcoming, type: 'movie' },
                { title: 'Critically Acclaimed', items: highRatedRecent, type: 'movie' },
                { title: 'Top Rated Movies', items: topRatedMovies, type: 'movie' },
                { title: 'Top Rated Series', items: topRatedSeries, type: 'tv' },
                { title: 'Action Movies', items: actionMovies, type: 'movie' },
                { title: 'Sci-Fi Movies', items: sciFiMovies, type: 'movie' },
                { title: 'Comedy Series', items: comedySeries, type: 'tv' },
                { title: 'Drama Series', items: dramaSeries, type: 'tv' },
            ];

            const results = rowDefs
                .filter((r) => r.items.length > 0)
                .map((r) => ({
                    title: r.title,
                    items: r.items.map((item) => tmdbService.mapToStremioItem(item, r.type === 'tv' ? 'tv' : 'movie')),
                }));

            if (!cancelled) {
                setRows(results);
                setLoading(false);
            }

            // Enrich items with IMDB IDs in background (so detail pages work with addons)
            for (const row of results) {
                if (cancelled) break;
                await tmdbService.enrichWithImdbIds(row.items);
            }
            if (!cancelled) {
                setRows([...results]); // trigger re-render with updated IDs
            }
        };

        fetchRows();
        return () => { cancelled = true; };
    }, []);

    return { rows, loading };
};

module.exports = useTraktRecommendations;
