// Copyright (C) 2017-2026 Smart code 203358507

const { createAudioProbe, OBSERVE } = require('../src/routes/Player/useAudioProbe');

function createTransport() {
    const sent = [];
    const listeners = new Map();
    return {
        sent,
        emit(event, args) {
            (listeners.get(event) || []).forEach((fn) => fn(args));
        },
        transport: {
            send: (event, args) => sent.push([event, args]),
            on: (event, fn) => {
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event).push(fn);
            },
            off: (event, fn) => {
                const fns = listeners.get(event) || [];
                const i = fns.indexOf(fn);
                if (i !== -1) fns.splice(i, 1);
            },
        },
        get listenerCount() {
            let n = 0;
            for (const fns of listeners.values()) n += fns.length;
            return n;
        },
    };
}

describe('audio probe', () => {
    // The whole point of this build: it must not be able to disturb playback.
    it('never sends anything except observe requests', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });

        t.emit('mpv-prop-change', { name: 'aid', data: false });
        t.emit('mpv-prop-change', { name: 'aid', data: 1 });
        t.emit('mpv-prop-change', { name: 'audio-device-list', data: [{ name: 'wasapi/x' }] });
        t.emit('mpv-event-ended', { reason: 'error' });
        t.emit('mpv-prop-change', { name: 'time-pos', data: 12.5 });

        const events = t.sent.map(([event]) => event);
        expect(events.every((e) => e === 'mpv-observe-prop')).toBe(true);
        expect(events).not.toContain('mpv-set-prop');
        expect(events).not.toContain('mpv-command');
        probe.dispose();
    });

    it('observes exactly the properties ShellVideo does not already report', () => {
        const t = createTransport();
        createAudioProbe({ transport: t.transport });
        expect(t.sent.map(([, name]) => name)).toEqual(OBSERVE);
    });

    it('records the props that matter and ignores the noisy ones', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });

        t.emit('mpv-prop-change', { name: 'time-pos', data: 1 });
        t.emit('mpv-prop-change', { name: 'volume', data: 50 });
        t.emit('mpv-prop-change', { name: 'aid', data: false });
        t.emit('mpv-event-ended', { reason: 'error' });

        const names = probe.entries.map((e) => e.name);
        expect(names).toContain('aid');
        expect(names).toContain('mpv-event-ended');
        expect(names).not.toContain('time-pos');
        expect(names).not.toContain('volume');
    });

    it('truncates huge values so the console stays readable', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });
        const huge = new Array(500).fill({ name: 'wasapi/some-very-long-device-id' });

        t.emit('mpv-prop-change', { name: 'audio-device-list', data: huge });
        const entry = probe.entries.find((e) => e.name === 'audio-device-list');
        expect(entry.value.length).toBeLessThan(700);
        expect(entry.value.endsWith('…(truncated)')).toBe(true);
    });

    it('detaches every listener on dispose', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });
        expect(t.listenerCount).toBeGreaterThan(0);
        probe.dispose();
        expect(t.listenerCount).toBe(0);
    });

    it('timestamps entries relative to start', () => {
        const t = createTransport();
        let clock = 1000;
        const probe = createAudioProbe({ transport: t.transport, now: () => clock });
        clock = 4500;
        t.emit('mpv-prop-change', { name: 'aid', data: false });
        expect(probe.entries.find((e) => e.name === 'aid').at).toBe('3.5s');
    });
});
