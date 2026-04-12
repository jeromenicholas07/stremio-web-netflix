// Copyright (C) 2017-2024 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { default: Button } = require('stremio/components/Button');
const { default: Image } = require('stremio/components/Image');
const YouTubePlayer = require('stremio/components/YouTubePlayer');
const { TrailerContext } = require('stremio/common/TrailerContext');
const tmdbService = require('stremio/services/TMDBService');
const { CARD_AR, detectLetterboxing, fetchVideoAR } = require('stremio/common/videoFit');
const styles = require('./styles');

const TRAILER_DELAY = 2500;
const POST_TRAILER_WAIT = 5000;
const NO_TRAILER_WAIT = 8000;

// Fallback: pick best trailer from stremio's trailerStreams (used when TMDB fails)
function pickBestTrailerFallback(trailerStreams) {
    if (!Array.isArray(trailerStreams) || trailerStreams.length === 0) return null;
    // Filter out sign language and other non-standard trailers
    const dominated = /sign\s*language|behind\s*the\s*scenes|bloopers|featurette|making\s*of|clip\s*\d|recap|interview/i;
    const clean = trailerStreams.filter((t) => t.ytId && !dominated.test(t.description || ''));
    const pool = clean.length > 0 ? clean : trailerStreams.filter((t) => t.ytId);
    if (pool.length === 0) return null;
    const official = pool.find((t) => /official\s*trailer/i.test(t.description || ''));
    if (official) return official.ytId;
    const trailer = pool.find((t) => /trailer/i.test(t.description || ''));
    if (trailer) return trailer.ytId;
    return pool[0].ytId;
}

// Mute icon — IDENTICAL speaker path in both states, only accessory (X vs waves) changes
// This prevents visual size shift on toggle
const SPEAKER_PATH = 'M10 3.75a.75.75 0 0 0-1.264-.546L4.703 7H3.167c-.587 0-1.14.294-1.46.756A6.018 6.018 0 0 0 1.25 10c0 1.192.348 2.302.942 3.236.32.462.873.764 1.46.764h1.086l4.033 3.796A.75.75 0 0 0 10 16.25V3.75Z';

const MuteIcon = React.memo(({ muted, size }) => {
    const s = size || 24;
    return (
        <svg width={s} height={s} viewBox="0 0 20 20" fill="white" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
            <path d={SPEAKER_PATH} />
            {muted ? (
                /* X mark — positioned to the right of speaker */
                <path d="M13.28 7.22a.75.75 0 1 0-1.06 1.06L13.94 10l-1.72 1.72a.75.75 0 0 0 1.06 1.06L15 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L16.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L15 8.94l-1.72-1.72Z" />
            ) : (
                /* Sound waves */
                <React.Fragment>
                    <path d="M15.95 5.06a.75.75 0 0 0-1.06 1.06 5.5 5.5 0 0 1 0 7.78.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.9Z" />
                    <path d="M13.829 7.172a.75.75 0 0 0-1.06 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z" />
                </React.Fragment>
            )}
        </svg>
    );
});
MuteIcon.displayName = 'MuteIcon';

