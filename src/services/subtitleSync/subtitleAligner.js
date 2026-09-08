const MIN_TOKEN_SIMILARITY = 0.55;       // dice score floor for a single match
const MIN_WHISPER_TOKENS = 3;            // skip very short whisper segments ("yes", "what?")
const MIN_LENGTH_RATIO = 0.4;            // skip wildly mismatched lengths
const MAX_SPAN_CUES = 3;                 // merge up to N consecutive cues into one match candidate
const MIN_MATCHES_FOR_CONFIDENCE = 3;    // minimum *clustered* matches to call sync confident
const CONSENSUS_BANDWIDTH_MS = 4000;     // offsets within ±2s of each other count as agreeing

// Corroboration: those clustered matches must also come from this many
// distinct audio chunks, so one mis-matched window cannot carry a sync alone.
const MIN_AGREEING_CHUNKS = 3;

// Tighter re-cluster inside the winning cluster, for a precise final number.
const REFINE_BANDWIDTH_MS = 1000;

// Search bounds. A real subtitle file is never minutes out of sync, and the
// refine pass only looks near where the first pass landed.
const MAX_PLAUSIBLE_OFFSET_MS = 240000;
const REFINE_WINDOW_MS = 15000;

function parseTimestamp(timestamp) {
    const parts = timestamp.replace(',', '.').split(':');
    const seconds = parseFloat(parts.pop());
    const minutes = parseInt(parts.pop() || '0', 10);
    const hours = parseInt(parts.pop() || '0', 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function parseSRT(text) {
    const cues = [];
    const blocks = text.trim().replace(/\r\n/g, '\n').split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.split('\n');
        const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
        if (timeLineIndex === -1) continue;

        const [startStr, endStr] = lines[timeLineIndex].split('-->').map((s) => s.trim());
        const textContent = lines.slice(timeLineIndex + 1).join(' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\{[^}]+\}/g, '')
            .trim();

        if (textContent) {
            cues.push({
                start: parseTimestamp(startStr),
                end: parseTimestamp(endStr),
                text: textContent,
            });
        }
    }

    return cues;
}

function parseWebVTT(text) {
    const cues = [];
    const content = text.replace(/\r\n/g, '\n');
    const blocks = content.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.split('\n');
        const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
        if (timeLineIndex === -1) continue;

        const [startStr, endStr] = lines[timeLineIndex].split('-->').map((s) => s.trim().split(' ')[0]);
        const textContent = lines.slice(timeLineIndex + 1).join(' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\{[^}]+\}/g, '')
            .trim();

        if (textContent) {
            cues.push({
                start: parseTimestamp(startStr),
                end: parseTimestamp(endStr),
                text: textContent,
            });
        }
    }

    return cues;
}

function parseSubtitles(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('WEBVTT')) {
        return parseWebVTT(trimmed);
    }
    return parseSRT(trimmed);
}

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0);
}

function bigrams(tokens) {
    if (tokens.length < 2) return [];
    const out = new Array(tokens.length - 1);
    for (let i = 0; i < tokens.length - 1; i++) {
        out[i] = tokens[i] + ' ' + tokens[i + 1];
    }
    return out;
}

// Dice coefficient on multisets: 2 * |A ∩ B| / (|A| + |B|).
// Faster than Levenshtein and rewards multi-word phrase agreement
// (matching three bigrams in a row is much stronger evidence than three
// random matching characters).
function diceSimilarity(a, b) {
    if (a.length === 0 || b.length === 0) return 0;

    const counts = new Map();
    for (const g of a) counts.set(g, (counts.get(g) || 0) + 1);

    let intersection = 0;
    for (const g of b) {
        const left = counts.get(g) || 0;
        if (left > 0) {
            intersection++;
            counts.set(g, left - 1);
        }
    }

    return (2 * intersection) / (a.length + b.length);
}

// Tokenize cues once per sync. Stash on the cue object so repeated calls
// during a single sync (multiple whisper chunks) don't re-tokenize.
//
// Also sorts chronologically: the span merging in findBestMatch already
// assumes consecutive cues are adjacent in time, and windowed matching needs
// sorted starts to binary search. Subtitle files are normally already in
// order, so the sort is near-free on the common path.
function indexCues(cues) {
    if (!cues || cues.length === 0) return cues;

    cues.sort(function (a, b) { return a.start - b.start; });

    for (const cue of cues) {
        if (cue._tokens === undefined) {
            cue._tokens = tokenize(cue.text);
            cue._bigrams = bigrams(cue._tokens);
        }
    }
    return cues;
}

