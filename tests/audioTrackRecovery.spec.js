// Copyright (C) 2017-2026 Smart code 203358507

const {
    createAudioTrackRecovery,
    RETRY_DELAYS,
    SETTLE,
    TEARDOWN_GRACE,
} = require('../src/routes/Player/useAudioTrackRecovery');

// Minimal deterministic clock so the back-off can be stepped through exactly.
function createClock() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        timers: {
            setTimeout: (fn, delay) => {
                const id = nextId++;
                pending.set(id, { fn, at: now + delay });
                return id;
            },
            clearTimeout: (id) => {
                pending.delete(id);
            },
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let due = null;
                for (const [id, timer] of pending) {
                    if (timer.at <= target && (due === null || timer.at < due[1].at)) {
                        due = [id, timer];
                    }
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

function setup({ streamLoaded = true } = {}) {
    const clock = createClock();
    const sent = [];
    const state = { streamLoaded };
    const recovery = createAudioTrackRecovery({
        send: (event, args) => sent.push([event, args]),
        isStreamLoaded: () => state.streamLoaded,
        timers: clock.timers,
    });
    // Writes of `aid` that the recovery makes.
    const aidWrites = () => sent.filter(([e, a]) => e === 'mpv-set-prop' && a[0] === 'aid').map(([, a]) => a[1]);
    return { clock, recovery, sent, aidWrites, state };
}

describe('audio track recovery', () => {
    it('re-selects the track mpv dropped, then stops once it holds', () => {
        const { clock, recovery, aidWrites } = setup();

        // Normal playback: mpv reports the selected audio track.
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);
        expect(aidWrites()).toEqual([]);

        // Speaker powers off: mpv deselects the track on its own.
        recovery.onPropChange('aid', false);
        expect(aidWrites()).toEqual([]); // waits out the teardown grace first

        clock.advance(TEARDOWN_GRACE);
        expect(aidWrites()).toEqual([1]);

        // Device is back, so the re-selection sticks.
        recovery.onPropChange('aid', 1);
        clock.advance(60000);
        expect(aidWrites()).toEqual([1]);
        expect(clock.pendingCount).toBe(0);
    });

    it('keeps retrying while the device is still gone, backing off', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', 2);
        clock.advance(SETTLE + 100);

        recovery.onPropChange('aid', false);
        clock.advance(TEARDOWN_GRACE);
        expect(aidWrites()).toEqual([2]);

        // Each attempt fails: mpv deselects again right after.
        for (let i = 0; i < 4; i++) {
            recovery.onPropChange('aid', false);
            clock.advance(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)]);
        }

        expect(aidWrites().length).toBe(5);
        expect(aidWrites().every((aid) => aid === 2)).toBe(true);

        // Speaker finally reconnects and the next attempt holds.
        recovery.onPropChange('aid', 2);
        const settled = aidWrites().length;
        clock.advance(120000);
        expect(aidWrites().length).toBe(settled);
    });

    it('does not retry when the stream is being torn down', () => {
        const { clock, recovery, aidWrites, state } = setup();
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);

        // Navigating away unloads the stream; aid drops as part of that.
        state.streamLoaded = false;
        recovery.onPropChange('aid', false);
        clock.advance(60000);
        expect(aidWrites()).toEqual([]);
    });

    it('ignores a drop it never saw a good track for', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', false);
        clock.advance(60000);
        expect(aidWrites()).toEqual([]);
    });

    it('does not fight a user who switched audio track', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);

        // User picks track 2, then the speaker dies.
        recovery.onPropChange('aid', 2);
        clock.advance(SETTLE + 100);
        recovery.onPropChange('aid', false);
        clock.advance(TEARDOWN_GRACE);

        // Restores what the user chose, not the original.
        expect(aidWrites()).toEqual([2]);
    });

    it('recovers immediately when mpv reports a device arriving', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);

        recovery.onPropChange('aid', false);
        clock.advance(TEARDOWN_GRACE);
        expect(aidWrites().length).toBe(1);

        recovery.onPropChange('aid', false);
        // Hotplug fires well before the next back-off would have.
        recovery.onPropChange('audio-device-list', [{ name: 'wasapi/speaker' }]);
        clock.advance(300);
        expect(aidWrites().length).toBe(2);
    });

    it('stops everything once disposed', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);
        recovery.onPropChange('aid', false);

        recovery.dispose();
        clock.advance(120000);
        expect(aidWrites()).toEqual([]);
        expect(clock.pendingCount).toBe(0);
    });

    it('resets the back-off after a healthy spell', () => {
        const { clock, recovery, aidWrites } = setup();
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);

        // First outage burns through several attempts.
        recovery.onPropChange('aid', false);
        clock.advance(TEARDOWN_GRACE);
        for (let i = 0; i < 4; i++) {
            recovery.onPropChange('aid', false);
            clock.advance(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)]);
        }

        // Audio returns and holds.
        recovery.onPropChange('aid', 1);
        clock.advance(SETTLE + 100);
        const before = aidWrites().length;

        // A later outage must start responsive again, not at the 15s cap.
        recovery.onPropChange('aid', false);
        clock.advance(TEARDOWN_GRACE);
        expect(aidWrites().length).toBe(before + 1);
        recovery.onPropChange('aid', false);
        clock.advance(RETRY_DELAYS[0]);
        expect(aidWrites().length).toBe(before + 2);
    });
});
