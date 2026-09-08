// Copyright (C) 2017-2026 Smart code 203358507

const {
    consensusOffset,
    isConfident,
    findBestMatch,
    findBestChunkOffsets,
    indexCues,
    MIN_AGREEING_CHUNKS,
} = require('../src/services/subtitleSync/subtitleAligner');

// A sample as collectSamples produces them: an offset plus the audio chunk it
// came from. One 5s chunk yields several whisper segments, so provenance is
// what separates "three regions agree" from "one region agrees with itself".
function sample(offset, sourceSec) {
    return { offset, sourceSec };
}

function cue(startSec, text, durationSec = 2) {
    return {
        start: startSec * 1000,
        end: (startSec + durationSec) * 1000,
        text,
    };
}

// Distinct, non-repeating dialogue so matches are unambiguous unless a test
// deliberately plants a duplicate.
function buildCues(count, startSec, stepSec) {
    const cues = [];
    for (let i = 0; i < count; i++) {
        cues.push(cue(startSec + i * stepSec, `line number ${i} of the screenplay`));
    }
    return cues;
}

describe('consensusOffset — provenance', () => {
    it('counts one source when every sample came from the same audio chunk', () => {
        // Three whisper segments out of a single 5s window. They agree, but
        // they are not corroboration: if that window matched the wrong scene,
        // all three are wrong together.
        const result = consensusOffset([
            sample(2000, 120),
            sample(2100, 120),
            sample(2050, 120),
        ]);

        expect(result.cluster).toHaveLength(3);
        expect(result.sourceCount).toBe(1);
        expect(isConfident(result)).toBe(false);
    });

    it('counts three sources when samples came from distinct chunks', () => {
        const result = consensusOffset([
            sample(2000, 120),
            sample(2100, 900),
            sample(2050, 4200),
        ]);

        expect(result.sourceCount).toBe(MIN_AGREEING_CHUNKS);
        expect(isConfident(result)).toBe(true);
    });

    it('rejects a large cluster that is only two chunks deep', () => {
        const result = consensusOffset([
            sample(2000, 120),
            sample(2010, 120),
            sample(2020, 120),
            sample(2030, 900),
            sample(2040, 900),
        ]);

        expect(result.cluster.length).toBeGreaterThanOrEqual(3);
        expect(result.sourceCount).toBe(2);
        expect(isConfident(result)).toBe(false);
    });

    it('treats bare numbers as independent sources, for legacy callers', () => {
        const result = consensusOffset([2000, 2100, 2050]);

        expect(result.sourceCount).toBe(3);
        expect(isConfident(result)).toBe(true);
    });

    it('drops outliers that all skew the same direction', () => {
        // The failure the cluster search exists for: a median would be dragged
        // toward the wrong matches, the largest agreeing cluster is not.
        const result = consensusOffset([
            sample(1500, 10),
            sample(1550, 600),
            sample(1520, 1200),
            sample(-600000, 1800),
            sample(-598000, 2400),
        ]);

        expect(result.offset).toBeGreaterThan(1400);
        expect(result.offset).toBeLessThan(1600);
        expect(result.outliers).toHaveLength(2);
    });

    it('is empty-safe', () => {
        const result = consensusOffset([]);

        expect(result.offset).toBe(0);
        expect(result.sourceCount).toBe(0);
        expect(isConfident(result)).toBe(false);
    });
});

describe('consensusOffset — two-tier refinement', () => {
    it('tightens a cluster spread across seconds to the dense sub-cluster', () => {
        // Four samples agree closely at ~1200ms; one straggler sits 3s away,
        // inside the coarse 4s band. Medianing the whole band lands near 1250;
        // the refined sub-cluster answers ~1200.
        const result = consensusOffset([
            sample(1180, 10),
            sample(1200, 600),
            sample(1210, 1200),
            sample(1220, 1800),
            sample(4200, 2400),
        ]);

        expect(result.cluster).toHaveLength(5);
        expect(result.refinedCount).toBe(4);
        expect(result.offset).toBeGreaterThan(1150);
        expect(result.offset).toBeLessThan(1250);
    });

    it('keeps the straggler in the cluster for corroboration purposes', () => {
        // Refinement decides the number; the coarse cluster still decides
        // whether we trust it, so a near-miss chunk still counts as a source.
        const result = consensusOffset([
            sample(1180, 10),
            sample(1200, 600),
            sample(4200, 1200),
        ]);

        expect(result.sourceCount).toBe(3);
        expect(result.refinedCount).toBe(2);
    });
});

