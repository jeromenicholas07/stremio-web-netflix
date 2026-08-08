// Copyright (C) 2017-2023 Smart code 203358507

// When an audio output disappears mid-stream (a Bluetooth speaker powering off,
// headphones unplugged), the player keeps its audio output bound to the device
// that is now gone. Turning the speaker back on does not re-bind it, so playback
// carries on with picture but no sound.
//
// The repair is to rebuild the stream at the position it is already at — the
// same thing you get by backing out and replaying, minus losing your place.
// In-place repairs were tried first and are not dependable: on the Shell,
// playback runs through mpv, where re-selecting the track or re-setting
// `audio-device` at runtime does not bring the output back
// (https://github.com/mpv-player/mpv/issues/11192). A fresh load does.
//
// Detection is doubled up because the two backends see different things:
// Chromium fires `devicechange` on navigator.mediaDevices, and mpv reports its
// own `audio-device-list`. Either is enough on its own; in the Shell both are
// available and they do not always agree on when a device came back.

const React = require('react');

// One connect/disconnect emits a burst of events, and powering a speaker off
// and on again should cost one reload, not two.
const DEVICE_CHANGE_DEBOUNCE = 1500;
// A reload costs a re-buffer, so cap how often device noise can trigger one.
// Some systems emit `devicechange` for things that are not a device coming or
// going; without this a chatty machine could stutter through a whole film.
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
        const transport = shell && shell.active ? shell.transport : null;

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
                console.warn('AudioOutputRecovery: mpv audio-device-list changed');
                schedule();
            }
        };

        const mediaDevices = navigator.mediaDevices;
        if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
            mediaDevices.addEventListener('devicechange', onDeviceChange);
        }

        if (transport !== null) {
            transport.on('mpv-prop-change', onMpvPropChange);
            // ShellVideo issues its own observe calls each time it loads, so
            // ours is re-issued per stream for the same reason.
            transport.send('mpv-observe-prop', 'audio-device-list');
        }

        return () => {
            clearTimeout(timeoutRef.current);

            if (mediaDevices && typeof mediaDevices.removeEventListener === 'function') {
                mediaDevices.removeEventListener('devicechange', onDeviceChange);
            }

            if (transport !== null) {
                transport.off('mpv-prop-change', onMpvPropChange);
            }
        };
    }, [shell && shell.active, stream, recover]);
};

module.exports = useAudioOutputRecovery;
