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

// Deterministic clock so the toggle's delayed second write can be stepped.
function createClock() {
    let nextId = 1;
    const pending = new Map();
    return {
        timers: {
            setTimeout: (fn) => { const id = nextId++; pending.set(id, fn); return id; },
            clearTimeout: (id) => pending.delete(id),
        },
        runAll() {
            for (const [id, fn] of Array.from(pending)) { pending.delete(id); fn(); }
        },
    };
}

describe('audio probe', () => {
    // The probe itself must not be able to disturb playback. Only the
    // hand-invoked fix() writes, and only when explicitly called.
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

    // At Player mount there is no mpv instance yet, so the first observe is
    // dropped — that is why the first trace reported nothing for these.
    it('can re-issue the observes once a stream is loaded', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });
        t.sent.length = 0;
        probe.observeAgain();
        expect(t.sent.map(([event]) => event).every((e) => e === 'mpv-observe-prop')).toBe(true);
        expect(t.sent.map(([, name]) => name)).toEqual(OBSERVE);
    });

    it('collapses repeated identical values', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });

        t.emit('mpv-prop-change', { name: 'aid', data: 1 });
        t.emit('mpv-prop-change', { name: 'aid', data: 1 });
        t.emit('mpv-prop-change', { name: 'aid', data: 1 });
        expect(probe.entries.filter((e) => e.name === 'aid').length).toBe(1);

        t.emit('mpv-prop-change', { name: 'aid', data: false });
        expect(probe.entries.filter((e) => e.name === 'aid').length).toBe(2);
    });

    it('reduces track-list to what is selected', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });
        const bulky = [
            { id: 1, type: 'video', selected: true, codec: 'hevc', metadata: { BPS: '1200756' }, 'demux-w': 1912 },
            { id: 2, type: 'audio', selected: true, codec: 'eac3', lang: 'eng', metadata: { BPS: '224000' } },
        ];

        t.emit('mpv-prop-change', { name: 'track-list', data: bulky });
        const entry = probe.entries.find((e) => e.name === 'track-list');
        expect(entry.value).toContain('"type":"audio"');
        expect(entry.value).toContain('"selected":true');
        expect(entry.value).not.toContain('BPS');
        expect(entry.value).not.toContain('truncated');
    });

    describe('manual fix', () => {
        // A plain `aid = 1` is a no-op: mpv keeps reporting aid as 1 while the
        // track is deselected. The drop to `no` is the whole point.
        it('toggles aid off and back to the track that was playing', () => {
            const t = createTransport();
            const clock = createClock();
            const probe = createAudioProbe({ transport: t.transport, timers: clock.timers });

            t.emit('mpv-prop-change', { name: 'track-list', data: [
                { id: 1, type: 'video', selected: true },
                { id: 2, type: 'audio', selected: true, codec: 'aac' },
            ] });
            // Device dies: mpv deselects the audio track but leaves aid alone.
            t.emit('mpv-prop-change', { name: 'track-list', data: [
                { id: 1, type: 'video', selected: true },
                { id: 2, type: 'audio', selected: false, codec: 'aac' },
            ] });

            t.sent.length = 0;
            probe.fix();
            expect(t.sent).toEqual([['mpv-set-prop', ['aid', 'no']]]);
            clock.runAll();
            expect(t.sent).toEqual([
                ['mpv-set-prop', ['aid', 'no']],
                ['mpv-set-prop', ['aid', 2]],
            ]);
        });

        it('does nothing at all until it is called', () => {
            const t = createTransport();
            const clock = createClock();
            createAudioProbe({ transport: t.transport, timers: clock.timers });

            t.emit('mpv-prop-change', { name: 'track-list', data: [{ id: 2, type: 'audio', selected: false }] });
            t.emit('mpv-prop-change', { name: 'aid', data: 1 });
            t.emit('mpv-event-ended', { reason: 'error' });
            clock.runAll();

            expect(t.sent.every(([event]) => event === 'mpv-observe-prop')).toBe(true);
        });

        it('accepts an explicit track id', () => {
            const t = createTransport();
            const clock = createClock();
            const probe = createAudioProbe({ transport: t.transport, timers: clock.timers });

            t.sent.length = 0;
            probe.fix(3);
            clock.runAll();
            expect(t.sent).toEqual([
                ['mpv-set-prop', ['aid', 'no']],
                ['mpv-set-prop', ['aid', 3]],
            ]);
        });

        it('refuses rather than guessing when no track has been seen', () => {
            const t = createTransport();
            const clock = createClock();
            const probe = createAudioProbe({ transport: t.transport, timers: clock.timers });

            t.sent.length = 0;
            const result = probe.fix();
            clock.runAll();
            expect(t.sent).toEqual([]);
            expect(result).toContain('__audioFix(1)');
        });
    });

    it('records user markers so the trace can be correlated', () => {
        const t = createTransport();
        const probe = createAudioProbe({ transport: t.transport });
        probe.mark('speaker off');
        const entry = probe.entries.find((e) => e.kind === 'mark');
        expect(entry.value).toBe('speaker off');
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
