// Copyright (C) 2017-2023 Smart code 203358507

// Restores audio when the output device disappears and comes back — a
// Bluetooth speaker powering off mid-film, headphones unplugged.
//
// Shell playback runs through mpv, not a media element. When the device goes
// away mpv reopens its audio output, ao_init_best() fails, and player/audio.c
// takes its generic failure path ending in error_on_track (player/misc.c),
// which calls mp_deselect_track. The audio track is left DESELECTED and mpv
// never retries or notices the device return — mpv-player/mpv#8579, open since
// 2021 and still present in the libmpv the Shell ships. Browsers cope because
// Chromium re-routes its own WASAPI stream; mpv has no equivalent.
//
// Both halves of the repair were established by tracing a real drop:
//
//   * Detection is `track-list`, whose audio entry flips to selected:false a
//     few seconds after the device dies. `aid` is useless for this — it reports
//     the option, not the live selection, and never changes.
//
//   * The repair is a two-step `aid` toggle, no -> id, with BOTH values as
//     STRINGS. The option still reads as the old id so rewriting it changes
//     nothing, and stremio-shell-ng deserializes into PropVal::Bool|Str|Num
//     where a number becomes an f64 that mpv rejects on an integer choice
//     option.
//
// Retrying is deliberately rare. Each attempt makes mpv run
// reinit_audio_chain, which re-syncs the demuxer and visibly stalls a network
// stream — polling every couple of seconds made the video hitch continuously
// while the speaker was off. So the schedule is: one attempt when the track
// drops (which alone restores sound if another output is available), then wait
// for the device to actually come back, with a slow safety net in case that
// signal never arrives.
//
// Nothing here touches loading or navigation. The only thing it ever sends is
// `mpv-set-prop aid`.

const React = require('react');

// mpv needs a moment between dropping the track and taking it back.
const TOGGLE_DELAY = 300;
// track-list also empties during teardown; waiting lets the stream prop catch
// up so ordinary unloads are not mistaken for a device failure.
const GRACE = 1500;
// A device actually arriving is worth acting on at once. This only debounces
// the burst of events a single connect produces.
const DEVICE_RETRY = 250;
// Safety net for `devicechange` never arriving. Each attempt costs a visible
// buffering hitch, so this stays rare on purpose — the device event is the
// real trigger, this only stops a silent film if that event never comes.
const SAFETY_INTERVAL = 60000;
// A restored track only counts as healthy once it has held this long.
const SETTLE = 3000;

const noop = () => undefined;

const audioTracks = (list) => (Array.isArray(list) ? list.filter((t) => t && t.type === 'audio') : []);

const createAudioTrackRecovery = ({ send, isStreamLoaded, timers = global, log = noop }) => {
    let audioTrackId = null;
    let down = false;
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

        log('AudioRecovery: re-selecting audio track', audioTrackId);
        // Strings on both writes. A number is rejected by mpv here.
        send('mpv-set-prop', ['aid', 'no']);
        timers.clearTimeout(toggleTimeout);
        toggleTimeout = timers.setTimeout(() => {
            toggleTimeout = null;
            if (!stopped && down && isStreamLoaded()) {
                send('mpv-set-prop', ['aid', String(audioTrackId)]);
            }
        }, TOGGLE_DELAY);

        // Success is confirmed by track-list, not assumed. Until then, sit on
        // the slow safety net rather than hitching playback repeatedly.
        schedule(SAFETY_INTERVAL);
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
        // An audio output appeared. This is the trigger that matters — the
        // safety net exists only in case it never fires.
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
        // over the IPC allowlist. This is what makes recovery prompt without
        // polling mpv and hitching playback.
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
module.exports.TOGGLE_DELAY = TOGGLE_DELAY;
module.exports.GRACE = GRACE;
module.exports.DEVICE_RETRY = DEVICE_RETRY;
module.exports.SAFETY_INTERVAL = SAFETY_INTERVAL;
module.exports.SETTLE = SETTLE;
