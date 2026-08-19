// Copyright (C) 2017-2023 Smart code 203358507

// Restores audio when the output device disappears and comes back — a
// Bluetooth speaker powering off mid-film, headphones unplugged.
//
// Shell playback runs through mpv, not a media element. When the device goes
// away mpv reopens its audio output, ao_init_best() fails, and player/audio.c
// takes its generic failure path: uninit_audio_chain / uninit_audio_out /
// error_on_track. error_on_track (player/misc.c) calls mp_deselect_track, so
// the audio track ends up DESELECTED. mpv never retries and never notices the
// device return, which is mpv-player/mpv#8579 — open since 2021 and still
// present in the libmpv the Shell ships. Browsers cope because Chromium
// re-routes its own WASAPI stream; mpv has no equivalent.
//
// Both halves of the repair were established by tracing a real drop:
//
//   * Detection is `track-list`, whose audio entry flips to selected:false a
//     few seconds after the device dies. `aid` is NOT usable — it reports the
//     option, not the live selection, and stays put throughout.
//
//   * The repair is to write `aid` back. It must be a TWO-STEP toggle, since
//     the aid option still reads as the old id and re-writing the same value
//     changes nothing, and both values must be STRINGS: stremio-shell-ng
//     deserializes into PropVal::Bool | Str | Num, and a number becomes an f64
//     that mpv rejects on an integer choice option. That mistake is why an
//     earlier attempt dropped the track and then failed to put it back.
//
// Nothing here touches loading or navigation. The only thing it ever sends is
// `mpv-set-prop aid`.

const React = require('react');

// Re-selecting while the device is still absent fails the same way, and there
// is no signal for the device returning — audio-device-list is not on
// stremio-shell-ng's property allowlist, so we are blind to the hardware and
// have to poll. Settles to one attempt per 15s.
const RETRY_DELAYS = [2000, 3000, 3000, 4000];
// Past this many attempts (~2 minutes) the speaker is probably off for the
// evening, so stop asking so often.
const SLOW_AFTER = 30;
const SLOW_DELAY = 15000;
// mpv needs a moment between dropping the track and taking it back.
const TOGGLE_DELAY = 300;
// A device actually arriving is worth acting on straight away; this only debounces
// the burst of events a single connect produces.
const DEVICE_RETRY = 250;
// track-list also empties during teardown; waiting lets the stream prop catch
// up so ordinary unloads are not mistaken for a device failure.
const GRACE = 1500;
// A restored track only counts as healthy once it has held this long.
const SETTLE = 3000;

const noop = () => undefined;

const audioTracks = (list) => (Array.isArray(list) ? list.filter((t) => t && t.type === 'audio') : []);

