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
const traktBridge = require('stremio/services/TraktBridge');
const styles = require('./styles');

// Emit toast events so a top-level listener can display them via the ToastProvider.
// This avoids using useToast() hook inside MetaItem which can cause hook-count issues
// when MetaItem is wrapped by React.memo + multiple HOCs (LibItem, ContinueWatchingItem).
function showToast(opts) {
    window.dispatchEvent(new CustomEvent('stremio-toast', { detail: opts }));
}

let cardIdCounter = 0;

// Mute icon — same as HeroBanner: identical speaker in both states, only accessory changes
const SPEAKER_PATH = 'M10 3.75a.75.75 0 0 0-1.264-.546L4.703 7H3.167c-.587 0-1.14.294-1.46.756A6.018 6.018 0 0 0 1.25 10c0 1.192.348 2.302.942 3.236.32.462.873.764 1.46.764h1.086l4.033 3.796A.75.75 0 0 0 10 16.25V3.75Z';
const MuteIcon = React.memo(({ muted, size }) => {
    const s = size || 16;
    return (
        <svg width={s} height={s} viewBox="0 0 20 20" fill="white" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
            <path d={SPEAKER_PATH} />
            {muted ? (
                <path d="M13.28 7.22a.75.75 0 1 0-1.06 1.06L13.94 10l-1.72 1.72a.75.75 0 0 0 1.06 1.06L15 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L16.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L15 8.94l-1.72-1.72Z" />
            ) : (
                <React.Fragment>
                    <path d="M15.95 5.06a.75.75 0 0 0-1.06 1.06 5.5 5.5 0 0 1 0 7.78.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.9Z" />
                    <path d="M13.829 7.172a.75.75 0 0 0-1.06 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z" />
                </React.Fragment>
            )}
        </svg>
    );
});
MuteIcon.displayName = 'MuteIcon';

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

