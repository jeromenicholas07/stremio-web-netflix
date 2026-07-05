// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const classnames = require('classnames');
const debounce = require('lodash.debounce');
const useTranslate = require('stremio/common/useTranslate');
const { isMobile } = require('stremio/common/Platform/device');
const { useStreamingServer, useNotifications, withCoreSuspender } = require('stremio/common');
const { ContinueWatchingItem, EventModal, IosInstallBanner, MainNavBars, MetaItem, MetaRow } = require('stremio/components');
const HeroBanner = require('stremio/components/HeroBanner');
const { TrailerProvider, TrailerContext } = require('stremio/common/TrailerContext');
const useBoard = require('./useBoard');
const useContinueWatchingPreview = require('./useContinueWatchingPreview');
const useRecommendations = require('./useRecommendations');
const useTraktRecommendations = require('./useTraktRecommendations');
const useWatchedNotRated = require('./useWatchedNotRated');
const useTraktLists = require('./useTraktLists');
const useTraktDiscoveryRows = require('./useTraktDiscoveryRows');
const styles = require('./styles');

const THRESHOLD = 5;

const traktBridge = require('stremio/services/TraktBridge');
const { useProfile } = require('stremio/common');

// Wrapper component that passes rateMode=true to MetaItem for the "Watched (Not Rated)" row
const RateMetaItem = React.memo((props) => {
    return React.createElement(MetaItem, { ...props, rateMode: true });
});
RateMetaItem.displayName = 'RateMetaItem';

// Load dismissed/not-interested/rated/watchlisted item IDs from localStorage + TraktBridge
function useDismissedItems() {
    const [dismissedSet, setDismissedSet] = React.useState(new Set());

    React.useEffect(() => {
        const load = () => {
            // Trakt is the single source of truth for dismissed items
            const traktDismissed = traktBridge.getDismissedIds();
            setDismissedSet(traktDismissed);
        };
        load();

        // Re-check when MetaItem actions complete (Trakt calls update internal state)
        window.addEventListener('stremio-dismissed-updated', load);

        // Subscribe to TraktBridge updates (sync completions, etc.)
        const unsub = traktBridge.onChange(load);

        // Trigger initial Trakt sync on mount
        if (traktBridge.isConnected()) {
            traktBridge.syncAll().then(load);
        }

        return () => {
            window.removeEventListener('stremio-dismissed-updated', load);
            unsub();
        };
    }, []);

    return dismissedSet;
}

// Load user's library item names+IDs from localStorage for filtering from catalog rows.
// Items in the library (especially fully watched ones) should not clutter discovery rows.
function useLibraryItems() {
    const [libraryNames, setLibraryNames] = React.useState(new Set());
    const [libraryIds, setLibraryIds] = React.useState(new Set());

    React.useEffect(() => {
        const load = () => {
            const names = new Set();
            const ids = new Set();
            try {
                const data = JSON.parse(localStorage.getItem('library_recent') || '{}');
                const items = data?.items || {};
                Object.entries(items).forEach(([id, item]) => {
                    ids.add(id);
                    if (item?.name) names.add(item.name.toLowerCase().trim());
                });
            } catch { /* */ }
            setLibraryNames(names);
            setLibraryIds(ids);
        };
        load();

        // Re-check on storage changes and dismissed updates (library may update too)
        window.addEventListener('storage', load);
        window.addEventListener('stremio-dismissed-updated', load);
        // Also re-check periodically since library_recent updates on playback
        const interval = setInterval(load, 60000);
        return () => {
            window.removeEventListener('storage', load);
            window.removeEventListener('stremio-dismissed-updated', load);
            clearInterval(interval);
        };
    }, []);

    return { libraryNames, libraryIds };
}

// Filter items from a catalog, removing dismissed + already-seen (dedup) items
function filterCatalogItems(catalog, dismissedSet, seenNames) {
    if (catalog.content?.type !== 'Ready' || !Array.isArray(catalog.content.content)) return catalog;
    const filtered = catalog.content.content.filter((item) => {
        // Filter by dismissed IDs
        if (dismissedSet.size > 0 && dismissedSet.has(item.id)) return false;
        // Deduplicate by normalized name across all rows
        if (seenNames && item.name) {
            const key = item.name.toLowerCase().trim();
            if (seenNames.has(key)) return false;
            seenNames.add(key);
        }
        return true;
    });
    if (filtered.length === catalog.content.content.length) return catalog;
    if (filtered.length === 0) return null;
    return {
        ...catalog,
        content: { ...catalog.content, content: filtered },
    };
}

