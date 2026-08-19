// Copyright (C) 2017-2026 Smart code 203358507

const {
    createAudioTrackRecovery,
    TOGGLE_DELAY,
    GRACE,
    DEVICE_RETRY,
    SAFETY_INTERVAL,
    SETTLE,
} = require('../src/routes/Player/useAudioTrackRecovery');

// Deterministic clock so the toggle and the schedule can be stepped exactly.
function createClock() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        timers: {
            setTimeout: (fn, delay) => {
                const id = nextId++;
                pending.set(id, { fn, at: now + (delay || 0) });
                return id;
            },
            clearTimeout: (id) => pending.delete(id),
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let due = null;
                for (const [id, timer] of pending) {
                    if (timer.at <= target && (due === null || timer.at < due[1].at)) due = [id, timer];
                }

                if (due === null) break;
                pending.delete(due[0]);
                now = due[1].at;
                due[1].fn();
            }

            now = target;
        },
        get pendingCount() {
            return pending.size;
        },
    };
}

const tracks = (audioSelected) => [
    { id: 1, type: 'video', selected: true, codec: 'hevc' },
    { id: 1, type: 'audio', selected: audioSelected, codec: 'aac', lang: 'eng' },
];

function setup({ streamLoaded = true } = {}) {
    const clock = createClock();
    const sent = [];
    const state = { streamLoaded };
    const recovery = createAudioTrackRecovery({
        send: (event, args) => sent.push([event, args]),
        isStreamLoaded: () => state.streamLoaded,
        timers: clock.timers,
    });
    const aidWrites = () => sent
        .filter(([event, args]) => event === 'mpv-set-prop' && args[0] === 'aid')
        .map(([, args]) => args[1]);

    // Healthy playback: mpv reports the audio track selected.
    recovery.onPropChange('track-list', tracks(true));
    return { clock, recovery, sent, aidWrites, state };
}

describe('audio track recovery', () => {
    it('toggles aid off and back as strings when the track is dropped', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        expect(aidWrites()).toEqual([]);

        clock.advance(GRACE);
        expect(aidWrites()).toEqual(['no']);

        clock.advance(TOGGLE_DELAY);
        // Strings, not numbers: mpv rejects an f64 on an integer choice option,
        // which is what left an earlier attempt with the track dropped.
        expect(aidWrites()).toEqual(['no', '1']);
        expect(aidWrites().every((value) => typeof value === 'string')).toBe(true);
    });

    // Each attempt makes mpv re-sync the demuxer, which visibly buffers a
    // network stream. Retrying on a short timer made the video hitch nonstop
    // while the speaker was off, so waiting is the whole point.
    it('does not keep hitting mpv while the device stays away', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites().length).toBe(2);

        // Nearly a full minute of the device being gone: still just one attempt.
        clock.advance(SAFETY_INTERVAL - 5000);
        expect(aidWrites().length).toBe(2);
    });

    it('falls back to a slow safety attempt if no device event ever arrives', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites().length).toBe(2);

        clock.advance(SAFETY_INTERVAL);
        expect(aidWrites().length).toBe(4);
        expect(aidWrites().slice(-2)).toEqual(['no', '1']);
    });

    it('stops once mpv reports the track selected again', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites()).toEqual(['no', '1']);

        recovery.onPropChange('track-list', tracks(true));
        clock.advance(10 * SAFETY_INTERVAL);
        expect(aidWrites()).toEqual(['no', '1']);
    });

    it('does nothing while the stream is being torn down', () => {
        const { clock, recovery, aidWrites, state } = setup();

        state.streamLoaded = false;
        recovery.onPropChange('track-list', tracks(false));
        clock.advance(10 * SAFETY_INTERVAL);
        expect(aidWrites()).toEqual([]);
    });

    it('ignores a drop before any track was ever selected', () => {
        const clock = createClock();
        const sent = [];
        const recovery = createAudioTrackRecovery({
            send: (event, args) => sent.push([event, args]),
            isStreamLoaded: () => true,
            timers: clock.timers,
        });

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(10 * SAFETY_INTERVAL);
        expect(sent).toEqual([]);
    });

    it('restores the track the user chose, not the original', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', [
            { id: 1, type: 'video', selected: true },
            { id: 1, type: 'audio', selected: false },
            { id: 2, type: 'audio', selected: true },
        ]);
        recovery.onPropChange('track-list', [
            { id: 1, type: 'video', selected: true },
            { id: 1, type: 'audio', selected: false },
            { id: 2, type: 'audio', selected: false },
        ]);
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites()).toEqual(['no', '2']);
    });

    // The failure mode that previously looped the player back to the streams list.
    it('stops permanently once mpv ends the file', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        recovery.onEnded();
        clock.advance(10 * SAFETY_INTERVAL);
        expect(aidWrites()).toEqual([]);
        expect(clock.pendingCount).toBe(0);
    });

    it('never sends anything but aid writes', () => {
        const { clock, recovery, sent } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(5 * SAFETY_INTERVAL);
        expect(sent.every(([event, args]) => event === 'mpv-set-prop' && args[0] === 'aid')).toBe(true);
    });

    it('goes quiet after dispose', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        recovery.dispose();
        clock.advance(10 * SAFETY_INTERVAL);
        expect(aidWrites()).toEqual([]);
        expect(clock.pendingCount).toBe(0);
    });

    describe('device arrival', () => {
        it('recovers promptly instead of waiting for the safety attempt', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(2);

            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(4);
            expect(aidWrites().slice(-2)).toEqual(['no', '1']);
        });

        it('is ignored while audio is healthy', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onDeviceChange('devicechange');
            clock.advance(10 * SAFETY_INTERVAL);
            expect(aidWrites()).toEqual([]);
        });

        it('is ignored once mpv has ended the file', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            recovery.onEnded();
            recovery.onDeviceChange('devicechange');
            clock.advance(10 * SAFETY_INTERVAL);
            expect(aidWrites()).toEqual([]);
        });

        it('reports down only while the track is dropped', () => {
            const { clock, recovery } = setup();

            expect(recovery.isDown()).toBe(false);
            recovery.onPropChange('track-list', tracks(false));
            expect(recovery.isDown()).toBe(true);
            clock.advance(GRACE + TOGGLE_DELAY);
            recovery.onPropChange('track-list', tracks(true));
            expect(recovery.isDown()).toBe(false);
        });

        it('collapses a burst of events into one attempt', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE + TOGGLE_DELAY);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(before + 2);
        });

        it('handles a second outage from a clean slate', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE + TOGGLE_DELAY);
            recovery.onPropChange('track-list', tracks(true));
            clock.advance(SETTLE + 100);

            const before = aidWrites().length;
            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(before + 2);
        });
    });
});