// First index whose cue.start >= targetMs.
function lowerBound(cues, targetMs) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].start < targetMs) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// First index whose cue.start > targetMs.
function upperBound(cues, targetMs) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].start <= targetMs) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Find the best subtitle span matching a Whisper transcription segment.
 *
 * Tries spans of 1..MAX_SPAN_CUES consecutive cues so a Whisper segment that
 * straddles a cue boundary can still match. Scoring uses word-bigram Dice
 * similarity (falls back to unigram for very short text), which captures
 * multi-word phrase agreement better than single-cue character distance.
 *
 * `options.centerMs` / `options.windowMs` restrict which cues may start a
 * span. Searching the whole file is what makes long movies fail: a 5-second
 * snippet has thousands of chances to score above threshold against a
 * lexically similar line an hour away, producing an offset no real subtitle
 * file could have. Bounding the search to a plausible window removes that
 * entire failure class. Spans may still extend past the window end.
 *
 * Returns {start, end, score, text, spanLength} or null. The `start` is the
 * first cue's start so offset = whisperStartMs - match.start makes sense.
 */
function findBestMatch(whisperText, cues, options) {
    const wTokens = tokenize(whisperText);
    if (wTokens.length < MIN_WHISPER_TOKENS) return null;

    indexCues(cues);
    const wBigrams = bigrams(wTokens);
    const useBigrams = wBigrams.length >= 2;

    let from = 0;
    let to = cues.length;
    if (options && typeof options.centerMs === 'number' && typeof options.windowMs === 'number') {
        from = lowerBound(cues, options.centerMs - options.windowMs);
        to = upperBound(cues, options.centerMs + options.windowMs);
    }

    let best = null;

    for (let i = from; i < to; i++) {
        let mergedTokens = null;
        let mergedBigrams = null;

        for (let span = 1; span <= MAX_SPAN_CUES && i + span <= cues.length; span++) {
            const cue = cues[i + span - 1];

            if (span === 1) {
                mergedTokens = cue._tokens;
                mergedBigrams = cue._bigrams;
            } else {
                // Lazily promote to a working copy on the second span step.
                if (span === 2) {
                    mergedTokens = mergedTokens.slice();
                    mergedBigrams = mergedBigrams.slice();
                }
                const prevLast = mergedTokens[mergedTokens.length - 1];
                const cueTokens = cue._tokens;
                if (prevLast !== undefined && cueTokens.length > 0) {
                    mergedBigrams.push(prevLast + ' ' + cueTokens[0]);
                }
                for (let k = 0; k < cueTokens.length; k++) mergedTokens.push(cueTokens[k]);
                for (let k = 0; k < cue._bigrams.length; k++) mergedBigrams.push(cue._bigrams[k]);
            }

            if (mergedTokens.length === 0) continue;

            const lenRatio = Math.min(wTokens.length, mergedTokens.length) /
                             Math.max(wTokens.length, mergedTokens.length);
            if (lenRatio < MIN_LENGTH_RATIO) continue;

            let score;
            if (useBigrams && mergedBigrams.length >= 1) {
                score = diceSimilarity(wBigrams, mergedBigrams);
            } else {
                score = diceSimilarity(wTokens, mergedTokens);
            }

            if (!best || score > best.score) {
                best = {
                    start: cues[i].start,
                    end: cue.end,
                    score: score,
                    text: cue.text,
                    spanLength: span,
                };
            }
        }
    }

    return (best && best.score >= MIN_TOKEN_SIMILARITY) ? best : null;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Largest contiguous run in an offset-sorted sample array whose spread is
// within bandwidth. Returns inclusive {start, end} indices.
function largestClusterRange(sorted, bandwidth) {
    let bestStart = 0;
    let bestEnd = 0;
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
        while (sorted[hi].offset - sorted[lo].offset > bandwidth) lo++;
        if (hi - lo > bestEnd - bestStart) {
            bestStart = lo;
            bestEnd = hi;
        }
    }
    return { start: bestStart, end: bestEnd };
}

// Accepts plain numbers (legacy) or {offset, sourceSec} samples. Plain numbers
// are treated as each having come from its own source, preserving the old
// count-only semantics for callers that do not track provenance.
function normalizeSamples(samples) {
    return samples.map(function (s, i) {
        return (typeof s === 'number')
            ? { offset: s, sourceSec: 'n' + i }
            : {
                offset: s.offset,
                sourceSec: (s.sourceSec === null || s.sourceSec === undefined) ? 'n' + i : s.sourceSec,
            };
    });
}

