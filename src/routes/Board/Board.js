// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const classnames = require('classnames');
const debounce = require('lodash.debounce');
const useTranslate = require('stremio/common/useTranslate');
const { useStreamingServer, useNotifications, withCoreSuspender } = require('stremio/common');
const { ContinueWatchingItem, EventModal, MainNavBars, MetaItem, MetaRow } = require('stremio/components');
const HeroBanner = require('stremio/components/HeroBanner');
const { TrailerProvider, TrailerContext } = require('stremio/common/TrailerContext');
const useBoard = require('./useBoard');
const useContinueWatchingPreview = require('./useContinueWatchingPreview');
const useRecommendations = require('./useRecommendations');
const useTraktRecommendations = require('./useTraktRecommendations');
const styles = require('./styles');

const THRESHOLD = 5;

const traktBridge = require('stremio/services/TraktBridge');

// Load dismissed/not-interested/rated/watchlisted item IDs from localStorage + TraktBridge
function useDismissedItems() {
    const [dismissedSet, setDismissedSet] = React.useState(new Set());

    React.useEffect(() => {
        const load = () => {
            const ids = new Set();
            // Local fallback data
            try {
                const notInterested = JSON.parse(localStorage.getItem('stremio_not_interested') || '[]');
                notInterested.forEach((id) => ids.add(id));
            } catch { /* */ }
            try {
                const ratings = JSON.parse(localStorage.getItem('stremio_ratings') || '{}');
                Object.keys(ratings).forEach((id) => ids.add(id));
            } catch { /* */ }
            try {
                const watchlist = JSON.parse(localStorage.getItem('stremio_watchlist') || '[]');
                watchlist.forEach((id) => ids.add(id));
            } catch { /* */ }
            // Merge with TraktBridge synced data
            const traktDismissed = traktBridge.getDismissedIds();
            traktDismissed.forEach((id) => ids.add(id));
            setDismissedSet(ids);
        };
        load();

        // Re-check when localStorage changes (from MetaItem dismiss actions)
        window.addEventListener('storage', load);
        const interval = setInterval(load, 5000); // poll for same-tab updates

        // Subscribe to TraktBridge updates
        const unsub = traktBridge.onChange(load);

        // Trigger initial Trakt sync
        if (traktBridge.isConfigured()) {
            traktBridge.syncAll().then(load);
        }

        return () => {
            window.removeEventListener('storage', load);
            clearInterval(interval);
            unsub();
        };
    }, []);

    return dismissedSet;
}

// Filter items from a catalog, removing dismissed/not-interested/rated ones
function filterCatalogItems(catalog, dismissedSet) {
    if (dismissedSet.size === 0) return catalog;
    if (catalog.content?.type !== 'Ready' || !Array.isArray(catalog.content.content)) return catalog;
    const filtered = catalog.content.content.filter((item) => !dismissedSet.has(item.id));
    if (filtered.length === catalog.content.content.length) return catalog;
    if (filtered.length === 0) return null;
    return {
        ...catalog,
        content: { ...catalog.content, content: filtered },
    };
}