const createAudioTrackRecovery = ({ send, isStreamLoaded, timers = global, log = noop }) => {
    let audioTrackId = null;
    let down = false;
    let attempt = 0;
    let stopped = false;
    let retryTimeout = null;
    let toggleTimeout = null;
    let settleTimeout = null;

    const clearTimers = () => {
        timers.clearTimeout(retryTimeout);
        timers.clearTimeout(toggleTimeout);
        timers.clearTimeout(settleTimeout);
        retryTimeout = null;
        toggleTimeout = null;
        settleTimeout = null;
    };

    const schedule = (delay) => {
        timers.clearTimeout(retryTimeout);
        retryTimeout = timers.setTimeout(reselect, delay);
    };

    function reselect() {
        retryTimeout = null;
        if (stopped || !down || audioTrackId === null || !isStreamLoaded()) {
            return;
        }

        attempt += 1;
        log('AudioRecovery: re-selecting audio track', audioTrackId, 'attempt', attempt);
        // Strings on both writes. A number is rejected by mpv here.
        send('mpv-set-prop', ['aid', 'no']);
        timers.clearTimeout(toggleTimeout);
        toggleTimeout = timers.setTimeout(() => {
            toggleTimeout = null;
            if (!stopped && down && isStreamLoaded()) {
                send('mpv-set-prop', ['aid', String(audioTrackId)]);
            }
        }, TOGGLE_DELAY);

        // Success is confirmed by track-list, not assumed. If it does not come
        // back, this carries us to the next attempt.
        schedule(attempt > SLOW_AFTER
            ? SLOW_DELAY
            : RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
    }

    const onTrackList = (list) => {
        const audio = audioTracks(list);
        if (audio.length === 0) {
            return;
        }

        const selected = audio.filter((track) => track.selected)[0];
        if (selected) {
            audioTrackId = selected.id;
            if (down) {
                down = false;
                clearTimers();
                log('AudioRecovery: audio restored');
                settleTimeout = timers.setTimeout(() => {
                    settleTimeout = null;
                    attempt = 0;
                }, SETTLE);
            }

            return;
        }

        // No audio track selected. Only a failure if mpv had one selected
        // before and we are not tearing the stream down.
        if (!stopped && !down && audioTrackId !== null && isStreamLoaded()) {
            down = true;
            log('AudioRecovery: mpv dropped the audio track, output device gone');
            schedule(GRACE);
        }
    };

    return {
        onPropChange: (name, data) => {
            if (!stopped && name === 'track-list') {
                onTrackList(data);
            }
        },
        // An audio output appeared. Only meaningful while the track is down —
        // it short-circuits the back-off instead of waiting out the next tier.
        onDeviceChange: (why) => {
            if (stopped || !down) {
                return;
            }

            log('AudioRecovery: audio device change (' + why + '), retrying now');
            schedule(DEVICE_RETRY);
        },
        isDown: () => down,
        // Never fight a file that is ending — that is how a previous attempt
        // put the player into a loop back to the streams list.
        onEnded: () => {
            stopped = true;
            down = false;
            clearTimers();
        },
        dispose: () => {
            stopped = true;
            clearTimers();
        },
    };
};

const useAudioTrackRecovery = ({ shell, stream }) => {
    const streamRef = React.useRef(stream);
    streamRef.current = stream;

    React.useEffect(() => {
        // Shell only — there is no mpv behind the browser/PWA player.
        const transport = shell && shell.active ? shell.transport : null;
        if (transport === null || typeof transport.send !== 'function' || typeof transport.on !== 'function') {
            return;
        }

        const recovery = createAudioTrackRecovery({
            send: (event, args) => transport.send(event, args),
            isStreamLoaded: () => streamRef.current !== null,
            log: console.warn,
        });

        const onMpvPropChange = (args) => {
            if (args && typeof args.name === 'string') {
                recovery.onPropChange(args.name, args.data);
            }
        };

        const onEnded = () => recovery.onEnded();

        // The Shell renders in WebView2, which is Chromium, so the media device
        // APIs are available even though mpv's own device list is not reachable
        // over the IPC. This is what gets recovery down to about a second
        // instead of waiting out the mpv-side back-off.
        const mediaDevices = navigator.mediaDevices;
        const onDeviceChange = () => recovery.onDeviceChange('devicechange');
        const hasDeviceEvents = !!mediaDevices && typeof mediaDevices.addEventListener === 'function';
        if (hasDeviceEvents) {
            mediaDevices.addEventListener('devicechange', onDeviceChange);
        }

        transport.on('mpv-prop-change', onMpvPropChange);
        transport.on('mpv-event-ended', onEnded);

        return () => {
            recovery.dispose();
            if (hasDeviceEvents) {
                mediaDevices.removeEventListener('devicechange', onDeviceChange);
            }

            if (typeof transport.off === 'function') {
                transport.off('mpv-prop-change', onMpvPropChange);
                transport.off('mpv-event-ended', onEnded);
            }
        };
    }, [shell && shell.active]);
};

module.exports = useAudioTrackRecovery;
module.exports.createAudioTrackRecovery = createAudioTrackRecovery;
module.exports.RETRY_DELAYS = RETRY_DELAYS;
module.exports.TOGGLE_DELAY = TOGGLE_DELAY;
module.exports.DEVICE_RETRY = DEVICE_RETRY;
module.exports.SLOW_AFTER = SLOW_AFTER;
module.exports.SLOW_DELAY = SLOW_DELAY;
module.exports.GRACE = GRACE;
module.exports.SETTLE = SETTLE;