/**
 * Find the consensus offset by picking the densest cluster of values.
 *
 * The matcher will sometimes lock onto the wrong instance of a recurring
 * phrase ("yes", "I don't know"), producing wildly wrong offsets like
 * -600s. Median is robust to a *symmetric* sprinkle of outliers but breaks
 * when the wrong matches all skew the same direction. So we instead find
 * the largest set of offsets that agree within `bandwidthMs` and take the
 * median of *that* — outliers are simply dropped.
 *
 * Two-tier: the wide band locates the true cluster robustly, then we
 * re-cluster inside it at REFINE_BANDWIDTH_MS and take *that* median as the
 * answer. A cluster 4s wide medianed directly can still land a second off,
 * which is plainly visible on screen.
 *
 * `sourceCount` counts *distinct* sourceSec values in the winning cluster.
 * One 5s audio chunk yields several Whisper segments, so raw cluster size
 * says nothing about corroboration — three agreeing offsets from a single
 * mis-matched window is exactly how a confident wrong sync happens.
 *
 * Returns { offset, cluster, outliers, confidence, sourceCount, refinedCount }.
 */
function consensusOffset(samples, options) {
    const bandwidth = (options && options.bandwidthMs) || CONSENSUS_BANDWIDTH_MS;
    const refineBandwidth = (options && options.refineBandwidthMs) || REFINE_BANDWIDTH_MS;

    if (!samples || samples.length === 0) {
        return { offset: 0, cluster: [], outliers: [], confidence: 0, sourceCount: 0, refinedCount: 0 };
    }

    const normalized = normalizeSamples(samples);

    if (normalized.length === 1) {
        return {
            offset: normalized[0].offset,
            cluster: [normalized[0].offset],
            outliers: [],
            confidence: 1,
            sourceCount: 1,
            refinedCount: 1,
        };
    }

    const sorted = normalized.slice().sort(function (a, b) { return a.offset - b.offset; });

    const coarse = largestClusterRange(sorted, bandwidth);
    const cluster = sorted.slice(coarse.start, coarse.end + 1);
    const outliers = sorted.slice(0, coarse.start).concat(sorted.slice(coarse.end + 1));

    // Tighten: the answer comes from the densest sub-cluster of the winner.
    const fine = largestClusterRange(cluster, refineBandwidth);
    const refined = cluster.slice(fine.start, fine.end + 1);

    const sources = new Set();
    for (const s of cluster) sources.add(s.sourceSec);

    return {
        offset: median(refined.map(function (s) { return s.offset; })),
        cluster: cluster.map(function (s) { return s.offset; }),
        outliers: outliers.map(function (s) { return s.offset; }),
        confidence: cluster.length / sorted.length,
        sourceCount: sources.size,
        refinedCount: refined.length,
    };
}

// Is this consensus trustworthy enough to stop sampling and apply?
// Both call sites (direct + HLS) go through here so they cannot drift apart.
function isConfident(consensus) {
    return consensus.cluster.length >= MIN_MATCHES_FOR_CONFIDENCE &&
           consensus.sourceCount >= MIN_AGREEING_CHUNKS;
}

function computeOffset(whisperChunks, cues, audioStartTimeMs) {
    indexCues(cues);
    const offsets = [];

    for (const chunk of whisperChunks) {
        if (!chunk.text || !chunk.timestamp || chunk.timestamp[0] == null) continue;

        const whisperStartMs = audioStartTimeMs + chunk.timestamp[0] * 1000;
        const match = findBestMatch(chunk.text, cues, {
            centerMs: whisperStartMs,
            windowMs: MAX_PLAUSIBLE_OFFSET_MS,
        });

        if (match) {
            offsets.push(whisperStartMs - match.start);
        }
    }

    const { offset, cluster, outliers, confidence, sourceCount } = consensusOffset(offsets);
    return {
        offset,
        confidence,
        sourceCount,
        matchCount: cluster.length,
        rejectedCount: outliers.length,
        totalChunks: whisperChunks.length,
    };
}

