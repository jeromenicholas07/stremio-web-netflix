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
//   * The repair is a single `aid` write, as a STRING. mpv has already set
//     current_track to NULL, so mp_switch_track re-selects and rebuilds the
//     audio chain; the value must not be a number because stremio-shell-ng
//     deserializes into PropVal::Bool|Str|Num and an f64 is rejected on an
//     integer choice option.
//
//     It must NOT deselect first. `aid no` leaves mpv with neither audio nor
//     video selected, which is one of the conditions under which error_on_track
//     sets stop_play = PT_ERROR. The shell emits `mpv-event-ended` for every
//     EndFile reason, so that surfaces as the episode ending and the player
//     jumps to the next one.
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

// track-list also empties during teardown; waiting lets the stream prop catch
// up so ordinary unloads are not mistaken for a device failure.
const GRACE = 1500;
// A device actually arriving is worth acting on at once. This only debounces
// the burst of events a single connect produces.
const DEVICE_RETRY = 250;
// Cooldown after each device-triggered write, growing so a device that keeps
// announcing itself cannot stutter the stream. The first entry is 0: the first
// event after a quiet spell fires straight away, which is the whole point —
// that is the one that means "the speaker is back". Later entries cover the
// case where the endpoint is not ready the instant Windows announces it.
const DEVICE_COOLDOWNS = [0, 3000, 10000, 20000];
// No device events for this long means the next one starts a fresh burst.
const DEVICE_BURST_RESET = 30000;
// Safety net for `devicechange` never arriving. Each attempt costs a visible
// buffering hitch, so this stays rare on purpose — the device event is the
// real trigger, this only stops a silent film if that event never comes.
const SAFETY_INTERVAL = 60000;
// mpv reports the track selected as soon as mp_switch_track runs, which is
// BEFORE ao_init_best gets a chance to fail. Treating that as success reset the
// throttling and re-armed on the deselect that followed a moment later, which
// span a ~1.5s loop of demuxer re-syncs. So a re-selected track only counts as
// recovered once it has held for this long without being dropped again.
const SETTLE = 3000;
// Absolute floor between any two writes, whatever asked for them. Each write
// makes mpv re-sync the demuxer and visibly buffers the stream, so this stops
// triggers of different kinds from landing on top of each other. Device storms
// are handled by DEVICE_COOLDOWNS rather than by this.
const MIN_WRITE_INTERVAL = 2000;
// If mpv ends the file this soon after a write of ours, assume we caused it and
// never try again this session. Recovery is a convenience; skipping an episode
// is not something to risk twice.
const BLAME_WINDOW = 5000;

const noop = () => undefined;

const audioTracks = (list) => (Array.isArray(list) ? list.filter((t) => t && t.type === 'audio') : []);

// Survives Player remounts on purpose: if recovery ever ends a file, it stays
// off for the rest of the session rather than doing it again in the next episode.
let sessionDisabled = false;

