// Copyright (C) 2017-2026 Smart code 203358507

const recoveryModule = require('../src/routes/Player/useAudioTrackRecovery');
const {
    createAudioTrackRecovery,
    GRACE,
    DEVICE_RETRY,
    SAFETY_INTERVAL,
    SETTLE,
    BLAME_WINDOW,
    MIN_WRITE_INTERVAL,
} = recoveryModule;

// The session kill switch is module state by design; each test starts clean.
beforeEach(() => recoveryModule.__resetSessionDisabled());

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
        now: () => now,
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
        now: clock.now,
    });
    const aidWrites = () => sent
        .filter(([event, args]) => event === 'mpv-set-prop' && args[0] === 'aid')
        .map(([, args]) => args[1]);

    // Healthy playback: mpv reports the audio track selected.
    recovery.onPropChange('track-list', tracks(true));
    return { clock, recovery, sent, aidWrites, state };
}

describe('audio track recovery', () => {
    it('re-selects the track with a single string write', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        expect(aidWrites()).toEqual([]);

        clock.advance(GRACE);
        // One write, and never `no` first: deselecting can leave mpv with
        // neither audio nor video, which ends the file and skips the episode.
        expect(aidWrites()).toEqual(['1']);
        expect(typeof aidWrites()[0]).toBe('string');
    });

    it('never deselects the audio track', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(5 * SAFETY_INTERVAL);
        recovery.onDeviceChange('devicechange');
        clock.advance(DEVICE_RETRY);
        expect(aidWrites()).not.toContain('no');
        expect(aidWrites()).not.toContain(false);
    });

    // Each attempt makes mpv re-sync the demuxer, which visibly buffers a
    // network stream. Retrying on a short timer made the video hitch nonstop
    // while the speaker was off, so waiting is the whole point.
    it('does not keep hitting mpv while the device stays away', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE);
        expect(aidWrites().length).toBe(1);

        // Nearly a full minute of the device being gone: still just one attempt.
        clock.advance(SAFETY_INTERVAL - 5000);
        expect(aidWrites().length).toBe(1);
    });

    it('falls back to a slow safety attempt if no device event ever arrives', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE);
        expect(aidWrites().length).toBe(1);

        clock.advance(SAFETY_INTERVAL);
        expect(aidWrites().length).toBe(2);
        expect(aidWrites()[1]).toBe('1');
    });

    it('stops once mpv reports the track selected again', () => {
        const { clock, recovery, aidWrites } = setup();

        recovery.onPropChange('track-list', tracks(false));
        clock.advance(GRACE);
        expect(aidWrites()).toEqual(['1']);

        recovery.onPropChange('track-list', tracks(true));
        clock.advance(10 * SAFETY_INTERVAL);
        expect(aidWrites()).toEqual(['1']);
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
        clock.advance(GRACE);
        expect(aidWrites()).toEqual(['2']);
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

    // A Bluetooth device that is off or reconnecting can emit devicechange
    // repeatedly. Each write buffers the stream, so a storm must not stutter it.
    describe('write throttle', () => {
        it('holds a hard floor between writes however many events arrive', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(aidWrites().length).toBe(1);

            // 30 device events over 10 seconds.
            for (let i = 0; i < 30; i++) {
                recovery.onDeviceChange('devicechange');
                clock.advance(333);
            }

            expect(aidWrites().length).toBe(1);
        });

        it('still acts on a device that arrives during the quiet window', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(aidWrites().length).toBe(1);

            // Deferred, not dropped.
            recovery.onDeviceChange('devicechange');
            clock.advance(MIN_WRITE_INTERVAL);
            expect(aidWrites().length).toBe(2);
        });

        it('does not delay a device arriving after a long quiet spell', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            clock.advance(5 * MIN_WRITE_INTERVAL);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY);
            expect(aidWrites().length).toBe(before + 1);
        });
    });

    describe('device arrival', () => {
        it('recovers promptly instead of waiting for the safety attempt', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(aidWrites().length).toBe(1);

            // The speaker is off for a while, as it would be in practice, so
            // the write floor has long since elapsed when it comes back.
            clock.advance(MIN_WRITE_INTERVAL);
            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY);
            expect(aidWrites().length).toBe(2);
            expect(aidWrites()[1]).toBe('1');
            // ...and well before the safety attempt would have come round.
            expect(GRACE + MIN_WRITE_INTERVAL + DEVICE_RETRY).toBeLessThan(SAFETY_INTERVAL);
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
            clock.advance(GRACE);
            recovery.onPropChange('track-list', tracks(true));
            expect(recovery.isDown()).toBe(false);
        });

        it('collapses a burst of events into a single deferred attempt', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY);
            // Held back by the write floor rather than hitching immediately.
            expect(aidWrites().length).toBe(before);

            clock.advance(MIN_WRITE_INTERVAL);
            expect(aidWrites().length).toBe(before + 1);
        });

        it('handles a second outage once the write floor has passed', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            recovery.onPropChange('track-list', tracks(true));
            clock.advance(SETTLE + 100);
            clock.advance(MIN_WRITE_INTERVAL);

            const before = aidWrites().length;
            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(aidWrites().length).toBe(before + 1);
        });
    });

    // Skipping an episode is not something to risk twice.
    describe('session kill switch', () => {
        it('stands down for good if mpv ends the file right after a write', () => {
            const first = setup();
            first.recovery.onPropChange('track-list', tracks(false));
            first.clock.advance(GRACE);
            expect(first.aidWrites().length).toBe(1);
            first.recovery.onEnded();

            // Next episode mounts a fresh recovery — it must stay disabled.
            const second = setup();
            second.recovery.onPropChange('track-list', tracks(false));
            second.clock.advance(10 * SAFETY_INTERVAL);
            second.recovery.onDeviceChange('devicechange');
            second.clock.advance(DEVICE_RETRY);
            expect(second.aidWrites()).toEqual([]);
        });

        it('keeps working when the file ends well after our last write', () => {
            const first = setup();
            first.recovery.onPropChange('track-list', tracks(false));
            first.clock.advance(GRACE);
            first.recovery.onPropChange('track-list', tracks(true));
            first.clock.advance(BLAME_WINDOW + 1000);
            first.recovery.onEnded();

            const second = setup();
            second.recovery.onPropChange('track-list', tracks(false));
            second.clock.advance(GRACE);
            expect(second.aidWrites()).toEqual(['1']);
        });
    });
});
