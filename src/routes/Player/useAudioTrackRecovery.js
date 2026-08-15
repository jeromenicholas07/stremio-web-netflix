// Copyright (C) 2017-2023 Smart code 203358507

// Recovers audio in place when the output device disappears and comes back —
// a Bluetooth speaker powering off mid-film, headphones unplugged.
//
// What mpv actually does (Shell playback runs through mpv, not a media element):
//
//   1. The device vanishes, ao_wasapi errors and calls ao_request_reload().
//   2. mpv reopens the audio output, ao_init_best() fails because the device is
//      gone, and player/audio.c takes its generic failure path:
//          uninit_audio_chain(); uninit_audio_out(); error_on_track(track);
//   3. error_on_track() (player/misc.c) just calls mp_deselect_track() — the
//      audio track is DESELECTED, not blacklisted.
//   4. The device comes back and nothing re-selects the track, so mpv stays
//      silent for the rest of the file.
//
// Step 3 is the opening. Writing `aid` runs mp_switch_track(), which calls
// reinit_audio_chain() and re-attempts opening the output — so putting the
// track back is all it takes, with no reload and no interruption to playback.
// It also has to be retried: re-selecting while the speaker is still off just
// fails the same way and deselects again (harmless, but one shot is not enough).
//
// Step 3 doubles as the detection. ShellVideo already observes `aid`, so mpv
// announces the failure itself by reporting `aid` as false when nobody asked
// for that. No devicechange listener, no hotplug monitoring, no guessing about
// whether the WebView reports audio devices at all.
//
// Note this is also why swapping the audio driver does not help: the failure
// path in step 2 is generic to every ao, not something wasapi does.

const React = require('react');

// Back-off between re-selection attempts. Fast enough that audio returns within
// a few seconds of the speaker reconnecting, and it settles to one property
// write per 15s if the device is gone for good.
const RETRY_DELAYS = [2000, 3000, 5000, 8000, 15000];
// mpv reports the track selected before it reports the failure, so a recovered
// `aid` only counts as healthy once it has held for this long.
const SETTLE = 3000;
// `aid` also drops on unload/stop. Waiting before the first attempt lets the
// stream prop catch up so we can tell teardown from a real failure.
const TEARDOWN_GRACE = 1000;

// mpv reports a deselected track as false, and track ids start at 1.
const isSelected = (aid) => aid !== null && aid !== undefined && aid !== false && aid !== 'no' && aid !== 0;

const noop = () => undefined;

// The recovery state machine, kept free of React and of the clock so it can be
// driven directly by tests. `send` writes an mpv property, `isStreamLoaded`
// distinguishes a device failure from ordinary teardown.
const createAudioTrackRecovery = ({ send, isStreamLoaded, timers = global, log = noop, onAudioLost = noop }) => {
    // Last track mpv had selected, which is what we put back.
    let lastGoodAid = null;
    // Only ever true because mpv told us it dropped the track. Retrying is
    // gated on it so the loop cannot run on indefinitely against a healthy
    // stream if a write turns out to be a no-op.
    let audioDown = false;
    let attempt = 0;
    let retryTimeout = null;
    let settleTimeout = null;
    let disposed = false;

    const schedule = (delay) => {
        timers.clearTimeout(retryTimeout);
        retryTimeout = timers.setTimeout(reselect, delay);
    };

    function reselect() {
        retryTimeout = null;

        // Recovered, or teardown rather than a device failure — either way
        // there is nothing to put back, and the loop ends here.
        if (disposed || !audioDown || !isStreamLoaded() || !isSelected(lastGoodAid)) {
            return;
        }

        attempt += 1;
        log('AudioRecovery: re-selecting audio track', lastGoodAid, 'attempt', attempt);
        send('mpv-set-prop', ['aid', lastGoodAid]);

        // Keep one retry pending: if the device is still gone mpv deselects
        // again, and this is what carries us to the next attempt even if that
        // second deselect never reaches us. Indexed off the attempt we just
        // made, so the first wait is the shortest tier rather than skipping it.
        schedule(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
    }

    const onAidChanged = (aid) => {
        if (isSelected(aid)) {
            lastGoodAid = aid;
            audioDown = false;
            timers.clearTimeout(retryTimeout);
            retryTimeout = null;

            // Held long enough to count as real: stop retrying and reset the
            // back-off so a later drop starts out responsive again.
            timers.clearTimeout(settleTimeout);
            settleTimeout = timers.setTimeout(() => {
                if (attempt > 0) {
                    log('AudioRecovery: audio is back');
                }

                attempt = 0;
            }, SETTLE);
            return;
        }

        timers.clearTimeout(settleTimeout);
        settleTimeout = null;

        // mpv dropped the track without being asked. That is the failure.
        if (isStreamLoaded() && isSelected(lastGoodAid)) {
            // Once per outage, not once per retry — the retries are silent.
            if (!audioDown) {
                log('AudioRecovery: mpv deselected the audio track, output device likely gone');
                onAudioLost();
            }

            audioDown = true;
            if (retryTimeout === null) {
                schedule(TEARDOWN_GRACE);
            }
        }
    };

    return {
        onPropChange: (name, data) => {
            if (disposed) {
                return;
            }

            if (name === 'aid') {
                onAidChanged(data);
                return;
            }

            // Not load-bearing — the retry timer gets there on its own. This
            // only makes recovery near-instant when mpv's hotplug monitoring
            // does report a device arriving.
            if (name === 'audio-device-list' && audioDown && retryTimeout !== null) {
                schedule(250);
            }
        },
        dispose: () => {
            disposed = true;
            timers.clearTimeout(retryTimeout);
            timers.clearTimeout(settleTimeout);
        },
    };
};

const useAudioTrackRecovery = ({ shell, stream, onAudioLost }) => {
    const streamRef = React.useRef(stream);
    const onAudioLostRef = React.useRef(onAudioLost);
    streamRef.current = stream;
    onAudioLostRef.current = onAudioLost;

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
            onAudioLost: () => {
                if (typeof onAudioLostRef.current === 'function') {
                    onAudioLostRef.current();
                }
            },
        });

        const onMpvPropChange = (args) => {
            if (args && typeof args.name === 'string') {
                recovery.onPropChange(args.name, args.data);
            }
        };

        transport.on('mpv-prop-change', onMpvPropChange);
        // ShellVideo already observes `aid`; this is only for the fast path, and
        // observing is what makes mpv monitor for hotplug in the first place.
        transport.send('mpv-observe-prop', 'audio-device-list');

        return () => {
            recovery.dispose();
            if (typeof transport.off === 'function') {
                transport.off('mpv-prop-change', onMpvPropChange);
            }
        };
    }, [shell && shell.active]);
};

module.exports = useAudioTrackRecovery;
module.exports.createAudioTrackRecovery = createAudioTrackRecovery;
module.exports.RETRY_DELAYS = RETRY_DELAYS;
module.exports.SETTLE = SETTLE;
module.exports.TEARDOWN_GRACE = TEARDOWN_GRACE;