const createAudioTrackRecovery = ({ send, isStreamLoaded, timers = global, log = noop, now = Date.now }) => {
    let audioTrackId = null;
    let lastWriteAt = 0;
    let lastDeviceWriteAt = 0;
    let deviceAttempt = 0;
    let pendingIsDevice = false;
    let down = false;
    let stopped = false;
    let retryTimeout = null;
    let settleTimeout = null;

    const clearTimers = () => {
        timers.clearTimeout(retryTimeout);
        timers.clearTimeout(settleTimeout);
        retryTimeout = null;
        settleTimeout = null;
    };

    // Never lets a trigger produce a write sooner than MIN_WRITE_INTERVAL after
    // the last one — it defers the attempt rather than dropping it, so a device
    // arriving during the quiet window is still acted on, just not instantly.
    const schedule = (delay, fromDevice) => {
        const sinceWrite = lastWriteAt === 0 ? Infinity : now() - lastWriteAt;
        const floor = sinceWrite >= MIN_WRITE_INTERVAL ? 0 : MIN_WRITE_INTERVAL - sinceWrite;
        pendingIsDevice = !!fromDevice;
        timers.clearTimeout(retryTimeout);
        retryTimeout = timers.setTimeout(reselect, Math.max(delay, floor));
    };

    function reselect() {
        retryTimeout = null;
        if (stopped || sessionDisabled || !down || audioTrackId === null || !isStreamLoaded()) {
            return;
        }

        log('AudioRecovery: re-selecting audio track', audioTrackId);
        // One write, and a string. Never `no` first — see the header.
        lastWriteAt = now();
        if (pendingIsDevice) {
            lastDeviceWriteAt = lastWriteAt;
            deviceAttempt += 1;
        }

        pendingIsDevice = false;
        send('mpv-set-prop', ['aid', String(audioTrackId)]);

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
            // Do not declare victory here — wait and see whether it holds.
            if (down && settleTimeout === null) {
                settleTimeout = timers.setTimeout(() => {
                    settleTimeout = null;
                    down = false;
                    deviceAttempt = 0;
                    lastDeviceWriteAt = 0;
                    timers.clearTimeout(retryTimeout);
                    retryTimeout = null;
                    log('AudioRecovery: audio restored');
                }, SETTLE);
            }

            return;
        }

        // Track is not selected. If we were mid-confirmation, the attempt just
        // failed — cancel it, but leave `down` and the cooldown ladder alone so
        // the next try waits its turn instead of restarting the cycle.
        timers.clearTimeout(settleTimeout);
        settleTimeout = null;

        // Only a failure if mpv had one selected before and we are not tearing
        // the stream down. Already being down means an attempt is pending; do
        // not re-arm on top of it.
        if (!stopped && !sessionDisabled && !down && audioTrackId !== null && isStreamLoaded()) {
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
            if (stopped || sessionDisabled || !down) {
                return;
            }

            const at = now();
            // A lull means whatever was churning has settled; treat what comes
            // next as a fresh arrival rather than more of the same burst.
            if (lastDeviceWriteAt !== 0 && at - lastDeviceWriteAt > DEVICE_BURST_RESET) {
                deviceAttempt = 0;
                lastDeviceWriteAt = 0;
            }

            const cooldown = DEVICE_COOLDOWNS[Math.min(deviceAttempt, DEVICE_COOLDOWNS.length - 1)];
            const since = lastDeviceWriteAt === 0 ? Infinity : at - lastDeviceWriteAt;
            const delay = since >= cooldown ? DEVICE_RETRY : cooldown - since;
            log('AudioRecovery: audio device change (' + why + '), retrying in', delay + 'ms');
            schedule(delay, true);
        },
        isDown: () => down,
        // Never fight a file that is ending — that is how a previous attempt
        // put the player into a loop back to the streams list.
        onEnded: () => {
            // The shell reports every EndFile reason through this, and the
            // player turns it into "go to the next episode". If it lands right
            // after a write of ours, we caused it — stand down for good.
            if (lastWriteAt !== 0 && now() - lastWriteAt < BLAME_WINDOW) {
                sessionDisabled = true;
                log('AudioRecovery: mpv ended the file right after a write — disabling recovery for this session');
            }

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
module.exports.GRACE = GRACE;
module.exports.DEVICE_RETRY = DEVICE_RETRY;
module.exports.SAFETY_INTERVAL = SAFETY_INTERVAL;
module.exports.SETTLE = SETTLE;
module.exports.BLAME_WINDOW = BLAME_WINDOW;
module.exports.MIN_WRITE_INTERVAL = MIN_WRITE_INTERVAL;
module.exports.DEVICE_COOLDOWNS = DEVICE_COOLDOWNS;
module.exports.DEVICE_BURST_RESET = DEVICE_BURST_RESET;
// Test seam: the session kill switch is module state by design.
module.exports.__resetSessionDisabled = () => { sessionDisabled = false; };