const HeroBanner = React.memo(({ items }) => {
    const trailerCtx = React.useContext(TrailerContext);
    const [currentIndex, setCurrentIndex] = React.useState(0);
    const [phase, setPhase] = React.useState('IMAGE');
    const timerRef = React.useRef(null);

    const featuredItems = React.useMemo(() => {
        if (!Array.isArray(items) || items.length === 0) return [];
        return items.filter((item) => item.background || item.poster).slice(0, 10);
    }, [items]);

    // Fetch logos from TMDB for items that don't already have one
    const [logoCache, setLogoCache] = React.useState({});
    React.useEffect(() => {
        if (featuredItems.length === 0) return;
        let cancelled = false;
        const fetchLogos = async () => {
            const updates = {};
            const promises = featuredItems.map(async (item) => {
                if (item.logo || logoCache[item.id]) return; // Already has logo
                try {
                    const resolved = await tmdbService.resolveTmdbId(item.id, item.type);
                    if (!resolved || cancelled) return;
                    const logoUrl = await tmdbService.getLogoUrl(resolved.tmdbId, resolved.mediaType);
                    if (logoUrl && !cancelled) {
                        updates[item.id] = logoUrl;
                    }
                } catch { /* silent */ }
            });
            await Promise.all(promises);
            if (!cancelled && Object.keys(updates).length > 0) {
                setLogoCache((prev) => ({ ...prev, ...updates }));
            }
        };
        fetchLogos();
        return () => { cancelled = true; };
    }, [featuredItems]);

    // When a promoted item arrives, jump to index 0 (where it's prepended)
    const promotedItem = trailerCtx ? trailerCtx.promotedItem : null;
    React.useEffect(() => {
        if (promotedItem && featuredItems.length > 0) {
            setCurrentIndex(0);
            setPhase('IMAGE');
        }
    }, [promotedItem]);

    const item = featuredItems[currentIndex] || null;

    // TMDB trailer fetch — primary source; falls back to stremio trailerStreams
    const [trailerYtId, setTrailerYtId] = React.useState(null);
    React.useEffect(() => {
        if (!item) { setTrailerYtId(null); return; }

        // If the item already has a resolved trailerYtId (from promoted MetaItem), use it directly
        if (item.trailerYtId) {
            setTrailerYtId(item.trailerYtId);
            return;
        }

        let cancelled = false;

        const fetchTrailer = async () => {
            const source = tmdbService.getTrailerSource();
            if (source === 'tmdb' && item.id) {
                try {
                    // Handle TMDB IDs (tmdb:1234) directly
                    const tmdbMatch = item.id.match(/^tmdb:(\d+)$/);
                    if (tmdbMatch) {
                        const tmdbId = parseInt(tmdbMatch[1], 10);
                        const mediaType = item.type === 'series' ? 'tv' : 'movie';
                        const ytId = await tmdbService.getBestTrailerYtId(tmdbId, mediaType);
                        if (ytId && !cancelled) { setTrailerYtId(ytId); return; }
                    }
                    // Handle IMDB IDs (tt1234567)
                    if (/^tt/.test(item.id)) {
                        const tmdbItem = await tmdbService.findByImdbId(item.id);
                        if (tmdbItem && !cancelled) {
                            const ytId = await tmdbService.getBestTrailerYtId(tmdbItem.id, tmdbItem.type);
                            if (ytId && !cancelled) { setTrailerYtId(ytId); return; }
                        }
                    }
                } catch { /* fall through to fallback */ }
            }
            // Fallback to stremio trailerStreams
            if (!cancelled) {
                setTrailerYtId(pickBestTrailerFallback(item.trailerStreams));
            }
        };

        fetchTrailer();
        return () => { cancelled = true; };
    }, [item]);

    // Real video aspect ratio + letterbox detection — used to build a style
    // that cover-fits the visible (non-letterboxed) region into the hero
    // container with minimum cropping, matching MetaItem's trailer logic.
    const [videoAR, setVideoAR] = React.useState(CARD_AR);
    const [letterbox, setLetterbox] = React.useState({ top: 0, bottom: 0 });

    React.useEffect(() => {
        if (!trailerYtId) { setVideoAR(CARD_AR); return; }
        let cancelled = false;
        fetchVideoAR(trailerYtId).then((ar) => { if (!cancelled) setVideoAR(ar); });
        return () => { cancelled = true; };
    }, [trailerYtId]);

    React.useEffect(() => {
        if (!trailerYtId) { setLetterbox({ top: 0, bottom: 0 }); return; }
        let cancelled = false;
        detectLetterboxing(trailerYtId).then((lb) => { if (!cancelled) setLetterbox(lb); });
        return () => { cancelled = true; };
    }, [trailerYtId]);

    // Compute iframe sizing that cover-fits the visible content of the video
    // into the hero container. The iframe itself is rendered at 16:9 by YouTube;
    // the "visible region" is the subframe without the top/bottom baked bars.
    //
    // For a container (100cqw x 100cqh) and bars (T, B as fractions of iframe
    // height), the iframe must be large enough that its visible region covers
    // the container on both axes:
    //   iframeH >= 100cqh / (1 - T - B)      (cover vertically)
    //   iframeW >= 100cqw                    (cover horizontally)
    //   iframeW = iframeH * videoAR
    // Then shift the iframe vertically so the visible-region center lands at
    // the container center — by translateY of (T - B) / 2 of iframe height.
    const trailerStyle = React.useMemo(() => {
        const t = letterbox.top || 0;
        const b = letterbox.bottom || 0;
        const vis = Math.max(0.1, 1 - t - b);
        const ar = videoAR || CARD_AR;
        return {
            width: `max(100cqw, calc(100cqh * ${ar} / ${vis}))`,
            height: `max(calc(100cqw / ${ar}), calc(100cqh / ${vis}))`,
            transform: `translate(-50%, calc(-50% - ${((t - b) * 50).toFixed(3)}%))`,
        };
    }, [videoAR, letterbox]);

    const cardTrailerActive = trailerCtx && trailerCtx.activeTrailerId !== null && trailerCtx.activeTrailerId !== 'hero';
    const globalMuted = trailerCtx ? trailerCtx.globalMuted : true;
    const pageVisible = trailerCtx ? trailerCtx.pageVisible : true;
    // heroInView is now managed by Board.js and stored in TrailerContext
    const heroInView = trailerCtx ? trailerCtx.heroInView : true;

    const clearTimer = React.useCallback(() => {
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const goToNext = React.useCallback(() => {
        if (featuredItems.length <= 1) return;
        setCurrentIndex((prev) => (prev + 1) % featuredItems.length);
    }, [featuredItems.length]);

    const goToPrev = React.useCallback(() => {
        if (featuredItems.length <= 1) return;
        setCurrentIndex((prev) => (prev === 0 ? featuredItems.length - 1 : prev - 1));
    }, [featuredItems.length]);

    // When current index changes, reset to IMAGE phase and start timer
    React.useEffect(() => {
        setPhase('IMAGE');
        clearTimer();

        if (trailerYtId) {
            timerRef.current = setTimeout(() => {
                setPhase('TRAILER_PLAYING');
                if (trailerCtx) trailerCtx.setActiveTrailer('hero');
            }, TRAILER_DELAY);
        } else if (featuredItems.length > 1) {
            timerRef.current = setTimeout(() => {
                goToNext();
            }, NO_TRAILER_WAIT);
        }

        return clearTimer;
    }, [currentIndex, trailerYtId, featuredItems.length]);

    const onTrailerEnded = React.useCallback(() => {
        setPhase('TRAILER_ENDED');
        if (trailerCtx) trailerCtx.clearActiveTrailer('hero');
        clearTimer();

        if (featuredItems.length > 1) {
            timerRef.current = setTimeout(() => {
                goToNext();
            }, POST_TRAILER_WAIT);
        }
    }, [featuredItems.length, goToNext, clearTimer]);

    const onTrailerPlaying = React.useCallback(() => {
        if (trailerCtx) trailerCtx.setActiveTrailer('hero');
    }, []);

    const manualGoToIndex = React.useCallback((i) => {
        clearTimer();
        if (trailerCtx) trailerCtx.clearActiveTrailer('hero');
        setCurrentIndex(i);
    }, [clearTimer]);

    const manualGoToNext = React.useCallback(() => {
        clearTimer();
        if (trailerCtx) trailerCtx.clearActiveTrailer('hero');
        goToNext();
    }, [clearTimer, goToNext]);

    const manualGoToPrev = React.useCallback(() => {
        clearTimer();
        if (trailerCtx) trailerCtx.clearActiveTrailer('hero');
        goToPrev();
    }, [clearTimer, goToPrev]);

    const toggleMute = React.useCallback(() => {
        if (trailerCtx) trailerCtx.toggleGlobalMute();
    }, []);

    if (!item) {
        return (
            <div className={styles['hero-container']}>
                <div className={styles['hero-loading-placeholder']}>
                    <div className={styles['hero-loading-shimmer']} />
                </div>
            </div>
        );
    }

    const playHref = item.deepLinks?.player ?? item.deepLinks?.metaDetailsStreams ?? null;
    const infoHref = item.deepLinks?.metaDetailsVideos ?? item.deepLinks?.metaDetailsStreams ?? null;

    // Pause when: a card trailer is active, page not visible, or hero scrolled out of view
    const heroPaused = cardTrailerActive || !pageVisible || !heroInView;
    // Keep trailer mounted but paused — resumes from where it left off on scroll-back
    const showTrailer = phase === 'TRAILER_PLAYING' && trailerYtId;

    return (
        <div className={styles['hero-container']}>
            <div className={styles['hero-backdrop']}>
                <Image
                    className={styles['hero-image']}
                    src={item.background || item.poster}
                    alt={' '}
                />
                {
                    showTrailer ?
                        <div className={styles['hero-trailer-wrapper']}>
                            <YouTubePlayer
                                ytId={trailerYtId}
                                muted={globalMuted || heroPaused}
                                paused={heroPaused}
                                onEnded={onTrailerEnded}
                                onPlaying={onTrailerPlaying}
                                className={styles['hero-trailer-player']}
                                style={trailerStyle}
                                startTime={item.trailerStartTime || 0}
                            />
                        </div>
                        :
                        null
                }
            </div>
            <div className={styles['hero-gradient-bottom']} />
            <div className={styles['hero-gradient-left']} />

            {
                featuredItems.length > 1 ?
                    <React.Fragment>
                        <button className={classnames(styles['hero-nav-arrow'], styles['hero-nav-left'])} onClick={manualGoToPrev}>
                            <Icon className={styles['hero-nav-icon']} name={'chevron-back'} />
                        </button>
                        <button className={classnames(styles['hero-nav-arrow'], styles['hero-nav-right'])} onClick={manualGoToNext}>
                            <Icon className={styles['hero-nav-icon']} name={'chevron-forward'} />
                        </button>
                    </React.Fragment>
                    :
                    null
            }

            <div className={styles['hero-content']}>
                {
                    (() => {
                        const logoUrl = item.logo || logoCache[item.id];
                        return typeof logoUrl === 'string' && logoUrl.length > 0 ?
                            <Image className={styles['hero-logo']} src={logoUrl} alt={item.name || ''} />
                            :
                            <h1 className={styles['hero-title']}>{item.name}</h1>;
                    })()
                }
                {
                    typeof item.description === 'string' && item.description.length > 0 ?
                        <p className={styles['hero-description']}>{item.description}</p>
                        :
                        null
                }
                <div className={styles['hero-buttons']}>
                    {
                        playHref ?
                            <Button className={classnames(styles['hero-btn'], styles['hero-btn-play'])} href={playHref}>
                                <Icon className={styles['hero-btn-icon']} name={'play'} />
                                <span>Play</span>
                            </Button>
                            :
                            null
                    }
                    {
                        infoHref ?
                            <Button className={classnames(styles['hero-btn'], styles['hero-btn-info'])} href={infoHref}>
                                <Icon className={styles['hero-btn-icon']} name={'about'} />
                                <span>More Info</span>
                            </Button>
                            :
                            null
                    }
                </div>
            </div>

            <div className={styles['hero-right-controls']}>
                <button className={styles['mute-btn']} onClick={toggleMute} aria-label={globalMuted ? 'Unmute' : 'Mute'}>
                    <MuteIcon muted={globalMuted} size={24} />
                </button>
                {
                    featuredItems.length > 1 ?
                        <div className={styles['hero-indicators']}>
                            {featuredItems.map((_, i) => (
                                <button
                                    key={i}
                                    className={classnames(styles['indicator'], { [styles['indicator-active']]: i === currentIndex })}
                                    onClick={() => manualGoToIndex(i)}
                                />
                            ))}
                        </div>
                        :
                        null
                }
            </div>
        </div>
    );
});

HeroBanner.displayName = 'HeroBanner';

HeroBanner.propTypes = {
    items: PropTypes.arrayOf(PropTypes.shape({
        name: PropTypes.string,
        poster: PropTypes.string,
        background: PropTypes.string,
        logo: PropTypes.string,
        description: PropTypes.string,
        trailerStreams: PropTypes.array,
        deepLinks: PropTypes.object,
    })),
};

module.exports = HeroBanner;
