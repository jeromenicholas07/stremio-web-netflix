// Copyright (C) 2017-2023 Smart code 203358507

// When an audio output disappears mid-stream (a Bluetooth speaker powering off,
// headphones unplugged), the player keeps its audio output bound to the device
// that is now gone. Turning the speaker back on does not re-bind it, so playback
// carries on with picture but no sound.
//
// The repair is to rebuild the stream at the position it is already at — the
// same thing you get by backing out and replaying, minus losing your place.
// In-place repair is not an option on the Shell, where playback runs through
// mpv: mpv does not bring its audio output back when a device reappears, and
// re-selecting the track or re-setting `audio-device` at runtime does not help
// (https://github.com/mpv-player/mpv/issues/11192).
//
// The repair is exposed as a function so it can be triggered by hand, because
// the automatic triggers are the unreliable part. Chromium's `devicechange` is
// not implemented on every WebView the Shell ships with, and mpv only reports
// `audio-device-list` changes when its audio output driver supports hotplug.
// Neither can be relied on, so neither is the only way to get the fix.

const React = require('react');

// One connect/disconnect emits a burst of events, and powering a speaker off
// and on again should cost one reload, not two.
const DEVICE_CHANGE_DEBOUNCE = 1500;
// A reload costs a re-buffer, so cap how often device noise can trigger one.
const MIN_RELOAD_INTERVAL = 15 * 1000;

const useAudioOutputRecovery = ({ shell, stream, paused, time, reload }) => {
    const timeoutRef = React.useRef(null);
    const pendingRef = React.useRef(false);
    const lastReloadRef = React.useRef(0);
    const pausedRef = React.useRef(paused);
    const timeRef = React.useRef(time);
    const reloadRef = React.useRef(reload);

    pausedRef.current = paused;
    timeRef.current = time;
    reloadRef.current = reload;

    // Asked for explicitly, so it skips the pause deferral and the rate limit —
    // if someone reaches for this, the audio is already broken.
    const recoverNow = React.useCallback(() => {
        if (stream === null) {
            return false;
        }

        pendingRef.current = false;
        lastReloadRef.current = Date.now();
        console.warn('AudioOutputRecovery: manual reload at', timeRef.current);
        reloadRef.current(timeRef.current);
        return true;
    }, [stream]);

    const recover = React.useCallback(() => {
        if (stream === null) {
            return;
        }

        // Rebuilding a paused stream would yank it back into playing, so hold
        // the repair until playback is resumed.
        if (pausedRef.current !== false) {
            pendingRef.current = true;
            return;
        }

        const now = Date.now();
        if (now - lastReloadRef.current < MIN_RELOAD_INTERVAL) {
            console.warn('AudioOutputRecovery: skipping reload, one just happened');
            pendingRef.current = false;
            return;
        }

        pendingRef.current = false;
        lastReloadRef.current = now;
        console.warn('AudioOutputRecovery: reloading stream at', timeRef.current);
        reloadRef.current(timeRef.current);
    }, [stream]);

    // Deferred repair: fires when playback is resumed after a device change
    // that arrived while paused.
    React.useEffect(() => {
        if (paused === false && pendingRef.current) {
            pendingRef.current = false;
            recover();
        }
    }, [paused, recover]);

    React.useEffect(() => {
        // `active` flips as soon as the transport is constructed, but on the Qt
        // WebChannel build `send` is only wired up once the handshake response
        // arrives — so it can genuinely be missing here.
        const shellTransport = shell && shell.active ? shell.transport : null;
        const transport = shellTransport !== null && typeof shellTransport.send === 'function' &&
            typeof shellTransport.on === 'function' ?
            shellTransport
            :
            null;

        if (shellTransport !== null && transport === null) {
            console.warn('AudioOutputRecovery: shell transport not ready, mpv device events unavailable');
        }

        const schedule = () => {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(recover, DEVICE_CHANGE_DEBOUNCE);
        };

        const onDeviceChange = () => {
            console.warn('AudioOutputRecovery: devicechange');
            schedule();
        };

        const onMpvPropChange = (args) => {
            if (args && args.name === 'audio-device-list') {
                // Logged in full: if the automatic path ever misbehaves, this
                // says whether mpv saw the device leave and come back at all.
                console.warn('AudioOutputRecovery: mpv audio-device-list', JSON.stringify(args.data));
                schedule();
            }
        };

        const mediaDevices = navigator.mediaDevices;
        if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
            mediaDevices.addEventListener('devicechange', onDeviceChange);
        }

        if (transport !== null) {
            transport.on('mpv-prop-change', onMpvPropChange);
            // Observing is also what makes mpv start monitoring for hotplug at
            // all, and it has to be re-issued per stream because ShellVideo
            // re-issues its own observes each time it loads.
            transport.send('mpv-observe-prop', 'audio-device-list');
        }

        return () => {
            clearTimeout(timeoutRef.current);

            if (mediaDevices && typeof mediaDevices.removeEventListener === 'function') {
                mediaDevices.removeEventListener('devicechange', onDeviceChange);
            }

            if (transport !== null && typeof transport.off === 'function') {
                transport.off('mpv-prop-change', onMpvPropChange);
            }
        };
    }, [shell && shell.active, stream, recover]);

    return recoverNow;
};

module.exports = useAudioOutputRecovery;