describe('findBestMatch — windowed search', () => {
    const phrase = 'the quick brown fox jumps over the lazy dog';

    it('finds a matching cue inside the window', () => {
        const cues = buildCues(200, 0, 30);
        cues.push(cue(1000, phrase));

        const match = findBestMatch(phrase, cues, { centerMs: 1000 * 1000, windowMs: 15000 });

        expect(match).not.toBeNull();
        expect(match.start).toBe(1000 * 1000);
    });

    it('refuses an identical cue that sits outside the window', () => {
        // The movie failure: the same line reappears an hour away, and an
        // unbounded search happily returns an offset no subtitle file has.
        const cues = buildCues(200, 0, 30);
        cues.push(cue(5000, phrase));

        const match = findBestMatch(phrase, cues, { centerMs: 1000 * 1000, windowMs: 15000 });

        expect(match).toBeNull();
    });

    it('picks the near instance when the same line appears twice', () => {
        const cues = buildCues(200, 0, 30);
        cues.push(cue(1000, phrase));
        cues.push(cue(5000, phrase));

        const match = findBestMatch(phrase, cues, { centerMs: 1002 * 1000, windowMs: 15000 });

        expect(match.start).toBe(1000 * 1000);
    });

    it('searches the whole file when no window is given', () => {
        const cues = buildCues(200, 0, 30);
        cues.push(cue(5000, phrase));

        const match = findBestMatch(phrase, cues);

        expect(match).not.toBeNull();
        expect(match.start).toBe(5000 * 1000);
    });

    it('still ignores whisper segments below the token floor', () => {
        const cues = [cue(10, 'yes')];

        expect(findBestMatch('yes', cues)).toBeNull();
    });
});

describe('indexCues', () => {
    it('sorts cues chronologically', () => {
        // Span merging assumes consecutive cues are adjacent in time, and the
        // windowed search binary searches on start.
        const cues = [cue(90, 'third line here'), cue(10, 'first line here'), cue(50, 'second line here')];

        indexCues(cues);

        expect(cues.map((c) => c.start)).toEqual([10000, 50000, 90000]);
    });
});

describe('findBestChunkOffsets — coverage', () => {
    // A two-hour film that is quiet throughout except one frantic scene at
    // ~20min. Pure density ranking piles every pick into that scene.
    function movieCues() {
        const cues = [];
        for (let t = 60; t < 7200; t += 20) {
            cues.push(cue(t, `ordinary dialogue at ${t}`));
        }
        for (let t = 1200; t < 1260; t += 1) {
            cues.push(cue(t, `rapid fire exchange at ${t}`, 1));
        }
        return cues.sort((a, b) => a.start - b.start);
    }

    it('spans the full runtime rather than clustering in the dense scene', () => {
        const offsets = findBestChunkOffsets(movieCues(), 5, 16);

        expect(offsets.length).toBeGreaterThan(8);
        expect(Math.min(...offsets)).toBeLessThan(600);
        expect(Math.max(...offsets)).toBeGreaterThan(6000);

        const inDenseScene = offsets.filter((o) => o >= 1200 && o < 1260);
        expect(inDenseScene.length).toBeLessThanOrEqual(1);
    });

    it('orders the first picks far apart, so an early stop still corroborates', () => {
        const offsets = findBestChunkOffsets(movieCues(), 5, 16);
        const firstBatch = offsets.slice(0, 3);

        // The first batch is what an early stop actually consumes. Each pick
        // should be its own region of the film, not a neighbour of the last.
        for (let i = 0; i < firstBatch.length; i++) {
            for (let j = i + 1; j < firstBatch.length; j++) {
                expect(Math.abs(firstBatch[i] - firstBatch[j])).toBeGreaterThan(600);
            }
        }
    });

    it('returns consecutive chunks for a short subtitle span', () => {
        const cues = [cue(0, 'a short clip'), cue(10, 'with little content')];

        const offsets = findBestChunkOffsets(cues, 5, 8);

        expect(offsets[0]).toBe(0);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

    it('is empty-safe', () => {
        expect(findBestChunkOffsets([], 5, 8)).toEqual([0]);
    });
});