async function fetchAndParseSubtitles(track) {
    const url = track.fallbackUrl || track.url || track.label;
    if (!url) {
        throw new Error('No subtitle URL available');
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch subtitles: ${response.status}`);
    }

    const text = await response.text();
    return parseSubtitles(text);
}

// Reorder picks so the first few are as far apart as possible (greedy
// farthest-point). Seeded with the densest window, then each next pick is
// whichever remaining one is furthest from everything chosen so far.
//
// This is what makes an early stop meaningful: the first batch ends up being
// the start, the end and the middle of the film rather than three windows
// from the same argument scene, so three agreeing offsets are three
// independent regions agreeing.
function orderByDispersion(windows) {
    if (windows.length <= 1) return windows.map(function (w) { return w.offset; });

    const remaining = windows.slice();
    let seed = 0;
    for (let i = 1; i < remaining.length; i++) {
        if (remaining[i].density > remaining[seed].density) seed = i;
    }
    const ordered = [remaining.splice(seed, 1)[0]];

    while (remaining.length > 0) {
        let bestIdx = 0;
        let bestDist = -1;
        for (let i = 0; i < remaining.length; i++) {
            let minDist = Infinity;
            for (const chosen of ordered) {
                const d = Math.abs(remaining[i].offset - chosen.offset);
                if (d < minDist) minDist = d;
            }
            if (minDist > bestDist) {
                bestDist = minDist;
                bestIdx = i;
            }
        }
        ordered.push(remaining.splice(bestIdx, 1)[0]);
    }

    return ordered.map(function (w) { return w.offset; });
}

/**
 * Finds the best time offsets to extract audio, ranked by subtitle density.
 *
 * Divides the subtitle timeline into `maxChunks` equal strata and takes the
 * densest window in each, so samples always span the whole runtime. Ranking
 * windows by density alone (the previous behaviour) collapses on movies: the
 * densest 5s windows all live inside a couple of rapid-fire dialogue scenes,
 * so every sample can come from the same minute of a two-hour film.
 *
 * Empty strata are backfilled from the densest windows left over, keeping a
 * minimum gap so backfills do not pile up next to each other.
 */
function findBestChunkOffsets(cues, chunkDurationSec, maxChunks) {
    if (!cues || cues.length === 0) return [0];

    const firstCueSec = Math.floor(cues[0].start / 1000);
    const lastCueSec = Math.ceil(cues[cues.length - 1].end / 1000);
    const startSec = Math.max(0, firstCueSec - 2);
    const totalSpan = lastCueSec - startSec;

    // If the subtitle span is short, just use consecutive chunks from the start
    if (totalSpan <= chunkDurationSec * maxChunks) {
        const offsets = [];
        for (let i = 0; i < maxChunks; i++) {
            const off = startSec + i * chunkDurationSec;
            if (off > lastCueSec) break;
            offsets.push(off);
        }
        return offsets.length > 0 ? offsets : [startSec];
    }

    // Build windows covering the full subtitle range
    const windows = [];
    for (let t = startSec; t < lastCueSec; t += chunkDurationSec) {
        const winStartMs = t * 1000;
        const winEndMs = (t + chunkDurationSec) * 1000;
        let count = 0;
        for (const cue of cues) {
            if (cue.end > winStartMs && cue.start < winEndMs) count++;
        }
        if (count > 0) windows.push({ offset: t, density: count });
    }

    if (windows.length === 0) return [startSec];

    // One pick per stratum: densest window within each equal slice of runtime.
    const strataWidth = totalSpan / maxChunks;
    const strata = new Array(maxChunks).fill(null);
    for (const win of windows) {
        let idx = Math.floor((win.offset - startSec) / strataWidth);
        if (idx >= maxChunks) idx = maxChunks - 1;
        if (idx < 0) idx = 0;
        if (strata[idx] === null || win.density > strata[idx].density) {
            strata[idx] = win;
        }
    }

    const picked = strata.filter(function (w) { return w !== null; });

    // Backfill empty strata (stretches with no dialogue) from what is left.
    if (picked.length < maxChunks) {
        const minGap = chunkDurationSec * 2;
        const pool = windows
            .filter(function (w) { return picked.indexOf(w) === -1; })
            .sort(function (a, b) { return b.density - a.density; });

        for (const candidate of pool) {
            if (picked.length >= maxChunks) break;
            let tooClose = false;
            for (const p of picked) {
                if (Math.abs(candidate.offset - p.offset) < minGap) { tooClose = true; break; }
            }
            if (!tooClose) picked.push(candidate);
        }
    }

    // Spread the *order*, not just the selection — the early stop means later
    // picks may never be reached, so the first ones must be the spread ones.
    return orderByDispersion(picked);
}

/**
 * Pick the densest chunk offsets within a window around a specific timestamp.
 *
 * Used for manual auto-sync while watching: the user is at time T, so we
 * want chunks that (a) are near T, and (b) contain dense dialogue — the same
 * quality signal that makes the initial density-ranked auto-sync work well.
 *
 * Strategy:
 *   1. Build a sliding window of ±WINDOW_SEC around focusSec
 *   2. Within that window, score every candidate chunk by cue density
 *      (count of cues) + text length (total characters of dialogue)
 *   3. Pick the top `maxChunks` by score, enforcing a minimum gap between
 *      chunks so we don't get two near-identical adjacent chunks
 *   4. If the window has too few scoring chunks, widen it
 */
function findChunkOffsetsNearTime(cues, chunkDurationSec, maxChunks, focusSec) {
    if (!cues || cues.length === 0) return [Math.max(0, Math.floor(focusSec))];

    const firstCueSec = Math.floor(cues[0].start / 1000);
    const lastCueSec = Math.ceil(cues[cues.length - 1].end / 1000);
    const clampedFocus = Math.max(firstCueSec, Math.min(lastCueSec - chunkDurationSec, focusSec));

    // Score every candidate chunk in the entire cue range by (density + text length),
    // then prefer chunks close to the focus time.
    const candidates = [];
    // Step by 1 second for finer granularity (not just on chunkDuration grid)
    const step = Math.max(1, Math.floor(chunkDurationSec / 2));
    for (let t = firstCueSec; t + chunkDurationSec <= lastCueSec; t += step) {
        const winStartMs = t * 1000;
        const winEndMs = (t + chunkDurationSec) * 1000;
        let count = 0;
        let textLen = 0;
        for (const cue of cues) {
            if (cue.end > winStartMs && cue.start < winEndMs) {
                count++;
                textLen += (cue.text || '').length;
            }
        }
        if (count === 0) continue;
        // Quality score: prefer many cues + lots of text
        const quality = count * 10 + Math.min(textLen, 200);
        candidates.push({ offset: t, quality: quality });
    }

    if (candidates.length === 0) {
        return [Math.max(0, Math.floor(clampedFocus))];
    }

    // Window the search around focus. Start tight, widen if not enough dense chunks.
    const WINDOW_TIERS = [30, 60, 120, 300]; // seconds half-width
    let picked = [];

    for (const half of WINDOW_TIERS) {
        const lo = clampedFocus - half;
        const hi = clampedFocus + half;
        const inWindow = candidates.filter(function (c) {
            return c.offset + chunkDurationSec > lo && c.offset < hi;
        });
        if (inWindow.length === 0) continue;

        // Sort by quality desc
        inWindow.sort(function (a, b) { return b.quality - a.quality; });

        // Greedy pick with minimum gap so chunks don't overlap / cluster
        const minGap = chunkDurationSec; // at least one chunk-width apart
        picked = [];
        for (const c of inWindow) {
            let tooClose = false;
            for (const p of picked) {
                if (Math.abs(c.offset - p) < minGap) { tooClose = true; break; }
            }
            if (!tooClose) picked.push(c.offset);
            if (picked.length >= maxChunks) break;
        }

        if (picked.length >= maxChunks) break;
    }

    // Fallback: if windowed search came up empty, just use the best global candidates
    if (picked.length === 0) {
        const sorted = candidates.slice().sort(function (a, b) { return b.quality - a.quality; });
        for (const c of sorted) {
            let tooClose = false;
            for (const p of picked) {
                if (Math.abs(c.offset - p) < chunkDurationSec) { tooClose = true; break; }
            }
            if (!tooClose) picked.push(c.offset);
            if (picked.length >= maxChunks) break;
        }
    }

    // Return in chronological order so HLS fallback works; direct path doesn't care
    picked.sort(function (a, b) { return a - b; });
    return picked.length > 0 ? picked : [Math.max(0, Math.floor(clampedFocus))];
}

module.exports = {
    parseSubtitles,
    computeOffset,
    consensusOffset,
    isConfident,
    findBestMatch,
    indexCues,
    fetchAndParseSubtitles,
    findBestChunkOffsets,
    findChunkOffsetsNearTime,
    MIN_MATCHES_FOR_CONFIDENCE,
    MIN_AGREEING_CHUNKS,
    CONSENSUS_BANDWIDTH_MS,
    REFINE_BANDWIDTH_MS,
    MAX_PLAUSIBLE_OFFSET_MS,
    REFINE_WINDOW_MS,
};
