// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { default: Button } = require('stremio/components/Button');
const { default: Image } = require('stremio/components/Image');
const YouTubePlayer = require('stremio/components/YouTubePlayer');
const { ICON_FOR_TYPE } = require('stremio/common/CONSTANTS');
const { TrailerContext } = require('stremio/common/TrailerContext');
const { useServices } = require('stremio/services');
const tmdbService = require('stremio/services/TMDBService');
const styles = require('./styles');

let cardIdCounter = 0;

// ─── Letterbox detection ───
// Analyzes YouTube's auto-generated video frame thumbnails (1.jpg, 2.jpg, 3.jpg
// at 25%, 50%, 75% of the video) to detect black bars baked into the video.
const letterboxCache = {};

function analyzeFrame(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);

    const w = canvas.width;
    const h = canvas.height;
    const threshold = 30;
    const sampleLeft = Math.floor(w * 0.1);
    const sampleWidth = Math.floor(w * 0.8);

    const isRowBlack = (y) => {
        const row = ctx.getImageData(sampleLeft, y, sampleWidth, 1).data;
        let dark = 0;
        let total = 0;
        for (let x = 0; x < row.length; x += 16) {
            total++;
            if (row[x] <= threshold && row[x + 1] <= threshold && row[x + 2] <= threshold) {
                dark++;
            }
        }
        return dark / total >= 0.80;
    };

    let topBar = 0;
    for (let y = 0; y < h * 0.35; y++) {
        if (!isRowBlack(y)) break;
        topBar = y + 1;
    }

    let bottomBar = 0;
    for (let y = h - 1; y > h * 0.65; y--) {
        if (!isRowBlack(y)) break;
        bottomBar = h - y;
    }

    const thumbAR = w / h;
    const VIDEO_AR = 16 / 9;

    if (Math.abs(thumbAR - VIDEO_AR) < 0.1) {
        return { top: topBar / h, bottom: bottomBar / h };
    }
    const paddingPerSide = (1 - (thumbAR / VIDEO_AR)) / 2;
    const contentFrac = 1 - 2 * paddingPerSide;
    return {
        top: Math.max(0, (topBar / h - paddingPerSide) / contentFrac),
        bottom: Math.max(0, (bottomBar / h - paddingPerSide) / contentFrac),
    };
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject();
        img.src = url;
    });
}

async function detectLetterboxing(ytId) {
    if (letterboxCache[ytId]) return letterboxCache[ytId];
    const noBars = { top: 0, bottom: 0 };

    try {
        const frames = await Promise.allSettled([
            loadImage(`https://i.ytimg.com/vi/${ytId}/1.jpg`),
            loadImage(`https://i.ytimg.com/vi/${ytId}/2.jpg`),
            loadImage(`https://i.ytimg.com/vi/${ytId}/3.jpg`),
        ]);

        const analyses = frames
            .filter((f) => f.status === 'fulfilled')
            .map((f) => analyzeFrame(f.value));

        if (analyses.length === 0) {
            letterboxCache[ytId] = noBars;
            return noBars;
        }

        const topFrac = Math.min(...analyses.map((a) => a.top));
        const bottomFrac = Math.min(...analyses.map((a) => a.bottom));

        const result = {
            top: topFrac > 0.03 ? topFrac : 0,
            bottom: bottomFrac > 0.03 ? bottomFrac : 0,
        };

        if (result.top > 0.25 || result.bottom > 0.25) {
            letterboxCache[ytId] = noBars;
            return noBars;
        }

        letterboxCache[ytId] = result;
        return result;
    } catch (e) {
        letterboxCache[ytId] = noBars;
        return noBars;
    }
}

const CARD_AR = 16 / 9;