// Filter array of items (for TMDB rows), removing dismissed + dedup
function filterItems(items, dismissedSet, seenNames) {
    return items.filter((item) => {
        if (dismissedSet.size > 0 && dismissedSet.has(item.id)) return false;
        if (seenNames && item.name) {
            const key = item.name.toLowerCase().trim();
            if (seenNames.has(key)) return false;
            seenNames.add(key);
        }
        return true;
    });
}

// Inner component that has access to TrailerContext (rendered inside TrailerProvider)
const BoardContent = () => {
    const t = useTranslate();
    const profile = useProfile();
    const streamingServer = useStreamingServer();
    const continueWatchingPreview = useContinueWatchingPreview();
    const [board, loadBoardRows] = useBoard();
    const notifications = useNotifications();
    const { recommendations } = useRecommendations();
    const { rows: traktRows } = useTraktRecommendations();
    const watchedNotRatedItems = useWatchedNotRated();
    const { watchlistItems: traktWatchlistItems, notInterestedItems: traktNotInterestedItems } = useTraktLists();
    const traktDiscoveryRows = useTraktDiscoveryRows();
    const { libraryNames, libraryIds } = useLibraryItems();

    // Trakt auth is now handled via OAuth Device Code flow in Settings.
    const dismissedSet = useDismissedItems();
    // boardCatalogsOffset no longer needed — visible range uses scroll fraction
    const scrollContainerRef = React.useRef();
    const heroRef = React.useRef(null);
    const trailerCtx = React.useContext(TrailerContext);

    // Hero seed + items are computed after combinedDismissedSet (below)

    const onVisibleRangeChange = React.useCallback(() => {
        // Since catalogs are reordered in the UI (Trakt first, then others),
        // DOM indices don't map 1:1 to board.catalogs indices.
        // Load all catalogs to ensure everything renders regardless of order.
        if (board.catalogs.length > 0) {
            loadBoardRows({ start: 0, end: board.catalogs.length });
        }
    }, [board.catalogs.length]);

    // Check hero banner visibility on every scroll tick (not debounced — must be instant)
    const heroInViewRef = React.useRef(true);
    const checkHeroVisibility = React.useCallback(() => {
        const el = heroRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vpHeight = window.innerHeight;
        const visibleTop = Math.max(rect.top, 0);
        const visibleBottom = Math.min(rect.bottom, vpHeight);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const ratio = rect.height > 0 ? visibleHeight / rect.height : 0;
        const inView = ratio >= 0.75;
        if (heroInViewRef.current !== inView) {
            heroInViewRef.current = inView;
            if (trailerCtx) trailerCtx.setHeroInView(inView);
        }
    }, [trailerCtx]);

    const debouncedVisibleRange = React.useCallback(debounce(onVisibleRangeChange, 250), [onVisibleRangeChange]);
    const onScroll = React.useCallback(() => {
        checkHeroVisibility();
        debouncedVisibleRange();
    }, [checkHeroVisibility, debouncedVisibleRange]);

    React.useLayoutEffect(() => {
        onVisibleRangeChange();
    }, [board.catalogs, onVisibleRangeChange]);

    // When user navigates away from Board page, mark hero as not in view
    React.useEffect(() => {
        const onHashChange = () => {
            heroInViewRef.current = false;
            if (trailerCtx) trailerCtx.setHeroInView(false);
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, [trailerCtx]);

    // Addons/catalogs to exclude entirely (source-based, utility, channels)
    const EXCLUDED_ADDONS = new Set([
        'com.linvo.stremiochannels',    // YouTube channels
        'org.stremio.ftututs',          // Udemy courses
        'com.stremio.torrentio.addon',  // RealDebrid/Torrentio
        'org.stremio.pubdomainmovies',  // Public Domain Movies
        'community.fmovies',           // FMovies
        'org.cinetorrent',             // CineTorrent
        'pw.ers.netflix-catalog',      // Netflix/HBO/Disney/Prime/Apple source catalogs
    ]);
    // Cyberflix source-based catalog IDs to exclude (keep premieres, trending, genre-based)
    const EXCLUDED_CYBERFLIX_PREFIXES = [
        'netflix.', 'disney_plus.', 'hbo_max.', 'amazon_prime.', 'apple_tv_plus.',
    ];

    // Split addon catalogs into content rows (non-Trakt). Trakt addon catalogs
    // are dropped entirely — discovery/recommendation rows now come directly
    // from the Trakt API via useTraktDiscoveryRows.
    const { contentCatalogs } = React.useMemo(() => {
        const content = [];

        for (let i = 0; i < board.catalogs.length; i++) {
            const c = board.catalogs[i];
            const addonId = c.addon?.manifest?.id || '';
            const catalogId = c.id || '';

            // Drop all Trakt addon catalogs (handled by useTraktDiscoveryRows / useTraktLists)
            const isTrakt = addonId.startsWith('org.trakt') || addonId === 'community.trakt-tv';
            if (isTrakt) continue;

            // Exclude entire addons
            if (EXCLUDED_ADDONS.has(addonId)) continue;

            // Exclude Cyberflix source-based catalogs (keep premieres, trending, genre)
            if (addonId === 'marcojoao.ml.cyberflix.catalog') {
                if (EXCLUDED_CYBERFLIX_PREFIXES.some((p) => catalogId.startsWith(p))) continue;
            }

            content.push({ catalog: c, originalIndex: i });
        }

        return { contentCatalogs: content };
    }, [board.catalogs]);

    // Build a name-based dismissed set from the ID-based one for cross-ID filtering.
    // Also collect names from Continue Watching and full library so they get deduped from catalog rows.
    const dismissedNames = React.useMemo(() => {
        const names = new Set();
        // Add all library item names — these are items the user has watched, is watching,
        // or has added to their library. They should not clutter discovery/catalog rows.
        libraryNames.forEach((n) => names.add(n));
        // Collect names of dismissed items from all catalogs
        if (dismissedSet.size > 0) {
            const allCatalogs = [...board.catalogs];
            for (const cat of allCatalogs) {
                if (cat.content?.type === 'Ready' && Array.isArray(cat.content.content)) {
                    for (const item of cat.content.content) {
                        if (dismissedSet.has(item.id) && item.name) {
                            names.add(item.name.toLowerCase().trim());
                        }
                    }
                }
            }
            // Also check TMDB discovery rows
            for (const row of traktRows) {
                for (const item of row.items) {
                    if (dismissedSet.has(item.id) && item.name) {
                        names.add(item.name.toLowerCase().trim());
                    }
                }
            }
            // Also check TMDB recommendations
            for (const rec of recommendations) {
                for (const item of rec.items) {
                    if (dismissedSet.has(item.id) && item.name) {
                        names.add(item.name.toLowerCase().trim());
                    }
                }
            }
        }
        // Add API-fetched Not Interested items so they're filtered from
        // recommendation/discovery rows (still shown in the NI row itself).
        for (const item of traktNotInterestedItems) {
            if (item.name) names.add(item.name.toLowerCase().trim());
        }
        return names;
    }, [dismissedSet, board.catalogs, traktRows, recommendations, libraryNames, traktNotInterestedItems]);

    // Build a set of Not Interested item IDs for direct ID matching
    const notInterestedIds = React.useMemo(() => {
        const ids = new Set();
        for (const item of traktNotInterestedItems) {
            if (item.id) ids.add(item.id);
        }
        return ids;
    }, [traktNotInterestedItems]);

    // Build combined dismissed check: matches by ID, library ID, NI ID, or by name (cross-ID filtering)
    const combinedDismissedSet = React.useMemo(() => {
        return {
            size: dismissedSet.size + dismissedNames.size + libraryIds.size + notInterestedIds.size,
            has(id) {
                return dismissedSet.has(id) || libraryIds.has(id) || notInterestedIds.has(id);
            },
            hasItem(item) {
                if (dismissedSet.has(item.id)) return true;
                if (libraryIds.has(item.id)) return true;
                if (notInterestedIds.has(item.id)) return true;
                if (item.name && dismissedNames.has(item.name.toLowerCase().trim())) return true;
                return false;
            }
        };
    }, [dismissedSet, dismissedNames, libraryIds, notInterestedIds]);

    // Lock in the hero row selection once per mount.
    // We store the chosen row's first item name so we can find it again across recomputes.
    const heroChoiceRef = React.useRef({ seed: Math.random(), lockedRowKey: null });

    // Get hero items from a random eligible row (recommendation rows or watchlist),
    // filtered to exclude dismissed/library items.
    const baseHeroItems = React.useMemo(() => {
        // Two tiers:
        //   preferredRows — recommendation-class rows (Trakt direct + TMDB recs + TMDB discovery).
        //                   These are what we want the hero to actually lock onto.
        //   fallbackRows  — addon catalogs (Cinemeta etc.). Used only as a placeholder before
        //                   the preferred rows finish loading; never locked to.
        const preferredRows = [];
        const fallbackRows = [];

        // Direct Trakt API discovery rows (Trending, Popular, Recommended, etc.)
        for (const row of traktDiscoveryRows) {
            if (row.items && row.items.length >= 3) {
                preferredRows.push({ key: 'trakt-disc:' + row.key, items: row.items });
            }
        }

        // TMDB discovery rows (useTraktRecommendations)
        for (let i = 0; i < traktRows.length; i++) {
            const row = traktRows[i];
            if (row.items && row.items.length >= 3) {
                preferredRows.push({ key: 'tmdb-disc:' + i, items: row.items });
            }
        }

        // TMDB "Because You Watched" recommendations
        for (let i = 0; i < recommendations.length; i++) {
            const rec = recommendations[i];
            if (rec.items && rec.items.length >= 3) {
                preferredRows.push({ key: 'rec:' + i, items: rec.items });
            }
        }

        // Other addon catalogs — fallback only
        for (const catalog of board.catalogs) {
            const addonId = catalog.addon?.manifest?.id || '';
            const catalogId = catalog.id || '';
            const isTrakt = addonId.startsWith('org.trakt') || addonId === 'community.trakt-tv';
            if (isTrakt) continue;
            if (EXCLUDED_ADDONS.has(addonId)) continue;
            if (catalog.content?.type === 'Ready' && Array.isArray(catalog.content.content) && catalog.content.content.length >= 3) {
                fallbackRows.push({ key: 'addon:' + addonId + ':' + catalogId, items: catalog.content.content });
            }
        }

        if (preferredRows.length === 0 && fallbackRows.length === 0) return [];

        // If we already locked a row, try to find it again (search both tiers since
        // a fallback could in theory have been locked previously — won't happen now,
        // but kept for safety).
        let chosenRow = null;
        if (heroChoiceRef.current.lockedRowKey) {
            chosenRow = preferredRows.find((r) => r.key === heroChoiceRef.current.lockedRowKey)
                || fallbackRows.find((r) => r.key === heroChoiceRef.current.lockedRowKey);
        }

        // Lock criteria: only lock to a preferred row, and only after the Trakt API
        // round-trip has populated traktDiscoveryRows. This guarantees the hero waits
        // for the Trakt rows to load instead of grabbing an addon row first.
        if (!chosenRow) {
            const traktLoaded = traktDiscoveryRows.length > 0;
            if (traktLoaded && preferredRows.length >= 3) {
                const rowIndex = Math.floor(heroChoiceRef.current.seed * preferredRows.length);
                chosenRow = preferredRows[rowIndex];
                heroChoiceRef.current.lockedRowKey = chosenRow.key;
            } else {
                // Not ready yet — show a placeholder from whatever we have so the
                // banner isn't blank. Don't lock; we'll re-select once Trakt arrives.
                chosenRow = preferredRows[0] || fallbackRows[0];
            }
        }

        // Filter out dismissed/library items from hero
        const filtered = chosenRow.items.filter((item) => {
            if (!item) return false;
            if (combinedDismissedSet.hasItem(item)) return false;
            return true;
        });

        return filtered.slice(0, 10);
    }, [board.catalogs, traktDiscoveryRows, traktRows, recommendations, combinedDismissedSet]);

    // Prepend promoted item (from card ^ button) to hero items
    const promotedItem = trailerCtx ? trailerCtx.promotedItem : null;
    const heroItems = React.useMemo(() => {
        if (!promotedItem) return baseHeroItems;
        // Remove duplicate if already in list, then prepend
        const filtered = baseHeroItems.filter((h) => h.id !== promotedItem.id);
        return [promotedItem, ...filtered].slice(0, 10);
    }, [baseHeroItems, promotedItem]);

    // Scroll to top when an item is promoted to hero
    React.useEffect(() => {
        if (promotedItem && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }, [promotedItem]);

    // Pre-compute all filtered+deduped rows in a single useMemo pass.
    // Each row is filtered by combinedDismissedSet, deduped against earlier rows,
    // and capped at MAX_ROW_ITEMS so we always show a consistent count.
    // Fewer cards per row on phones — every card is a decoded poster, and the
    // iOS PWA has a hard memory ceiling. Also bounds how many total rows mount
    // (MAX_MOBILE_ROWS) so a long discovery list can't accumulate unbounded DOM.
    const MAX_ROW_ITEMS = isMobile ? 12 : 20;
    const MAX_MOBILE_ROWS = 10;
    const dedupedRows = React.useMemo(() => {
        const seenNames = new Set();
        const result = { traktDisc: [], tmdbDisc: [], recs: [], content: [] };

        // Seed seenNames with Continue Watching items (they get priority)
        if (continueWatchingPreview.items) {
            for (const item of continueWatchingPreview.items) {
                if (item.name) seenNames.add(item.name.toLowerCase().trim());
            }
        }

        const filterAndCap = (items) => {
            const out = [];
            for (const item of items) {
                if (out.length >= MAX_ROW_ITEMS) break;
                if (combinedDismissedSet.hasItem(item)) continue;
                if (item.name) {
                    const key = item.name.toLowerCase().trim();
                    if (seenNames.has(key)) continue;
                    seenNames.add(key);
                }
                out.push(item);
            }
            return out;
        };

        // Direct-from-Trakt-API discovery rows (replaces addon catalogs)
        for (const row of traktDiscoveryRows) {
            const items = filterAndCap(row.items);
            if (items.length === 0) continue;
            result.traktDisc.push({
                key: `trakt-disc-${row.key}`,
                title: row.title,
                catalog: { items, content: { type: 'Ready', content: items } },
            });
        }

        // TMDB discovery rows
        for (let i = 0; i < traktRows.length; i++) {
            const row = traktRows[i];
            const items = filterAndCap(row.items);
            if (items.length === 0) continue;
            result.tmdbDisc.push({
                key: `tmdb-disc-${i}`,
                title: row.title,
                catalog: { items, content: { type: 'Ready', content: items } },
            });
        }

        // TMDB "Because You Watched" recommendations
        for (let i = 0; i < recommendations.length; i++) {
            const rec = recommendations[i];
            const items = filterAndCap(rec.items);
            if (items.length === 0) continue;
            result.recs.push({
                key: `rec-${i}`,
                title: rec.title,
                catalog: { items, content: { type: 'Ready', content: items } },
            });
        }

        // Other addon catalogs
        for (let i = 0; i < contentCatalogs.length; i++) {
            const { catalog, originalIndex } = contentCatalogs[i];
            if (catalog.content?.type !== 'Ready') continue;
            const items = filterAndCap(catalog.content.content);
            if (items.length === 0) continue;
            const addonName = catalog.addon?.manifest?.name || '';
            result.content.push({
                key: `content-${originalIndex}`,
                title: catalog.title || catalog.name || '',
                catalog: { ...catalog, content: { ...catalog.content, content: items } },
                source: addonName,
            });
        }

        // Mobile: hard-cap the total number of rows (Continue Watching is always
        // kept separately above). Fill the budget by priority — TMDB discovery
        // first, then recommendations, then addon catalogs — so the most useful
        // rows survive and the rest are dropped.
        if (isMobile) {
            result.tmdbDisc = result.tmdbDisc.slice(0, MAX_MOBILE_ROWS);
            const afterDisc = Math.max(0, MAX_MOBILE_ROWS - result.tmdbDisc.length);
            result.recs = result.recs.slice(0, afterDisc);
            const afterRecs = Math.max(0, afterDisc - result.recs.length);
            result.content = result.content.slice(0, afterRecs);
        }

        return result;
    }, [traktDiscoveryRows, traktRows, recommendations, contentCatalogs, combinedDismissedSet, continueWatchingPreview.items]);

    return (
        <div className={styles['board-container']}>
            <EventModal />
            <MainNavBars className={styles['board-content-container']} route={'board'}>
                <div ref={scrollContainerRef} className={styles['board-content']} data-scroll-container onScroll={onScroll}>
                    <IosInstallBanner />
                    <div ref={heroRef}>
                        <HeroBanner items={heroItems} />
                    </div>
                    <div className={styles['board-rows']}>
                    {
                        continueWatchingPreview.items.length > 0 ?
                            <MetaRow
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                title={t.string('BOARD_CONTINUE_WATCHING')}
                                catalog={continueWatchingPreview}
                                itemComponent={ContinueWatchingItem}
                                notifications={notifications}
                            />
                            :
                            null
                    }
                    {/* Trakt Watchlist — fetched directly from Trakt API */}
                    {traktWatchlistItems.length > 0 ?
                        <MetaRow
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={'Watchlist'}
                            catalog={{ content: { type: 'Ready', content: traktWatchlistItems } }}
                            itemComponent={MetaItem}
                            source={'Trakt'}
                            rowContext={'watchlist'}
                        />
                        :
                        null
                    }
                    {/* Trakt discovery rows — fetched directly from Trakt API */}
                    {dedupedRows.traktDisc.map((row) => (
                        <MetaRow
                            key={row.key}
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={row.title}
                            catalog={row.catalog}
                            itemComponent={MetaItem}
                            source={'Trakt'}
                        />
                    ))}
                    {/* TMDB discovery rows (trending, popular, etc.) */}
                    {dedupedRows.tmdbDisc.map((row) => (
                        <MetaRow
                            key={row.key}
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={row.title}
                            catalog={row.catalog}
                            itemComponent={MetaItem}
                            source={'TMDB'}
                        />
                    ))}
                    {/* TMDB "Because You Watched" recommendations */}
                    {dedupedRows.recs.map((row) => (
                        <MetaRow
                            key={row.key}
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={row.title}
                            catalog={row.catalog}
                            itemComponent={MetaItem}
                            source={'TMDB'}
                        />
                    ))}
                    {/* Other addon catalogs */}
                    {dedupedRows.content.map((row) => (
                        <MetaRow
                            key={row.key}
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            catalog={row.catalog}
                            itemComponent={MetaItem}
                            source={row.source}
                        />
                    ))}
                    {/* Watched (Not Rated) row — blurred items with star rating */}
                    {watchedNotRatedItems.length > 0 ?
                        <MetaRow
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={'Watched (Not Rated)'}
                            catalog={{ content: { type: 'Ready', content: watchedNotRatedItems } }}
                            itemComponent={RateMetaItem}
                            source={'Trakt'}
                        />
                        :
                        null
                    }
                    {/* Trakt Not Interested — fetched directly from Trakt API */}
                    {traktNotInterestedItems.length > 0 ?
                        <MetaRow
                            className={classnames(styles['board-row'], 'animation-fade-in')}
                            title={'Not Interested'}
                            catalog={{ content: { type: 'Ready', content: traktNotInterestedItems } }}
                            itemComponent={MetaItem}
                            source={'Trakt'}
                            rowContext={'not-interested'}
                        />
                        :
                        null
                    }
                    </div>
                </div>
            </MainNavBars>
        </div>
    );
};

// Outer component wraps with TrailerProvider so BoardContent can use the context
const Board = () => {
    return (
        <TrailerProvider>
            <BoardContent />
        </TrailerProvider>
    );
};

const BoardFallback = () => (
    <div className={styles['board-container']}>
        <MainNavBars className={styles['board-content-container']} route={'board'} />
    </div>
);

module.exports = withCoreSuspender(Board, BoardFallback);
