// Copyright (C) 2017-2023 Smart code 203358507

// Diagnostic only. Records what mpv reports around an audio output dying and
// coming back, so the behaviour can be read off a real Bluetooth drop instead
// of inferred from mpv's source.
//
// It subscribes and nothing else. The only thing it ever sends is
// `mpv-observe-prop`, which asks mpv to report a property it is not already
// reporting — it sets no property, issues no command, and cannot alter
// playback. That is enforced by a test, because a previous attempt at fixing
// this bug did affect playback and sent the player back to the streams list.
//
// What the first trace established:
//   * `aid` never drops. mpv does NOT deselect the audio track when the device
//     goes away, so error_on_track / mp_deselect_track is not the path taken.
//   * `audio-device-list` and `current-ao` reported nothing at all, not even
//     the initial value mpv sends on observe — the observe was issued at Player
//     mount, before ShellVideo had created the mpv instance. Hence re-issuing
//     them once a stream is actually loaded.
//   * The only thing that moved at the moment of the drop was `track-list`,
//     whose interesting field (`selected`) was lost to truncation. Hence the
//     compact per-track summary below.
//
// Read it in DevTools by filtering the console for "AudioProbe", or run
// window.__audioProbeDump() for a single block to copy out.
// window.__audioProbeMark('speaker off') drops a labelled marker into the trace.

const React = require('react');

// Asked for because ShellVideo does not already observe them.
const OBSERVE = ['audio-device-list', 'current-ao', 'audio-device', 'audio-codec-name'];

// Everything else mpv reports is either per-frame noise or irrelevant here, and
// drowns out the part that matters.
const WATCH = [
    'aid',
    'vid',
    'sid',
    'track-list',
    'audio-device-list',
    'current-ao',
    'audio-device',
    'audio-codec-name',
    'pause',
    'eof-reached',
    'path',
    'paused-for-cache',
    'cache-buffering-state',
];

const MAX_VALUE_CHARS = 600;

const noop = () => undefined;

// track-list is enormous and almost entirely static. The only part that matters
// is which tracks exist and which are selected.
const summarise = (name, data) => {
    if (name !== 'track-list' || !Array.isArray(data)) {
        return data;
    }

    return data.map((track) => ({
        id: track && track.id,
        type: track && track.type,
        selected: track && track.selected,
        codec: track && track.codec,
        lang: track && track.lang,
    }));
};

const describe = (data) => {
    if (data === undefined) return 'undefined';
    try {
        const text = JSON.stringify(data);
        if (typeof text !== 'string') return String(data);
        return text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) + '…(truncated)' : text;
    } catch {
        return String(data);
    }
};

const createAudioProbe = ({ transport, now = Date.now, log = noop }) => {
    const started = now();
    const entries = [];
    // mpv re-reports plenty of properties with an unchanged value; the first
    // trace was mostly duplicates.
    const lastSeen = {};

    const push = (kind, name, text) => {
        const at = ((now() - started) / 1000).toFixed(1) + 's';
        entries.push({ at, kind, name, value: text });
        log('[AudioProbe]', at, kind, name, text);
    };

    const record = (kind, name, data) => {
        const text = describe(summarise(name, data));
        if (lastSeen[name] === text) {
            return;
        }

        lastSeen[name] = text;
        push(kind, name, text);
    };

    const onMpvPropChange = (args) => {
        if (args && typeof args.name === 'string' && WATCH.indexOf(args.name) !== -1) {
            record('prop', args.name, args.data);
        }
    };

    // mpv ending the file is what previously bounced the player to the streams
    // list, so it matters whether an audio failure produces one.
    const onEnded = (args) => push('event', 'mpv-event-ended', describe(args));

    const observe = (why) => {
        OBSERVE.forEach((name) => transport.send('mpv-observe-prop', name));
        push('probe', 'observe', why + ' → ' + OBSERVE.join(', '));
    };

    transport.on('mpv-prop-change', onMpvPropChange);
    transport.on('mpv-event-ended', onEnded);
    observe('mount');

    return {
        entries,
        // Re-issued once a stream is loaded: at mount there is no mpv instance
        // yet and the request is dropped on the floor.
        observeAgain: () => observe('stream loaded'),
        mark: (label) => push('mark', 'user', String(label)),
        dump: () => entries.map((e) => e.at + '  ' + e.kind + '  ' + e.name + '  ' + e.value).join('\n'),
        dispose: () => {
            if (typeof transport.off === 'function') {
                transport.off('mpv-prop-change', onMpvPropChange);
                transport.off('mpv-event-ended', onEnded);
            }
        },
    };
};

const useAudioProbe = ({ shell, stream }) => {
    const probeRef = React.useRef(null);

    React.useEffect(() => {
        const transport = shell && shell.active ? shell.transport : null;
        if (transport === null || typeof transport.send !== 'function' || typeof transport.on !== 'function') {
            return;
        }

        const probe = createAudioProbe({ transport, log: console.warn });
        probeRef.current = probe;
        window.__audioProbeDump = probe.dump;
        window.__audioProbeMark = probe.mark;

        return () => {
            probe.dispose();
            probeRef.current = null;
            if (window.__audioProbeDump === probe.dump) {
                delete window.__audioProbeDump;
                delete window.__audioProbeMark;
            }
        };
    }, [shell && shell.active]);

    React.useEffect(() => {
        if (stream !== null && probeRef.current !== null) {
            probeRef.current.observeAgain();
        }
    }, [stream === null]);
};

module.exports = useAudioProbe;
module.exports.createAudioProbe = createAudioProbe;
module.exports.OBSERVE = OBSERVE;
module.exports.WATCH = WATCH;