// Fallback: pick best trailer from stremio's trailerStreams
function pickBestTrailerFallback(trailerStreams) {
    if (!Array.isArray(trailerStreams) || trailerStreams.length === 0) return null;
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

const MetaItem = React.memo(({ className, type, name, poster, posterShape, background, progress, newVideos, deepLinks, dataset, onPlayClick, watched, trailerStreams, releaseInfo, links, disableTrailerExpand, ...props }) => {
    const { core } = useServices();
    const trailerCtx = React.useContext(TrailerContext);
    const [isHovered, setIsHovered] = React.useState(false);
    const [localWatched, setLocalWatched] = React.useState(null); // optimistic override
    const [showRating, setShowRating] = React.useState(false); // rating overlay visible
    const [hoverStar, setHoverStar] = React.useState(0); // star being hovered (1-5)
    const [dismissed, setDismissed] = React.useState(false); // fade out after marking watched
    const [showTrailer, setShowTrailer] = React.useState(false);
    const [edgePosition, setEdgePosition] = React.useState('center');
    const hoverTimerRef = React.useRef(null);
    const trailerTimerRef = React.useRef(null);
    const cardRef = React.useRef(null);
    const cardIdRef = React.useRef(`card-${++cardIdCounter}`);
    const posterRef = React.useRef(null);
    const originalDimsRef = React.useRef(null);
    const [trailerMounted, setTrailerMounted] = React.useState(false);

    const thumbnailSrc = background || poster;
    const globalMuted = trailerCtx ? trailerCtx.globalMuted : true;
    const pageVisible = trailerCtx ? trailerCtx.pageVisible : true;

    // Video aspect ratio — fetched from oEmbed, defaults to 16:9
    const [videoAR, setVideoAR] = React.useState(CARD_AR);
    // Letterbox detection — { top, bottom } as fractions
    const [letterbox, setLetterbox] = React.useState({ top: 0, bottom: 0 });

    const href = React.useMemo(() => {
        return deepLinks ?
            typeof deepLinks.metaDetailsStreams === 'string' ?
                deepLinks.metaDetailsStreams
                :
                typeof deepLinks.metaDetailsVideos === 'string' ?
                    deepLinks.metaDetailsVideos
                    :
                    typeof deepLinks.player === 'string' ?
                        deepLinks.player
                        :
                        null
            :
            null;
    }, [deepLinks]);

    const playHref = React.useMemo(() => {
        return deepLinks?.player ?? deepLinks?.metaDetailsStreams ?? null;
    }, [deepLinks]);

    const genres = React.useMemo(() => {
        if (!Array.isArray(links)) return [];
        return links
            .filter((l) => l.category === 'Genres')
            .map((l) => l.name)
            .slice(0, 3);
    }, [links]);

    // Extract item ID from deepLinks — supports IMDB (tt1234567) and TMDB (tmdb:1234) formats
    const itemId = React.useMemo(() => {
        const links = [deepLinks?.metaDetailsStreams, deepLinks?.metaDetailsVideos];
        for (const link of links) {
            if (typeof link !== 'string') continue;
            // IMDB ID
            const imdb = link.match(/\/(tt\d+)/);
            if (imdb) return imdb[1];
            // TMDB ID (tmdb:1234)
            const tmdb = link.match(/\/(tmdb:\d+)/);
            if (tmdb) return tmdb[1];
        }
        return null;
    }, [deepLinks]);

    // Sync optimistic state when prop changes (e.g. after core round-trip)
    React.useEffect(() => {
        setLocalWatched(null);
    }, [watched]);

    const isWatched = localWatched !== null ? localWatched : !!watched;

    // Mark item as watched in stremio-core (Trakt addon syncs automatically)
    const markAsWatched = React.useCallback(() => {
        if (!itemId) return;
        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'AddToLibrary',
                args: {
                    id: itemId,
                    type: type === 'series' ? 'series' : 'movie',
                    name: name || '',
                    poster: poster || '',
                    posterShape: 'landscape',
                    background: background || '',
                }
            }
        });
        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'LibraryItemMarkAsWatched',
                args: { id: itemId, is_watched: true }
            }
        });
    }, [itemId, type, name, poster, background, core]);

    const onToggleWatched = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!itemId) return;

        if (isWatched) {
            // Un-marking — just toggle off, no rating overlay
            setLocalWatched(false);
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'LibraryItemMarkAsWatched',
                    args: { id: itemId, is_watched: false }
                }
            });
            return;
        }

        // Show rating overlay — stop trailer so poster shows through blur
        setShowTrailer(false);
        clearTimeout(trailerTimerRef.current);
        setShowRating(true);
        setHoverStar(0);
    }, [itemId, isWatched, core]);

    const onStarClick = React.useCallback((rating) => {
        setShowRating(false);
        setLocalWatched(true);
        markAsWatched();
        // Fade out from recommendation rows
        setDismissed(true);
        // Store rating locally (Trakt OAuth would be needed for API sync)
        try {
            const ratings = JSON.parse(localStorage.getItem('stremio_ratings') || '{}');
            ratings[itemId] = rating;
            localStorage.setItem('stremio_ratings', JSON.stringify(ratings));
        } catch { /* silent */ }
    }, [itemId, markAsWatched]);

    const onSkipRating = React.useCallback((event) => {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        setShowRating(false);
        setLocalWatched(true);
        markAsWatched();
        setDismissed(true);
    }, [markAsWatched]);

    // TMDB trailer fetch — primary source with stremio fallback
    const [trailerYtId, setTrailerYtId] = React.useState(null);

    React.useEffect(() => {
        let cancelled = false;
        const fetchTrailer = async () => {
            const source = tmdbService.getTrailerSource();
            if (source === 'tmdb' && itemId) {
                try {
                    // If itemId is a TMDB ID (tmdb:1234), use it directly
                    const tmdbMatch = itemId.match(/^tmdb:(\d+)$/);
                    if (tmdbMatch) {
                        const tmdbId = parseInt(tmdbMatch[1], 10);
                        const mediaType = type === 'series' ? 'tv' : 'movie';
                        const ytId = await tmdbService.getBestTrailerYtId(tmdbId, mediaType);
                        if (ytId && !cancelled) { setTrailerYtId(ytId); return; }
                    } else {
                        // IMDB ID — look up TMDB entry first
                        const tmdbItem = await tmdbService.findByImdbId(itemId);
                        if (tmdbItem && !cancelled) {
                            const ytId = await tmdbService.getBestTrailerYtId(tmdbItem.id, tmdbItem.type);
                            if (ytId && !cancelled) { setTrailerYtId(ytId); return; }
                        }
                    }
                } catch { /* fall through */ }
            }
            if (!cancelled) {
                setTrailerYtId(pickBestTrailerFallback(trailerStreams));
            }
        };
        fetchTrailer();
        return () => { cancelled = true; };
    }, [itemId, trailerStreams]);

    // Fetch video aspect ratio via noembed when trailer changes
    React.useEffect(() => {
        if (!trailerYtId) { setVideoAR(CARD_AR); return; }
        let cancelled = false;
        fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(trailerYtId)}`)
            .then((r) => r.json())
            .then((data) => {
                if (!cancelled && data.width && data.height && data.height > 0) {
                    const ar = data.width / data.height;
                    if (ar >= 1.2 && ar <= 3.5) setVideoAR(ar);
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [trailerYtId]);

    // Detect letterboxing (black bars) from YouTube thumbnail
    React.useEffect(() => {
        if (!trailerYtId) { setLetterbox({ top: 0, bottom: 0 }); return; }
        let cancelled = false;
        detectLetterboxing(trailerYtId).then((result) => {
            if (!cancelled) setLetterbox(result);
        });
        return () => { cancelled = true; };
    }, [trailerYtId]);

    const onMouseEnter = React.useCallback(() => {
        // Measure poster dims BEFORE hover scale is applied
        if (posterRef.current) {
            originalDimsRef.current = {
                width: posterRef.current.offsetWidth,
                height: posterRef.current.offsetHeight,
            };
        }
        // Detect if card is near viewport edge — determines transform-origin
        // and trailer/hover-info anchor direction (Netflix-style edge handling)
        if (cardRef.current) {
            const rect = cardRef.current.getBoundingClientRect();
            const vw = window.innerWidth;
            if (rect.left < vw * 0.08) {
                setEdgePosition('left');
            } else if (rect.right > vw * 0.92) {
                setEdgePosition('right');
            } else {
                setEdgePosition('center');
            }
        }
        hoverTimerRef.current = setTimeout(() => {
            setIsHovered(true);
        }, 300);
        if (trailerYtId) {
            trailerTimerRef.current = setTimeout(() => {
                setShowTrailer(true);
                if (trailerCtx) trailerCtx.setActiveTrailer(cardIdRef.current);
            }, 2000);
        }
    }, [trailerYtId]);

    const onMouseLeave = React.useCallback(() => {
        clearTimeout(hoverTimerRef.current);
        clearTimeout(trailerTimerRef.current);
        setIsHovered(false);
        setShowTrailer(false);
        if (trailerCtx) trailerCtx.clearActiveTrailer(cardIdRef.current);
    }, []);

    React.useEffect(() => {
        return () => {
            clearTimeout(hoverTimerRef.current);
            clearTimeout(trailerTimerRef.current);
            if (trailerCtx) trailerCtx.clearActiveTrailer(cardIdRef.current);
        };
    }, []);

    const renderPosterFallback = React.useCallback(() => (
        <Icon
            className={styles['placeholder-icon']}
            name={ICON_FOR_TYPE.has(type) ? ICON_FOR_TYPE.get(type) : ICON_FOR_TYPE.get('other')}
        />
    ), [type]);

    const isTrailerPlaying = showTrailer && trailerYtId && isHovered;

    // Smooth trailer width animation — mount at poster width, then expand
    React.useEffect(() => {
        if (isTrailerPlaying) {
            setTrailerMounted(false);
            let cancelled = false;
            requestAnimationFrame(() => {
                if (cancelled) return;
                requestAnimationFrame(() => {
                    if (cancelled) return;
                    setTrailerMounted(true);
                });
            });
            return () => { cancelled = true; };
        }
        setTrailerMounted(false);
    }, [isTrailerPlaying]);

    // Card transform-origin — expand toward available space for edge cards
    const cardStyle = React.useMemo(() => {
        if (edgePosition === 'center') return undefined;
        return {
            transformOrigin: edgePosition === 'left' ? 'left center' : 'right center',
        };
    }, [edgePosition]);

    // Calculate trailer layer dimensions with edge-aware positioning
    const trailerLayerStyle = React.useMemo(() => {
        if (!isTrailerPlaying || !originalDimsRef.current) return null;
        const { width: posterW, height: posterH } = originalDimsRef.current;
        const overcrop = 0.015;
        const top = letterbox.top > 0 ? letterbox.top + overcrop : 0;
        const bottom = letterbox.bottom > 0 ? letterbox.bottom + overcrop : 0;
        const totalBars = top + bottom;
        const effectiveAR = totalBars > 0.01 ? videoAR / (1 - totalBars) : videoAR;
        const targetW = posterH * effectiveAR;
        const currentW = trailerMounted ? targetW : posterW;

        const style = {
            width: `${currentW}px`,
            height: `${posterH}px`,
        };

        if (edgePosition === 'left') {
            style.left = '0';
            style.transform = 'none';
        } else if (edgePosition === 'right') {
            style.left = 'auto';
            style.right = '0';
            style.transform = 'none';
        }

        return style;
    }, [isTrailerPlaying, videoAR, letterbox, trailerMounted, edgePosition]);

    // Calculate hover-info style — match trailer width and edge positioning
    const hoverInfoStyle = React.useMemo(() => {
        if (!isTrailerPlaying || !trailerMounted || !originalDimsRef.current) return undefined;
        const { width: posterW, height: posterH } = originalDimsRef.current;
        const overcrop = 0.015;
        const top = letterbox.top > 0 ? letterbox.top + overcrop : 0;
        const bottom = letterbox.bottom > 0 ? letterbox.bottom + overcrop : 0;
        const totalBars = top + bottom;
        const effectiveAR = totalBars > 0.01 ? videoAR / (1 - totalBars) : videoAR;
        const trailerW = posterH * effectiveAR;

        if (trailerW <= posterW * 1.02) return undefined;

        if (edgePosition === 'left') {
            return { left: '0', right: 'auto', width: `${trailerW}px` };
        } else if (edgePosition === 'right') {
            return { left: 'auto', right: '0', width: `${trailerW}px` };
        }
        const overshoot = (trailerW - posterW) / 2;
        return { left: `${-overshoot}px`, right: 'auto', width: `${trailerW}px` };
    }, [isTrailerPlaying, trailerMounted, videoAR, letterbox, edgePosition]);

    // Calculate crop style to remove detected letterbox black bars
    // Add a small overcompensation (1.5% extra per bar) to eat thin residual lines
    const trailerCropStyle = React.useMemo(() => {
        const overcrop = 0.015;
        const top = letterbox.top > 0 ? letterbox.top + overcrop : 0;
        const bottom = letterbox.bottom > 0 ? letterbox.bottom + overcrop : 0;
        const totalBars = top + bottom;
        if (totalBars < 0.01) return undefined;
        const scale = 1 / (1 - totalBars);
        const topOffset = top * scale * 100;
        return {
            position: 'absolute',
            top: `-${topOffset}%`,
            left: '0',
            width: '100%',
            height: `${scale * 100}%`,
        };
    }, [letterbox]);

    return (
        <div
            ref={cardRef}
            className={classnames(className, styles['meta-item-container'], {
                [styles['hovered']]: isHovered,
                [styles['trailer-playing']]: isTrailerPlaying,
                [styles['edge-left']]: edgePosition === 'left',
                [styles['edge-right']]: edgePosition === 'right',
                [styles['dismissed']]: dismissed,
            })}
            style={cardStyle}
            data-hovered={isHovered ? 'true' : undefined}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <Button title={name} href={href} ref={posterRef} className={styles['poster-container']}>
                <div className={styles['poster-image-layer']}>
                    <Image
                        className={styles['poster-image']}
                        src={thumbnailSrc}
                        alt={' '}
                        renderFallback={renderPosterFallback}
                    />
                </div>
                <div className={styles['card-title-overlay']}>
                    <span className={styles['card-title']}>{name}</span>
                </div>
                {
                    isWatched ?
                        <div className={styles['watched-icon-layer']}>
                            <Icon className={styles['watched-icon']} name={'checkmark'} />
                        </div>
                        :
                        null
                }
                {
                    progress > 0 ?
                        <div className={styles['progress-bar-layer']}>
                            <div className={styles['progress-bar']} style={{ width: `${progress}%` }} />
                            <div className={styles['progress-bar-background']} />
                        </div>
                        :
                        null
                }
                {
                    newVideos > 0 ?
                        <div className={styles['new-videos-badge']}>
                            <span>{newVideos} New</span>
                        </div>
                        :
                        null
                }
            </Button>
            {
                isTrailerPlaying ?
                    <div className={styles['card-trailer-layer']} style={trailerLayerStyle}>
                        <YouTubePlayer
                            ytId={trailerYtId}
                            muted={globalMuted}
                            paused={!pageVisible}
                            className={styles['card-trailer-player']}
                            style={trailerCropStyle}
                            overlayScale={0.28}
                        />
                    </div>
                    :
                    null
            }
            {
                isHovered ?
                    <div className={styles['hover-info']} style={hoverInfoStyle}>
                        <div className={styles['hover-buttons']}>
                            {
                                playHref ?
                                    <Button className={classnames(styles['hover-btn'], styles['hover-btn-play'])} href={playHref}>
                                        <Icon className={styles['hover-btn-icon']} name={'play'} />
                                    </Button>
                                    :
                                    null
                            }
                            <Button className={styles['hover-btn']} href={href}>
                                <Icon className={styles['hover-btn-icon']} name={'add'} />
                            </Button>
                            {
                                itemId ?
                                    <Button
                                        className={classnames(styles['hover-btn'], { [styles['hover-btn-watched']]: isWatched })}
                                        onClick={onToggleWatched}
                                    >
                                        <Icon className={styles['hover-btn-icon']} name={'checkmark'} />
                                    </Button>
                                    :
                                    null
                            }
                            <Button className={classnames(styles['hover-btn'], styles['hover-btn-chevron'])} href={href}>
                                <Icon className={styles['hover-btn-icon']} name={'chevron-down'} />
                            </Button>
                        </div>
                        <div className={styles['hover-meta']}>
                            {
                                typeof releaseInfo === 'string' && releaseInfo.length > 0 ?
                                    <span className={styles['hover-year']}>{releaseInfo}</span>
                                    :
                                    null
                            }
                            {
                                genres.length > 0 ?
                                    genres.map((g, i) => (
                                        <React.Fragment key={i}>
                                            <span className={styles['genre-dot']}>{'\u2022'}</span>
                                            <span className={styles['genre-label']}>{g}</span>
                                        </React.Fragment>
                                    ))
                                    :
                                    null
                            }
                        </div>
                    </div>
                    :
                    null
            }
            {
                showRating ?
                    <div className={styles['rating-overlay']} onClick={onSkipRating}>
                        <div className={styles['rating-content']} onClick={(e) => e.stopPropagation()}>
                            <div className={styles['rating-title']}>Rate this title</div>
                            <div className={styles['rating-name']}>{name}</div>
                            <div className={styles['rating-stars']}>
                                {[1, 2, 3, 4, 5].map((star) => (
                                    <button
                                        key={star}
                                        className={classnames(styles['rating-star'], {
                                            [styles['rating-star-active']]: star <= hoverStar,
                                        })}
                                        onMouseEnter={() => setHoverStar(star)}
                                        onMouseLeave={() => setHoverStar(0)}
                                        onClick={() => onStarClick(star)}
                                    >
                                        {'\u2605'}
                                    </button>
                                ))}
                            </div>
                            <button className={styles['rating-skip']} onClick={onSkipRating}>
                                Skip
                            </button>
                        </div>
                    </div>
                    :
                    null
            }
        </div>
    );
});

MetaItem.displayName = 'MetaItem';

MetaItem.propTypes = {
    className: PropTypes.string,
    type: PropTypes.string,
    name: PropTypes.string,
    poster: PropTypes.string,
    background: PropTypes.string,
    posterShape: PropTypes.oneOf(['poster', 'landscape', 'square']),
    progress: PropTypes.number,
    newVideos: PropTypes.number,
    deepLinks: PropTypes.shape({
        metaDetailsVideos: PropTypes.string,
        metaDetailsStreams: PropTypes.string,
        player: PropTypes.string,
    }),
    dataset: PropTypes.object,
    onPlayClick: PropTypes.func,
    watched: PropTypes.bool,
    trailerStreams: PropTypes.array,
    releaseInfo: PropTypes.string,
    links: PropTypes.array,
};

module.exports = MetaItem;
