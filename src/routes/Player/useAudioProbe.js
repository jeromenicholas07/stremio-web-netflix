// Copyright (C) 2017-2023 Smart code 203358507

// Diagnostic only. Records what mpv reports around an audio output dying and
// coming back, so the actual behaviour can be read off a real Bluetooth drop
// instead of inferred from mpv's source.
//
// It subscribes and nothing else. The only thing it ever sends is
// `mpv-observe-prop`, which asks mpv to report a property it is not already
// reporting — it sets no property, issues no command, and cannot alter
// playback. That is enforced by a test, because a previous attempt at fixing
// this bug did affect playback and sent the player back to the streams list.
//
// Read it in DevTools by filtering the console for "AudioProbe", or run
// window.__audioProbeDump() for a single block to copy out.

const React = require('react');

// Asked for because ShellVideo does not already observe them: whether mpv sees
// the device leave and return at all, and whether its audio output is alive.
const OBSERVE = ['audio-device-list', 'current-ao'];

// Everything else mpv reports is either noise (time-pos fires constantly) or
// irrelevant here, and drowns out the part that matters.
const WATCH = [
    'aid',
    'vid',
    'sid',
    'track-list',
    'audio-device-list',
    'current-ao',
    'pause',
    'eof-reached',
    'path',
    'paused-for-cache',
    'cache-buffering-state',
];

const MAX_VALUE_CHARS = 600;

const noop = () => undefined;

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

    const record = (kind, name, data) => {
        const at = ((now() - started) / 1000).toFixed(1) + 's';
        entries.push({ at, kind, name, value: describe(data) });
        log('[AudioProbe]', at, kind, name, describe(data));
    };

    const onMpvPropChange = (args) => {
        if (args && typeof args.name === 'string' && WATCH.indexOf(args.name) !== -1) {
            record('prop', args.name, args.data);
        }
    };

    // mpv ending the file is what previously bounced the player to the streams
    // list, so it matters whether an audio failure produces one.
    const onEnded = (args) => record('event', 'mpv-event-ended', args);

    transport.on('mpv-prop-change', onMpvPropChange);
    transport.on('mpv-event-ended', onEnded);
    OBSERVE.forEach((name) => transport.send('mpv-observe-prop', name));
    record('probe', 'started', { observing: OBSERVE });

    return {
        entries,
        dump: () => entries.map((e) => e.at + '  ' + e.kind + '  ' + e.name + '  ' + e.value).join('\n'),
        dispose: () => {
            if (typeof transport.off === 'function') {
                transport.off('mpv-prop-change', onMpvPropChange);
                transport.off('mpv-event-ended', onEnded);
            }
        },
    };
};

const useAudioProbe = ({ shell }) => {
    React.useEffect(() => {
        const transport = shell && shell.active ? shell.transport : null;
        if (transport === null || typeof transport.send !== 'function' || typeof transport.on !== 'function') {
            return;
        }

        const probe = createAudioProbe({ transport, log: console.warn });
        window.__audioProbeDump = probe.dump;

        return () => {
            probe.dispose();
            if (window.__audioProbeDump === probe.dump) {
                delete window.__audioProbeDump;
            }
        };
    }, [shell && shell.active]);
};

module.exports = useAudioProbe;
module.exports.createAudioProbe = createAudioProbe;
module.exports.OBSERVE = OBSERVE;
module.exports.WATCH = WATCH;