const MetaItem = React.memo(({ className, type, name, poster, posterShape, background, progress, newVideos, deepLinks, dataset, onPlayClick, watched, trailerStreams, releaseInfo, links, disableTrailerExpand, onCWAction, onDismissClick, rateMode, onRated, rowContext, ...props }) => {
    const { core } = useServices();
    const trailerCtx = React.useContext(TrailerContext);
    const [isHovered, setIsHovered] = React.useState(false);
    const [localWatched, setLocalWatched] = React.useState(null); // optimistic override
    const [showRating, setShowRating] = React.useState(false); // rating overlay visible
    const [hoverStar, setHoverStar] = React.useState(0); // star being hovered (1-5)
    const [dismissed, setDismissed] = React.useState(false); // fade out after marking watched/not-interested
    const [showTrailer, setShowTrailer] = React.useState(false);
    const [edgePosition, setEdgePosition] = React.useState('center');
    const hoverTimerRef = React.useRef(null);
    const trailerTimerRef = React.useRef(null);
    const cardRef = React.useRef(null);
    const cardIdRef = React.useRef(`card-${++cardIdCounter}`);
    const posterRef = React.useRef(null);
    const originalDimsRef = React.useRef(null);
    const trailerPlayerRef = React.useRef(null);
    const [trailerMounted, setTrailerMounted] = React.useState(false);

    const thumbnailSrc = background || poster;
    const globalMuted = trailerCtx ? trailerCtx.globalMuted : true;
    const pageVisible = trailerCtx ? trailerCtx.pageVisible : true;

    // Video aspect ratio — fetched from oEmbed, defaults to 16:9
    const [videoAR, setVideoAR] = React.useState(CARD_AR);
    // Letterbox detection — { top, bottom } as fractions
    const [letterbox, setLetterbox] = React.useState({ top: 0, bottom: 0 });

    // TMDB logo — shows a title logo on the card instead of plain text.
    const isCWItem = typeof onCWAction === 'function';
    const [logoUrl, setLogoUrl] = React.useState(null);

    // Default click navigates to streams (for poster click → play)
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

    // "More Info" navigates to details page with ?info=1 query param.
    // This signals MetaDetails/StreamsList to NOT auto-pick a stream.
    const infoHref = React.useMemo(() => {
        const raw = deepLinks?.metaDetailsVideos ?? deepLinks?.metaDetailsStreams ?? null;
        if (typeof raw !== 'string') return null;
        // Append ?info=1 to signal "info mode" (no auto-pick)
        const separator = raw.includes('?') ? '&' : '?';
        return `${raw}${separator}info=1`;
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

    // Mark item as watched in stremio-core (library + watched flag)
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

    // Ref to track if we already synced watched for this toggle (avoid double-sync)
    const watchedSyncedRef = React.useRef(false);

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

        // Mark as watched immediately — Trakt syncs NOW, not after rating
        setLocalWatched(true);
        markAsWatched();
        watchedSyncedRef.current = true;
        if (traktBridge.isConnected()) {
            const itemType = type === 'series' ? 'series' : 'movie';
            traktBridge.markWatched(itemId, itemType, name).catch((err) => {
                showToast({ type: 'error', title: 'Mark watched failed', message: err.message, timeout: 5000 });
            });
        }

        // Show rating overlay — item stays visible until user rates or skips
        setShowTrailer(false);
        clearTimeout(trailerTimerRef.current);
        setShowRating(true);
        setHoverStar(0);
    }, [itemId, isWatched, core, type, name, markAsWatched]);

    const onStarClick = React.useCallback((rating) => {
        setShowRating(false);
        setDismissed(true);
        // Dismiss from discovery rows now that the rating overlay is done
        traktBridge.dismissWatched(itemId);
        window.dispatchEvent(new Event('stremio-dismissed-updated'));
        // Sync rating to Trakt (watched already synced in onToggleWatched)
        if (traktBridge.isConnected()) {
            const itemType = type === 'series' ? 'series' : 'movie';
            traktBridge.rateItem(itemId, itemType, rating).then((result) => {
                if (result.ok) {
                    showToast({ type: 'success', title: `Rated ${rating}/5`, message: name || itemId, timeout: 3000 });
                } else {
                    showToast({ type: 'error', title: 'Rating failed', message: `Trakt API returned ${result.status}`, timeout: 5000 });
                }
            }).catch((err) => {
                showToast({ type: 'error', title: 'Rating error', message: err.message, timeout: 5000 });
            });
        } else {
            showToast({ type: 'error', title: 'Trakt not connected', message: 'Rating not synced — connect Trakt in Settings.', timeout: 5000 });
        }
        if (typeof onCWAction === 'function') onCWAction('rated');
    }, [itemId, type, name, onCWAction]);

    const onSkipRating = React.useCallback((event) => {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        setShowRating(false);
        setDismissed(true);
        // Mark as dismissed in TraktBridge so it's filtered from all discovery rows
        traktBridge.dismissWatched(itemId);
        window.dispatchEvent(new Event('stremio-dismissed-updated'));
        if (typeof onCWAction === 'function') onCWAction('skipped-rating');
    }, [itemId, onCWAction]);

    // Add to Trakt watchlist — also removes from Not Interested if present
    const onAddToWatchlist = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!itemId) return;
        const itemType = type === 'series' ? 'series' : 'movie';
        if (!traktBridge.isConnected()) {
            showToast({
                type: 'error',
                title: 'Trakt not connected',
                message: 'Go to Settings → Modern UI → Trakt to connect your account.',
                timeout: 5000,
            });
            return;
        }
        // If moving from Not Interested → Watchlist, the item will be removed from
        // the NI array optimistically by removeFromNotInterested, so we don't need
        // setDismissed (which would wrongly dismiss the component reused at this index).
        const isMovingFromNI = traktBridge._notInterestedIds.has(itemId);
        if (isMovingFromNI) {
            traktBridge.removeFromNotInterested(itemId, itemType).catch(() => {});
        }
        traktBridge.addToWatchlist(itemId, itemType, name).then((result) => {
            if (result.ok) {
                showToast({ type: 'success', title: 'Added to Watchlist', message: name || itemId, timeout: 3000 });
                // Only dismiss from discovery rows — list moves are handled by array updates
                if (!isMovingFromNI) {
                    setDismissed(true);
                }
                window.dispatchEvent(new Event('stremio-dismissed-updated'));
                if (typeof onCWAction === 'function') onCWAction('watchlist');
            } else {
                showToast({
                    type: 'error',
                    title: 'Failed to add to Watchlist',
                    message: `Trakt API returned ${result.status}${result.data ? ': ' + JSON.stringify(result.data).slice(0, 150) : ''}`,
                    timeout: 6000,
                });
            }
        }).catch((err) => {
            showToast({
                type: 'error',
                title: 'Watchlist error',
                message: `${err.message} [${itemId}]`,
                timeout: 6000,
            });
        });
    }, [itemId, type, name, onCWAction]);

    // "Not interested" — also removes from Watchlist if present
    const onNotInterested = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!itemId) return;
        const itemType = type === 'series' ? 'series' : 'movie';
        if (!traktBridge.isConnected()) {
            showToast({
                type: 'error',
                title: 'Trakt not connected',
                message: 'Go to Settings → Modern UI → Trakt to connect your account.',
                timeout: 5000,
            });
            return;
        }
        // If moving from Watchlist → Not Interested, the item will be removed from
        // the watchlist array optimistically, so we don't need setDismissed.
        const isMovingFromWatchlist = traktBridge._watchlistIds.has(itemId);
        if (isMovingFromWatchlist) {
            traktBridge.removeFromWatchlist(itemId, itemType).catch(() => {});
        }
        traktBridge.addToNotInterested(itemId, itemType, name).then((result) => {
            if (result.ok) {
                showToast({ type: 'success', title: 'Marked as Not Interested', message: name || itemId, timeout: 3000 });
                // Only dismiss from discovery rows — list moves are handled by array updates
                if (!isMovingFromWatchlist) {
                    setDismissed(true);
                }
                window.dispatchEvent(new Event('stremio-dismissed-updated'));
                if (typeof onCWAction === 'function') onCWAction('not-interested');
            } else {
                showToast({
                    type: 'error',
                    title: 'Failed to mark Not Interested',
                    message: `Trakt API returned ${result.status}${result.data ? ': ' + JSON.stringify(result.data).slice(0, 150) : ''}`,
                    timeout: 6000,
                });
            }
        }).catch((err) => {
            showToast({
                type: 'error',
                title: 'Not Interested error',
                message: `${err.message} [${itemId}]`,
                timeout: 6000,
            });
        });
    }, [itemId, type, name, onCWAction]);

    // TMDB trailer fetch — primary source with stremio fallback
    const [trailerYtId, setTrailerYtId] = React.useState(null);

    React.useEffect(() => {
        // Skip trailer fetch entirely for Continue Watching items
        if (isCWItem) { setTrailerYtId(null); return; }
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
    }, [isCWItem, itemId, trailerStreams]);

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

    // Fetch TMDB logo for title overlay on all MetaItems.
    // Falls back to plain text title if no logo is available.
    React.useEffect(() => {
        if (!itemId) { setLogoUrl(null); return; }
        let cancelled = false;
        (async () => {
            try {
                const resolved = await tmdbService.resolveTmdbId(itemId, type);
                if (!resolved || cancelled) return;
                const url = await tmdbService.getLogoUrl(resolved.tmdbId, resolved.mediaType);
                if (url && !cancelled) setLogoUrl(url);
            } catch { /* silent */ }
        })();
        return () => { cancelled = true; };
    }, [itemId, type]);

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
        if (trailerYtId && !isCWItem) {
            trailerTimerRef.current = setTimeout(() => {
                setShowTrailer(true);
                if (trailerCtx) trailerCtx.setActiveTrailer(cardIdRef.current);
            }, 2000);
        }
    }, [trailerYtId, isCWItem]);

    const onMouseLeave = React.useCallback(() => {
        clearTimeout(hoverTimerRef.current);
        clearTimeout(trailerTimerRef.current);
        setIsHovered(false);
        setShowTrailer(false);
        if (trailerCtx) trailerCtx.clearActiveTrailer(cardIdRef.current);
    }, []);

    // Stop trailer on navigation (hashchange) and on unmount
    React.useEffect(() => {
        const stopTrailer = () => {
            clearTimeout(hoverTimerRef.current);
            clearTimeout(trailerTimerRef.current);
            setIsHovered(false);
            setShowTrailer(false);
            if (trailerCtx) trailerCtx.clearActiveTrailer(cardIdRef.current);
        };
        window.addEventListener('hashchange', stopTrailer);
        return () => {
            window.removeEventListener('hashchange', stopTrailer);
            stopTrailer();
        };
    }, []);

    const renderPosterFallback = React.useCallback(() => (
        <Icon
            className={styles['placeholder-icon']}
            name={ICON_FOR_TYPE.has(type) ? ICON_FOR_TYPE.get(type) : ICON_FOR_TYPE.get('other')}
        />
    ), [type]);

    const isTrailerPlaying = showTrailer && trailerYtId && isHovered;

    // Smooth trailer width animation — mount at poster width, then expand after layout settles
    React.useEffect(() => {
        if (isTrailerPlaying) {
            setTrailerMounted(false);
            let cancelled = false;
            // Wait one frame for the trailer layer to render at poster width,
            // then trigger the CSS transition to target width
            const timer = setTimeout(() => {
                if (!cancelled) setTrailerMounted(true);
            }, 50);
            return () => { cancelled = true; clearTimeout(timer); };
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

    // Shared computed width for trailer + hover-info — ensures pixel-perfect alignment
    const expandedWidth = React.useMemo(() => {
        if (!isTrailerPlaying || !originalDimsRef.current) return null;
        const { width: posterW, height: posterH } = originalDimsRef.current;
        // Container width includes padding (0.2rem each side)
        const containerW = cardRef.current ? cardRef.current.offsetWidth : posterW;
        const overcrop = 0.015;
        const top = letterbox.top > 0 ? letterbox.top + overcrop : 0;
        const bottom = letterbox.bottom > 0 ? letterbox.bottom + overcrop : 0;
        const totalBars = top + bottom;
        const effectiveAR = totalBars > 0.01 ? videoAR / (1 - totalBars) : videoAR;
        const targetW = Math.ceil(posterH * effectiveAR);
        const currentW = trailerMounted ? targetW : posterW;
        return { posterW, posterH, currentW, containerW };
    }, [isTrailerPlaying, videoAR, letterbox, trailerMounted]);

    // Calculate trailer layer dimensions with edge-aware positioning
    const trailerLayerStyle = React.useMemo(() => {
        if (!expandedWidth) return null;
        const { currentW, posterH } = expandedWidth;

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
    }, [expandedWidth, edgePosition]);

    // Calculate hover-info style — pixel-perfect alignment with trailer layer
    // Trailer uses: left: 50% of container, translateX(-50% of own width)
    // So trailer left edge = (containerW - currentW) / 2
    // Hover-info is positioned with left/right relative to container
    const hoverInfoStyle = React.useMemo(() => {
        if (!expandedWidth) return undefined;
        const { currentW, containerW } = expandedWidth;

        if (edgePosition === 'left') {
            return { left: '0', right: 'auto', width: `${currentW}px` };
        } else if (edgePosition === 'right') {
            return { left: 'auto', right: '0', width: `${currentW}px` };
        }
        // Exact same calculation as CSS left:50% + translateX(-50%)
        const leftPos = (containerW - currentW) / 2;
        return { left: `${leftPos}px`, right: 'auto', width: `${currentW}px` };
    }, [expandedWidth, edgePosition]);

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

    // ─── Rate Mode: blurred card with permanent star rating overlay ───
    // Used for the "Watched (Not Rated)" row
    const onRateModeRate = React.useCallback((rating) => {
        if (!itemId) return;
        const itemType = type === 'series' ? 'series' : 'movie';
        // Push rating to Trakt (source of truth)
        if (traktBridge.isConnected()) {
            traktBridge.rateItem(itemId, itemType, rating).then((result) => {
                if (result.ok) {
                    showToast({ type: 'success', title: `Rated ${rating}/5`, message: name || itemId, timeout: 3000 });
                } else {
                    showToast({ type: 'error', title: 'Rating failed', message: `Trakt API returned ${result.status}`, timeout: 5000 });
                }
            }).catch((err) => {
                showToast({ type: 'error', title: 'Rating error', message: err.message, timeout: 5000 });
            });
        } else {
            showToast({ type: 'error', title: 'Trakt not connected', message: 'Rating not synced — connect Trakt in Settings.', timeout: 5000 });
        }
        setDismissed(true);
        window.dispatchEvent(new Event('stremio-dismissed-updated'));
        if (typeof onRated === 'function') onRated(itemId, rating);
    }, [itemId, type, name, onRated]);

    if (rateMode) {
        return (
            <div
                ref={cardRef}
                className={classnames(className, styles['meta-item-container'], styles['rate-mode'], {
                    [styles['dismissed']]: dismissed,
                })}
            >
                <div className={styles['poster-container']}>
                    <div className={styles['poster-image-layer']} style={{ filter: 'blur(6px) brightness(0.4)' }}>
                        <Image
                            className={styles['poster-image']}
                            src={thumbnailSrc}
                            alt={' '}
                            renderFallback={renderPosterFallback}
                        />
                    </div>
                    <div className={styles['rate-mode-overlay']}>
                        {
                            logoUrl ?
                                <img className={styles['rate-mode-logo']} src={logoUrl} alt={name || ''} />
                                :
                                <div className={styles['rate-mode-title']}>{name}</div>
                        }
                        <div className={styles['rating-stars']}>
                            {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                    key={star}
                                    className={classnames(styles['rating-star'], {
                                        [styles['rating-star-active']]: star <= hoverStar,
                                    })}
                                    onMouseEnter={() => setHoverStar(star)}
                                    onMouseLeave={() => setHoverStar(0)}
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRateModeRate(star); }}
                                >
                                    {'\u2605'}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={cardRef}
            className={classnames(className, styles['meta-item-container'], {
                [styles['hovered']]: isHovered,
                [styles['trailer-playing']]: isTrailerPlaying,
                [styles['edge-left']]: edgePosition === 'left',
                [styles['edge-right']]: edgePosition === 'right',
                [styles['dismissed']]: dismissed,
                [styles['cw-mode']]: isCWItem,
            })}
            style={cardStyle}
            data-hovered={isHovered ? 'true' : undefined}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <Button href={href} ref={posterRef} className={styles['poster-container']}>
                <div className={styles['poster-image-layer']}>
                    <Image
                        className={styles['poster-image']}
                        src={thumbnailSrc}
                        alt={' '}
                        renderFallback={renderPosterFallback}
                    />
                </div>
                <div className={styles['card-title-overlay']}>
                    {
                        logoUrl ?
                            <img className={styles['card-logo']} src={logoUrl} alt={name || ''} />
                            :
                            <span className={styles['card-title']}>{name}</span>
                    }
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
                {
                    typeof onCWAction === 'function' && progress >= 90 && !isWatched ?
                        <div className={styles['rate-this-badge']} onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setShowTrailer(false);
                            clearTimeout(trailerTimerRef.current);
                            setShowRating(true);
                            setHoverStar(0);
                        }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="#FFD700" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                            </svg>
                            <span>Rate This</span>
                        </div>
                        :
                        null
                }
            </Button>
            {
                isCWItem && typeof onDismissClick === 'function' ?
                    <div
                        className={styles['card-dismiss-btn']}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onDismissClick(e);
                        }}
                        aria-label="Remove from Continue Watching"
                        title="Remove from Continue Watching"
                    >
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.75)" stroke="rgba(255,255,255,0.7)" strokeWidth="1.2" />
                            <line x1="8" y1="8" x2="16" y2="16" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
                            <line x1="16" y1="8" x2="8" y2="16" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
                        </svg>
                    </div>
                    :
                    null
            }
            {
                isTrailerPlaying ?
                    <div className={styles['card-trailer-layer']} style={trailerLayerStyle}>
                        <YouTubePlayer
                            ref={trailerPlayerRef}
                            ytId={trailerYtId}
                            muted={globalMuted}
                            paused={!pageVisible}
                            className={styles['card-trailer-player']}
                            style={trailerCropStyle}
                            overlayScale={0.28}
                        />
                        {/* Click-capture overlay — intercepts clicks on the YouTube iframe
                            (cross-origin iframes eat mouse events). Navigates same as poster. */}
                        <a href={href} className={styles['trailer-click-capture']} aria-label={name || 'Play'} />
                        <button
                            className={classnames(styles['card-trailer-btn'], styles['card-promote-btn'])}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (trailerCtx) {
                                    const currentTime = trailerPlayerRef.current?.getCurrentTime() || 0;
                                    trailerCtx.promoteToHero({
                                        id: itemId,
                                        name: name || '',
                                        poster: poster || '',
                                        background: background || poster || '',
                                        type: type,
                                        deepLinks: deepLinks,
                                        trailerStreams: trailerStreams,
                                        trailerYtId: trailerYtId,
                                        trailerStartTime: Math.max(0, currentTime - 2),
                                    });
                                }
                            }}
                            aria-label={'Play in banner'}
                        >
                            <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="rgba(0,0,0,0.35)" />
                                <polyline points="14,24 20,18 26,24" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            </svg>
                        </button>
                        <button
                            className={classnames(styles['card-trailer-btn'], styles['card-mute-btn'])}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (trailerCtx) trailerCtx.toggleGlobalMute();
                            }}
                        >
                            <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="rgba(0,0,0,0.35)" />
                                <g transform="translate(10, 10)" fill="white">
                                    <path d={SPEAKER_PATH} />
                                    {globalMuted ? (
                                        <path d="M13.28 7.22a.75.75 0 1 0-1.06 1.06L13.94 10l-1.72 1.72a.75.75 0 0 0 1.06 1.06L15 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L16.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L15 8.94l-1.72-1.72Z" />
                                    ) : (
                                        <React.Fragment>
                                            <path d="M15.95 5.06a.75.75 0 0 0-1.06 1.06 5.5 5.5 0 0 1 0 7.78.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.9Z" />
                                            <path d="M13.829 7.172a.75.75 0 0 0-1.06 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z" />
                                        </React.Fragment>
                                    )}
                                </g>
                            </svg>
                        </button>
                    </div>
                    :
                    null
            }
            {
                isHovered ?
                    <div className={styles['hover-info']} style={hoverInfoStyle}>
                        <div className={styles['hover-buttons']}>
                            {
                                rowContext !== 'watchlist' ?
                                    <Button
                                        className={styles['hover-btn']}
                                        onClick={onAddToWatchlist}
                                        title={rowContext === 'not-interested' ? 'Move to watchlist' : 'Add to watchlist'}
                                    >
                                        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="rgba(0,0,0,0.35)" />
                                            <line x1="20" y1="13" x2="20" y2="27" stroke="white" strokeWidth="2" strokeLinecap="round" />
                                            <line x1="13" y1="20" x2="27" y2="20" stroke="white" strokeWidth="2" strokeLinecap="round" />
                                        </svg>
                                    </Button>
                                    :
                                    null
                            }
                            {
                                itemId && rowContext !== 'not-interested' ?
                                    <Button
                                        className={styles['hover-btn']}
                                        onClick={onNotInterested}
                                        title={rowContext === 'watchlist' ? 'Move to not interested' : 'Not interested'}
                                    >
                                        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="rgba(0,0,0,0.35)" />
                                            <line x1="13" y1="20" x2="27" y2="20" stroke="white" strokeWidth="2" strokeLinecap="round" />
                                        </svg>
                                    </Button>
                                    :
                                    null
                            }
                            {
                                itemId && !isCWItem ?
                                    <Button
                                        className={styles['hover-btn']}
                                        onClick={onToggleWatched}
                                        title={isWatched ? 'Unmark watched' : 'Mark as watched'}
                                    >
                                        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <circle cx="20" cy="20" r="18" stroke={isWatched ? 'var(--primary-accent-color)' : 'rgba(255,255,255,0.5)'} strokeWidth="1.5" fill={isWatched ? 'var(--primary-accent-color)' : 'rgba(0,0,0,0.35)'} />
                                            <polyline points="12,20 17,25 28,14" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                                        </svg>
                                    </Button>
                                    :
                                    null
                            }
                            <Button className={styles['hover-btn']} href={infoHref} title="More info">
                                <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="rgba(0,0,0,0.35)" />
                                    <polyline points="14,17 20,23 26,17" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                                </svg>
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
