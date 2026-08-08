// Copyright (C) 2017-2023 Smart code 203358507

// When an audio output disappears mid-stream (a Bluetooth speaker powering off,
// headphones unplugged), the media element keeps its audio renderer bound to the
// device that is now gone. Turning the speaker back on does not re-bind it, so
// playback resumes with picture but no sound until the stream is reloaded.
//
// A real seek is what forces the renderer to drop its decoded audio and re-open
// the output, so that is what we do on `devicechange`. It is MSE/hls.js safe,
// unlike reloading the source. If the device changed while playback was paused
// (Android pauses on "becoming noisy") there is nothing to re-bind yet, so we
// remember it and recover on the next play instead.

const React = require('react');

const DEVICE_CHANGE_DEBOUNCE = 500;
const SEEK_BACK = 0.25;

const useAudioOutputRecovery = (containerRef) => {
    const timeoutRef = React.useRef(null);
    const pendingRef = React.useRef(false);

    React.useEffect(() => {
        const getVideoElement = () => {
            return containerRef.current instanceof HTMLElement ?
                containerRef.current.querySelector('video')
                :
                null;
        };

        const recover = () => {
            const videoElement = getVideoElement();
            if (videoElement === null || videoElement.readyState === 0) {
                return;
            }

            if (videoElement.paused) {
                pendingRef.current = true;
                return;
            }

            pendingRef.current = false;

            const time = videoElement.currentTime;
            if (!isFinite(time)) {
                return;
            }

            videoElement.pause();
            videoElement.currentTime = Math.max(0, time - SEEK_BACK);

            const playPromise = videoElement.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch((error) => {
                    // Autoplay can be rejected if the resume raced the user; the
                    // play button still works and the sink is re-bound anyway.
                    console.warn('AudioOutputRecovery:', error);
                });
            }
        };

        const onDeviceChange = () => {
            // A single connect/disconnect fires several events; settle first.
            clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(recover, DEVICE_CHANGE_DEBOUNCE);
        };

        const onPlay = () => {
            if (pendingRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = setTimeout(recover, 0);
            }
        };

        const mediaDevices = navigator.mediaDevices;
        if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
            mediaDevices.addEventListener('devicechange', onDeviceChange);
        }

        // The video element is created and destroyed by stremio-video as streams
        // are loaded, so listen on the container instead — media events do not
        // bubble, but they do capture.
        const containerElement = containerRef.current;
        if (containerElement instanceof HTMLElement) {
            containerElement.addEventListener('play', onPlay, true);
        }

        return () => {
            clearTimeout(timeoutRef.current);
            if (mediaDevices && typeof mediaDevices.removeEventListener === 'function') {
                mediaDevices.removeEventListener('devicechange', onDeviceChange);
            }

            if (containerElement instanceof HTMLElement) {
                containerElement.removeEventListener('play', onPlay, true);
            }
        };
    }, []);
};

module.exports = useAudioOutputRecovery;