// Inner component that has access to TrailerContext (rendered inside TrailerProvider)
const BoardContent = () => {
    const t = useTranslate();
    const streamingServer = useStreamingServer();
    const continueWatchingPreview = useContinueWatchingPreview();
    const [board, loadBoardRows] = useBoard();
    const notifications = useNotifications();
    const { recommendations } = useRecommendations();
    const { rows: traktRows } = useTraktRecommendations();
    const dismissedSet = useDismissedItems();
    // boardCatalogsOffset no longer needed — visible range uses scroll fraction
    const scrollContainerRef = React.useRef();
    const heroRef = React.useRef(null);
    const trailerCtx = React.useContext(TrailerContext);

    // Get hero items from the first ready catalog
    const baseHeroItems = React.useMemo(() => {
        for (const catalog of board.catalogs) {
            if (catalog.content?.type === 'Ready' && Array.isArray(catalog.content.content)) {
                return catalog.content.content.slice(0, 10);
            }
        }
        return [];
    }, [board.catalogs]);

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

    // The "Not Interested" list catalog ID from Trakt
    const TRAKT_NOT_INTERESTED_ID = 'trakt_list:jeromeee:34129597:rank:asc';

    // Split catalogs into: Trakt top, content rows (non-Trakt), Trakt bottom (history + not interested)
    const { traktTopCatalogs, contentCatalogs, traktBottomCatalogs } = React.useMemo(() => {
        const traktTop = [];    // recommendations, watchlist, popular, trending, curated lists
        const traktBottom = []; // not interested list
        const content = [];

        for (let i = 0; i < board.catalogs.length; i++) {
            const c = board.catalogs[i];
            const addonId = c.addon?.manifest?.id || '';
            const catalogId = c.id || '';

            // Handle both old (org.trakt.*) and new (community.trakt-tv) Trakt addons
            const isTrakt = addonId.startsWith('org.trakt') || addonId === 'community.trakt-tv';

            if (isTrakt) {
                // Not Interested list goes to the very bottom
                if (catalogId === TRAKT_NOT_INTERESTED_ID) {
                    traktBottom.push({ catalog: c, originalIndex: i });
                } else {
                    // Everything else (recommendations, watchlist, popular, trending, curated) goes to top
                    traktTop.push({ catalog: c, originalIndex: i });
                }
                continue;
            }

            // Exclude entire addons
            if (EXCLUDED_ADDONS.has(addonId)) continue;

            // Exclude Cyberflix source-based catalogs (keep premieres, trending, genre)
            if (addonId === 'marcojoao.ml.cyberflix.catalog') {
                if (EXCLUDED_CYBERFLIX_PREFIXES.some((p) => catalogId.startsWith(p))) continue;
            }

            content.push({ catalog: c, originalIndex: i });
        }

        return { traktTopCatalogs: traktTop, contentCatalogs: content, traktBottomCatalogs: traktBottom };
    }, [board.catalogs]);

    return (
        <div className={styles['board-container']}>
            <EventModal />
            <MainNavBars className={styles['board-content-container']} route={'board'}>
                <div ref={scrollContainerRef} className={styles['board-content']} data-scroll-container onScroll={onScroll}>
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
                    {/* Trakt addon catalogs — top: recommendations, watchlist, popular, trending, curated (filtered) */}
                    {traktTopCatalogs.map(({ catalog, originalIndex }) => {
                        if (catalog.content?.type !== 'Ready') return null;
                        const filtered = filterCatalogItems(catalog, dismissedSet);
                        if (!filtered) return null;
                        // Use name field (new addon) or title (old addon), strip " - Trakt" suffix
                        const rawTitle = catalog.name || catalog.title || '';
                        const cleanTitle = rawTitle.replace(/\s*-\s*Trakt$/i, '');
                        return (
                            <MetaRow
                                key={`trakt-${originalIndex}`}
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                title={cleanTitle}
                                catalog={filtered}
                                itemComponent={MetaItem}
                                source={'Trakt'}
                            />
                        );
                    })}
                    {/* TMDB discovery rows (trending, popular, etc.) — filtered */}
                    {traktRows.map((row, index) => {
                        const items = dismissedSet.size > 0 ? row.items.filter((item) => !dismissedSet.has(item.id)) : row.items;
                        if (items.length === 0) return null;
                        return (
                            <MetaRow
                                key={`tmdb-disc-${index}`}
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                title={row.title}
                                catalog={{ items, content: { type: 'Ready', content: items } }}
                                itemComponent={MetaItem}
                                source={'TMDB'}
                            />
                        );
                    })}
                    {/* TMDB "Because You Watched" recommendations — filtered */}
                    {recommendations.map((rec, index) => {
                        const items = dismissedSet.size > 0 ? rec.items.filter((item) => !dismissedSet.has(item.id)) : rec.items;
                        if (items.length === 0) return null;
                        return (
                            <MetaRow
                                key={`rec-${index}`}
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                title={rec.title}
                                catalog={{ items, content: { type: 'Ready', content: items } }}
                                itemComponent={MetaItem}
                                source={'TMDB'}
                            />
                        );
                    })}
                    {/* Other addon catalogs — only show rows that loaded successfully, filtered */}
                    {contentCatalogs.map(({ catalog, originalIndex }) => {
                        if (catalog.content?.type !== 'Ready') return null;
                        const filtered = filterCatalogItems(catalog, dismissedSet);
                        if (!filtered) return null;
                        const addonName = catalog.addon?.manifest?.name || '';
                        return (
                            <MetaRow
                                key={originalIndex}
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                catalog={filtered}
                                itemComponent={MetaItem}
                                source={addonName}
                            />
                        );
                    })}
                    {/* Trakt addon catalogs — bottom: Not Interested list */}
                    {traktBottomCatalogs.map(({ catalog, originalIndex }) => {
                        if (catalog.content?.type !== 'Ready') return null;
                        const rawTitle = catalog.name || catalog.title || '';
                        const cleanTitle = rawTitle.replace(/\s*-\s*Trakt$/i, '');
                        return (
                            <MetaRow
                                key={`trakt-bottom-${originalIndex}`}
                                className={classnames(styles['board-row'], 'animation-fade-in')}
                                title={cleanTitle}
                                catalog={catalog}
                                itemComponent={MetaItem}
                                source={'Trakt'}
                            />
                        );
                    })}
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
