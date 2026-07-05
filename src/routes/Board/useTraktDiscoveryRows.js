// Hook that fetches discovery rows directly from the Trakt API and enriches
// them with TMDB poster/backdrop. Replaces the Trakt addon catalog rows so
// we control item count, dedup, and have a single source of truth — no addon
// required.

const React = require('react');
const traktBridge = require('stremio/services/TraktBridge');
const tmdbService = require('stremio/services/TMDBService');
// Mobile: the Trakt-sourced discovery rows (Trending/Popular/Recommended/…) are
// dropped on phones. They are the heaviest thing on the board (Trakt API +
// per-item TMDB enrichment) and the biggest contributor to the iOS memory
// crash, so this hook no-ops there — the home falls back to Continue Watching
// plus the lightweight core addon catalogs.
const { isMobile } = require('stremio/common/Platform/device');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const FETCH_LIMIT = 50;

// Built-in row definitions.
//   key:          react key
//   title:        row label
//   path:         Trakt API path (with limit + extended=full)
//   mediaType:    'movie' | 'series' | null  (null = mixed user list, infer per item)
//   requiresAuth: row only loads when user is signed in
const ROW_DEFS = [
    // Personalised
    { key: 'rec-movies',         title: 'Recommended Movies',         path: `/recommendations/movies?limit=${FETCH_LIMIT}&extended=full&ignore_collected=true`, mediaType: 'movie',  requiresAuth: true },
    { key: 'rec-shows',          title: 'Recommended Shows',          path: `/recommendations/shows?limit=${FETCH_LIMIT}&extended=full&ignore_collected=true`,  mediaType: 'series', requiresAuth: true },
    // Public discovery
    { key: 'trending-movies',    title: 'Trending Movies',            path: `/movies/trending?limit=${FETCH_LIMIT}&extended=full`,         mediaType: 'movie'  },
    { key: 'trending-shows',     title: 'Trending Shows',             path: `/shows/trending?limit=${FETCH_LIMIT}&extended=full`,          mediaType: 'series' },
    { key: 'popular-movies',     title: 'Popular Movies',             path: `/movies/popular?limit=${FETCH_LIMIT}&extended=full`,          mediaType: 'movie'  },
    { key: 'popular-shows',      title: 'Popular Shows',              path: `/shows/popular?limit=${FETCH_LIMIT}&extended=full`,           mediaType: 'series' },
    { key: 'watched-wk-movies',  title: 'Most Watched Movies (Week)', path: `/movies/watched/weekly?limit=${FETCH_LIMIT}&extended=full`,   mediaType: 'movie'  },
    { key: 'watched-wk-shows',   title: 'Most Watched Shows (Week)',  path: `/shows/watched/weekly?limit=${FETCH_LIMIT}&extended=full`,    mediaType: 'series' },
    { key: 'anticipated-movies', title: 'Anticipated Movies',         path: `/movies/anticipated?limit=${FETCH_LIMIT}&extended=full`,      mediaType: 'movie'  },
    { key: 'anticipated-shows',  title: 'Anticipated Shows',          path: `/shows/anticipated?limit=${FETCH_LIMIT}&extended=full`,       mediaType: 'series' },
    { key: 'boxoffice',          title: 'Box Office',                 path: `/movies/boxoffice?limit=${FETCH_LIMIT}&extended=full`,        mediaType: 'movie'  },
];

// User-curated Trakt lists. Find lists at https://trakt.tv/lists — click any
// list, the URL is https://trakt.tv/users/<user>/lists/<slug>. If a slug 404s
// (maintainer renamed/deleted), the row is silently skipped.
const USER_LISTS = [
    { title: 'IMDb Top 250',                 user: 'justin',      slug: 'imdb-top-250' },
    { title: 'Letterboxd Top 250',           user: 'jamesoneill', slug: 'letterboxd-com-s-official-top-250-narrative-feature-films' },
    { title: 'Oscar Best Picture Winners',   user: 'jaegusto',    slug: 'oscar-winners-best-picture' },
    { title: 'A24 Films',                    user: 'rockerjuli',  slug: 'a24-films' },
    { title: 'Studio Ghibli',                user: 'donxy',       slug: 'studio-ghibli' },
    { title: 'Marvel Cinematic Universe',    user: 'donxy',       slug: 'marvel-cinematic-universe' },
];

// Unwrap Trakt response. Trakt returns several shapes depending on endpoint:
//   wrapped:  [{ movie: {...} }] or [{ show: {...} }]
//   flat:     [{ title, year, ids, ... }]                       (popular, recommendations)
//   userlist: [{ rank, type: 'movie'|'show', movie/show: {...}}]
function unwrapTraktItems(rawArr, mediaType) {
    if (!Array.isArray(rawArr)) return [];
    const results = [];
    for (const entry of rawArr) {
        if (!entry) continue;
        let obj = null;
        let type = mediaType;
        if (entry.movie) { obj = entry.movie; type = 'movie'; }
        else if (entry.show) { obj = entry.show; type = 'series'; }
        else if (entry.title && entry.ids) { obj = entry; }
        if (!obj || !obj.ids) continue;
        results.push({
            title: obj.title || '',
            year: obj.year || null,
            imdbId: obj.ids.imdb || null,
            tmdbId: obj.ids.tmdb || null,
            mediaType: type,
        });
    }
    return results;
}

