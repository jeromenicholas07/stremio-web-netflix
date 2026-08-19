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
    DEVICE_COOLDOWNS,
    DEVICE_BURST_RESET,
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

    // Healthy playback: mpv reports the audio track selected, and it holds —
    // recovery only arms for audio that actually worked.
    recovery.onPropChange('track-list', tracks(true));
    clock.advance(SETTLE);
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
        clock.advance(SETTLE);
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

    // Starting a stream with no output device at all: mpv fails audio init
    // during load and drops the track almost immediately. There is nothing to
    // restore, and writing into that window risks aborting the load — which the
    // player reads as the episode ending and skips to the next one.
    describe('stream that never had working audio', () => {
        it('stays completely inert', () => {
            const clock = createClock();
            const sent = [];
            const recovery = createAudioTrackRecovery({
                send: (event, args) => sent.push([event, args]),
                isStreamLoaded: () => true,
                timers: clock.timers,
                now: clock.now,
            });

            // Load selects the track, then audio init fails before it settles.
            recovery.onPropChange('track-list', tracks(true));
            clock.advance(500);
            recovery.onPropChange('track-list', tracks(false));

            clock.advance(10 * SAFETY_INTERVAL);
            recovery.onDeviceChange('devicechange');
            clock.advance(10 * SAFETY_INTERVAL);

            expect(sent).toEqual([]);
            expect(recovery.isArmed()).toBe(false);
        });

        it('arms once audio has held, and then recovers normally', () => {
            const clock = createClock();
            const sent = [];
            const recovery = createAudioTrackRecovery({
                send: (event, args) => sent.push([event, args]),
                isStreamLoaded: () => true,
                timers: clock.timers,
                now: clock.now,
            });

            recovery.onPropChange('track-list', tracks(true));
            clock.advance(SETTLE);
            expect(recovery.isArmed()).toBe(true);

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(sent.length).toBe(1);
        });
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

    // mpv reports the track selected as soon as mp_switch_track runs, before
    // ao_init_best can fail. Believing that transient reset the throttling and
    // re-armed on the deselect that followed, spinning a ~1.5s loop of demuxer
    // re-syncs — the stutter this whole schedule exists to avoid.
    describe('failed attempt that briefly looks like success', () => {
        it('does not treat a selection that immediately drops as recovery', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            expect(aidWrites().length).toBe(1);

            // mpv selects the track, then fails to open the device and drops it.
            recovery.onPropChange('track-list', tracks(true));
            clock.advance(200);
            recovery.onPropChange('track-list', tracks(false));

            expect(recovery.isDown()).toBe(true);
            // Crucially: no fresh GRACE-length re-arm, so no tight loop.
            clock.advance(GRACE * 3);
            expect(aidWrites().length).toBe(1);
        });

        it('does not restart the cycle over and over', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);

            // Ten rounds of mpv flickering the track while the device is away.
            for (let i = 0; i < 10; i++) {
                recovery.onPropChange('track-list', tracks(true));
                clock.advance(200);
                recovery.onPropChange('track-list', tracks(false));
                clock.advance(1000);
            }

            // Only the safety attempts, not one per flicker.
            expect(aidWrites().length).toBeLessThanOrEqual(2);
        });

        it('still recovers when the selection holds', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            recovery.onPropChange('track-list', tracks(true));
            clock.advance(SETTLE + 100);

            expect(recovery.isDown()).toBe(false);
            const before = aidWrites().length;
            clock.advance(10 * SAFETY_INTERVAL);
            expect(aidWrites().length).toBe(before);
        });
    });

    // A Bluetooth device that is off or reconnecting can emit devicechange
    // repeatedly. Each write buffers the stream, so a storm must not stutter it —
    // but the first event after a lull is the speaker coming back, and that one
    // has to be acted on at once.
    describe('write throttle', () => {
        it('acts on the first device event immediately', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            const before = aidWrites().length;

            // Long outage, so a safety attempt has been and gone.
            clock.advance(SAFETY_INTERVAL + 5000);
            const afterSafety = aidWrites().length;
            expect(afterSafety).toBeGreaterThan(before);

            // Speaker returns. This must not wait on the safety attempt's clock.
            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY + MIN_WRITE_INTERVAL);
            expect(aidWrites().length).toBe(afterSafety + 1);
        });

        it('recovers well under a second once the device is back', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            // A long outage, landing clear of the last safety attempt.
            clock.advance(5 * SAFETY_INTERVAL);
            clock.advance(MIN_WRITE_INTERVAL + 1000);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            clock.advance(DEVICE_RETRY);
            expect(aidWrites().length).toBe(before + 1);
            expect(DEVICE_RETRY).toBeLessThan(1000);
        });

        // The one case that is not sub-second: a device event landing on top of
        // a safety attempt. Bounded by the absolute floor, not the ladder.
        it('is capped by the absolute floor at worst, not seconds of waiting', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            clock.advance(MIN_WRITE_INTERVAL + DEVICE_RETRY);
            expect(aidWrites().length).toBe(before + 1);
            expect(MIN_WRITE_INTERVAL).toBeLessThanOrEqual(2000);
        });

        it('backs off a device that keeps announcing itself', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            const before = aidWrites().length;

            // 60 events over 20 seconds from a device stuck reconnecting.
            for (let i = 0; i < 60; i++) {
                recovery.onDeviceChange('devicechange');
                clock.advance(333);
            }

            // Bounded by the cooldown ladder, not one write per event.
            const writes = aidWrites().length - before;
            expect(writes).toBeGreaterThan(0);
            expect(writes).toBeLessThanOrEqual(DEVICE_COOLDOWNS.length);
        });

        it('treats an event after a long lull as a fresh arrival', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);

            // Burn through the ladder.
            for (let i = 0; i < 4; i++) {
                recovery.onDeviceChange('devicechange');
                clock.advance(DEVICE_COOLDOWNS[DEVICE_COOLDOWNS.length - 1] + 1000);
            }

            clock.advance(DEVICE_BURST_RESET + 1000);
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
            // Still down until the re-selection has held — mpv reports selected
            // before the audio output has actually opened.
            recovery.onPropChange('track-list', tracks(true));
            expect(recovery.isDown()).toBe(true);
            clock.advance(SETTLE);
            expect(recovery.isDown()).toBe(false);
        });

        it('collapses a burst of events into a single attempt', () => {
            const { clock, recovery, aidWrites } = setup();

            recovery.onPropChange('track-list', tracks(false));
            clock.advance(GRACE);
            const before = aidWrites().length;

            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            recovery.onDeviceChange('devicechange');
            // One write for the burst, not one per event.
            clock.advance(DEVICE_RETRY + MIN_WRITE_INTERVAL);
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
            first.clock.advance(SETTLE);
            first.clock.advance(BLAME_WINDOW + 1000);
            first.recovery.onEnded();

            const second = setup();
            second.recovery.onPropChange('track-list', tracks(false));
            second.clock.advance(GRACE);
            expect(second.aidWrites()).toEqual(['1']);
        });
    });
});
