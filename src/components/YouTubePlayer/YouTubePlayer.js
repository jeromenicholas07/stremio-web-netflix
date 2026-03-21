// Copyright (C) 2017-2024 Smart code 203358507
// YouTube player using the IFrame API for programmatic control

const React = require('react');
const PropTypes = require('prop-types');
const { loadYouTubeAPI } = require('stremio/services/YouTubePlayerAPI');
const styles = require('./styles');

const YouTubePlayer = React.forwardRef(({ ytId, muted, paused, onEnded, onPlaying, className, style, overlayScale }, ref) => {
    const containerRef = React.useRef(null);
    const playerRef = React.useRef(null);
    const [ready, setReady] = React.useState(false);
    const destroyedRef = React.useRef(false);

    // Expose controls
    React.useImperativeHandle(ref, () => ({
        pause: () => {
            try { playerRef.current?.pauseVideo(); } catch (e) { /* */ }
        },
        play: () => {
            try { playerRef.current?.playVideo(); } catch (e) { /* */ }
        },
        mute: () => {
            try { playerRef.current?.mute(); } catch (e) { /* */ }
        },
        unMute: () => {
            try { playerRef.current?.unMute(); } catch (e) { /* */ }
        },
    }), []);

    // Create player
    React.useEffect(() => {
        if (!ytId || !containerRef.current) return;

        destroyedRef.current = false;
        setReady(false);

        const holderDiv = document.createElement('div');
        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(holderDiv);

        loadYouTubeAPI().then((YT) => {
            if (destroyedRef.current) return;

            const player = new YT.Player(holderDiv, {
                videoId: ytId,
                playerVars: {
                    autoplay: 1,
                    mute: muted ? 1 : 0,
                    controls: 0,
                    modestbranding: 1,
                    rel: 0,
                    showinfo: 0,
                    iv_load_policy: 3,
                    playsinline: 1,
                    disablekb: 1,
                    fs: 0,
                    origin: window.location.origin,
                },
                events: {
                    onReady: (event) => {
                        if (destroyedRef.current) return;
                        playerRef.current = event.target;
                        // Style the iframe to fill container
                        const iframe = event.target.getIframe();
                        if (iframe) {
                            iframe.style.position = 'absolute';
                            iframe.style.border = 'none';
                            iframe.style.pointerEvents = 'none';
                            // overlayScale trick: make iframe physically larger,
                            // then CSS-scale it down. YouTube renders its UI for
                            // the larger size, so overlays appear proportionally smaller.
                            const s = overlayScale && overlayScale < 1 ? overlayScale : 1;
                            if (s < 1) {
                                const factor = 1 / s;
                                iframe.style.width = `${factor * 100}%`;
                                iframe.style.height = `${factor * 100}%`;
                                iframe.style.transform = `scale(${s})`;
                                iframe.style.transformOrigin = '0 0';
                                iframe.style.top = '0';
                                iframe.style.left = '0';
                            } else {
                                iframe.style.top = '0';
                                iframe.style.left = '0';
                                iframe.style.width = '100%';
                                iframe.style.height = '100%';
                            }
                        }
                        setReady(true);
                    },
                    onStateChange: (event) => {
                        if (destroyedRef.current) return;
                        if (event.data === YT.PlayerState.ENDED && onEnded) {
                            onEnded();
                        } else if (event.data === YT.PlayerState.PLAYING && onPlaying) {
                            onPlaying();
                        }
                    },
                },
            });
        });

        return () => {
            destroyedRef.current = true;
            if (playerRef.current) {
                try { playerRef.current.destroy(); } catch (e) { /* */ }
            }
            playerRef.current = null;
            setReady(false);
        };
    }, [ytId]);

    // Mute/unmute
    React.useEffect(() => {
        if (!ready || !playerRef.current) return;
        try {
            if (muted) {
                playerRef.current.mute();
            } else {
                playerRef.current.unMute();
            }
        } catch (e) { /* */ }
    }, [muted, ready]);

    // Pause/play
    React.useEffect(() => {
        if (!ready || !playerRef.current) return;
        try {
            if (paused) {
                playerRef.current.pauseVideo();
            } else {
                playerRef.current.playVideo();
            }
        } catch (e) { /* */ }
    }, [paused, ready]);

    return (
        <div ref={containerRef} className={className || styles['youtube-player-container']} style={style} />
    );
});

YouTubePlayer.displayName = 'YouTubePlayer';

YouTubePlayer.propTypes = {
    ytId: PropTypes.string.isRequired,
    muted: PropTypes.bool,
    paused: PropTypes.bool,
    onEnded: PropTypes.func,
    onPlaying: PropTypes.func,
    className: PropTypes.string,
    style: PropTypes.object,
    overlayScale: PropTypes.number,
};

module.exports = YouTubePlayer;