// Build a Stremio MetaItem placeholder (images filled in by enrichItem).
// Prefers IMDB IDs so Cinemeta-compatible addons resolve streams correctly.
function toStremioItemBase(item) {
    if (!item.mediaType) return null;
    const id = item.imdbId || (item.tmdbId ? `tmdb:${item.tmdbId}` : null);
    if (!id) return null;
    return {
        id,
        name: item.title,
        type: item.mediaType,
        poster: '',
        background: '',
        posterShape: 'landscape',
        releaseInfo: item.year ? String(item.year) : '',
        _tmdbId: item.tmdbId,
        deepLinks: {
            metaDetailsStreams: `#/metadetails/${item.mediaType}/${id}`,
            metaDetailsVideos: `#/metadetails/${item.mediaType}/${id}`,
        },
    };
}

// Enrich a single item with TMDB poster/backdrop. Mutates and returns it.
async function enrichItem(item) {
    try {
        const tmdbType = item.type === 'series' ? 'tv' : 'movie';
        let tmdbId = item._tmdbId;
        if (!tmdbId && item.id && item.id.startsWith('tt')) {
            const found = await tmdbService.findByImdbId(item.id);
            if (found) tmdbId = found.id;
        }
        if (tmdbId) {
            const details = await tmdbService.getDetails(tmdbId, tmdbType);
            if (details?.backdrop_path) {
                item.background = `${TMDB_IMAGE_BASE}/original${details.backdrop_path}`;
                item.poster = `${TMDB_IMAGE_BASE}/w1280${details.backdrop_path}`;
            } else if (details?.poster_path) {
                item.poster = `${TMDB_IMAGE_BASE}/w500${details.poster_path}`;
            }
        }
    } catch { /* silent */ }
    return item;
}

async function enrichBatch(items, cache) {
    const toFetch = [];
    for (const it of items) {
        if (!it) continue;
        if (cache.has(it.id)) {
            const cached = cache.get(it.id);
            it.poster = cached.poster;
            it.background = cached.background;
        } else {
            toFetch.push(it);
        }
    }
    if (toFetch.length > 0) {
        await Promise.all(toFetch.map(async (it) => {
            await enrichItem(it);
            cache.set(it.id, { poster: it.poster, background: it.background });
        }));
    }
    return items.filter((it) => it && it.name);
}

function useTraktDiscoveryRows() {
    const [rows, setRows] = React.useState([]);
    const cacheRef = React.useRef(new Map());
    const buildCounterRef = React.useRef(0);

    React.useEffect(() => {
        if (isMobile) return;
        let cancelled = false;

        const run = async () => {
            if (!traktBridge.isConfigured()) {
                setRows([]);
                return;
            }
            const isConnected = traktBridge.isConnected();
            const myBuildId = ++buildCounterRef.current;

            // Built-in rows (drop personalised when not signed in)
            const builtIn = ROW_DEFS.filter((d) => !d.requiresAuth || isConnected);

            // User-curated lists
            const userListDefs = USER_LISTS.map((l, i) => ({
                key: `userlist-${i}`,
                title: l.title,
                path: `/users/${encodeURIComponent(l.user)}/lists/${encodeURIComponent(l.slug)}/items?limit=${FETCH_LIMIT}&extended=full`,
                mediaType: null, // mixed — infer per entry
                requiresAuth: false,
            }));

            const allDefs = [...builtIn, ...userListDefs];

            // Fetch every row in parallel — cached via localStorage with SWR
            // fallback so we don't hammer the Trakt API on every remount.
            //   - Recommendations (auth):   30 min TTL
            //   - Public discovery rows:    1 hour TTL
            //   - User-curated lists:       6 hour TTL (rarely change)
            const AUTH_TTL = 30 * 60 * 1000;
            const DISCOVERY_TTL = 60 * 60 * 1000;
            const USERLIST_TTL = 6 * 60 * 60 * 1000;
            const responses = await Promise.all(allDefs.map((def) => {
                let p;
                if (def.requiresAuth) {
                    p = traktBridge.fetchAuthCached(def.path, AUTH_TTL);
                } else if (def.key && def.key.startsWith('userlist-')) {
                    p = traktBridge.fetchPublicCached(def.path, USERLIST_TTL);
                } else {
                    p = traktBridge.fetchPublicCached(def.path, DISCOVERY_TTL);
                }
                return p.catch((err) => {
                    console.warn('[Trakt] Row fetch failed:', def.title, err && err.message);
                    return null;
                });
            }));

            if (cancelled || myBuildId !== buildCounterRef.current) return;

            // Convert each response into placeholder Stremio items
            const placeholderRows = [];
            for (let i = 0; i < allDefs.length; i++) {
                const def = allDefs[i];
                const raw = responses[i];
                if (!raw) continue;
                const unwrapped = unwrapTraktItems(raw, def.mediaType);
                const items = unwrapped.map(toStremioItemBase).filter(Boolean);
                if (items.length === 0) continue;
                placeholderRows.push({ key: def.key, title: def.title, items });
            }

            // Render placeholder rows immediately so the layout appears fast,
            // then enrich poster/backdrop in the background.
            setRows(placeholderRows.map((r) => ({ ...r, items: r.items.slice() })));

            for (const row of placeholderRows) {
                if (cancelled || myBuildId !== buildCounterRef.current) return;
                row.items = await enrichBatch(row.items, cacheRef.current);
            }
            if (!cancelled && myBuildId === buildCounterRef.current) {
                setRows(placeholderRows.map((r) => ({ ...r, items: r.items.slice() })));
            }
        };

        run();
        return () => { cancelled = true; };
    }, []);

    return rows;
}

module.exports = useTraktDiscoveryRows;
