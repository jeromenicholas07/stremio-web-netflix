// Copyright (C) 2017-2026 Smart code 203358507

const {
    createAudioTrackRecovery,
    RETRY_DELAYS,
    TOGGLE_DELAY,
    DEVICE_RETRY,
    SLOW_AFTER,
    SLOW_DELAY,
    GRACE,
    SETTLE,
} = require('../src/routes/Player/useAudioTrackRecovery');

// Deterministic clock so the toggle and the back-off can be stepped exactly.
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

    it('stops once mpv reports the track selected again', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites()).toEqual(['no', '1']);

        recovery.onPropChange('track-list', tracks(true));
        clock.advance(120000);
        expect(aidWrites()).toEqual(['no', '1']);
        expect(clock.pendingCount).toBe(0);
    });

    it('keeps retrying while the device is still away, backing off', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites().length).toBe(2);

        for (let i = 0; i < 4; i++) {
            clock.advance(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)]);
            clock.advance(TOGGLE_DELAY);
        }

        expect(aidWrites().length).toBe(10);
        expect(aidWrites().filter((value) => value === 'no').length).toBe(5);
    });

    it('does nothing while the stream is being torn down', () => {
        const { clock, recovery, aidWrites, state } = setup();

        state.streamLoaded = false;
        recovery.onPropChange('track-list', tracks(false));
        clock.advance(120000);
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
        clock.advance(120000);
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
        clock.advance(120000);
        expect(aidWrites()).toEqual([]);
        expect(clock.pendingCount).toBe(0);
    });

    it('never sends anything but aid writes', () => {
        const { clock, recovery, sent } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(60000);
        expect(sent.every(([event, args]) => event === 'mpv-set-prop' && args[0] === 'aid')).toBe(true);
    });

    it('resets the back-off after a healthy spell', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        for (let i = 0; i < 4; i++) {
            clock.advance(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)] + TOGGLE_DELAY);
        }

        recovery.onPropChange('track-list', tracks(true));
        clock.advance(SETTLE + 100);
        const before = aidWrites().length;

        // A later outage must start responsive again, not at the 15s cap.
        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE + TOGGLE_DELAY);
        expect(aidWrites().length).toBe(before + 2);
        clock.advance(RETRY_DELAYS[0] + TOGGLE_DELAY);
        expect(aidWrites().length).toBe(before + 4);
    });

    describe('device arrival', () => {
        it('short-circuits the back-off instead of waiting out the next tier', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(2);

            // Back-off would not fire again for seconds; the speaker arriving
            // must not have to wait for it.
            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(4);
            expect(aidWrites().slice(-2)).toEqual(['no', '1']);
        });

        it('is ignored while audio is healthy', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onDeviceChange('devicechange');
            clock.advance(60000);
            expect(aidWrites()).toEqual([]);
        });

        it('is ignored once mpv has ended the file', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            recovery.onEnded();
            recovery.onDeviceChange('devicechange');
            clock.advance(60000);
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
            recovery.onDeviceChange('enumerate');
            clock.advance(DEVICE_RETRY + TOGGLE_DELAY);
            expect(aidWrites().length).toBe(before + 2);
        });
    });

    it('backs off to the slow cadence once the device is clearly gone for good', () => {
        const { clock, recovery, aidWrites } = setup();

        // The delay armed immediately after attempt n.
        const delayAfter = (attempt) => (attempt > SLOW_AFTER
            ? SLOW_DELAY
            : RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE);          // attempt 1 writes 'no'
        clock.advance(TOGGLE_DELAY);   // ...then the id

        // Step attempt by attempt so the timer phase stays known.
        for (let attempt = 1; attempt <= SLOW_AFTER; attempt++) {
            clock.advance(delayAfter(attempt) - TOGGLE_DELAY);
            clock.advance(TOGGLE_DELAY);
        }

        // Now past the responsive window: the next wait must be the slow one.
        const before = aidWrites().length;
        clock.advance(RETRY_DELAYS[RETRY_DELAYS.length - 1]);
        expect(aidWrites().length).toBe(before);

        clock.advance(SLOW_DELAY - RETRY_DELAYS[RETRY_DELAYS.length - 1] - TOGGLE_DELAY);
        clock.advance(TOGGLE_DELAY);
        expect(aidWrites().length).toBe(before + 2);
    });

    it('goes quiet after dispose', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        recovery.dispose();
        clock.advance(120000);
        expect(aidWrites()).toEqual([]);
        expect(clock.pendingCount).toBe(0);
    });
});
