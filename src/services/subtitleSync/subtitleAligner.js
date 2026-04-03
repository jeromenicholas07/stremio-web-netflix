const MATCH_THRESHOLD = 0.4;
const MIN_MATCHES_FOR_CONFIDENCE = 3;

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

function normalizeText(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = b[i - 1] === a[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            );
        }
    }

    return matrix[b.length][a.length];
}

function normalizedDistance(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 0;
    return levenshteinDistance(a, b) / maxLen;
}

function findBestMatch(whisperText, cues, searchWindowMs) {
    const normalized = normalizeText(whisperText);
    if (normalized.length < 3) return null;

    let bestMatch = null;
    let bestDistance = MATCH_THRESHOLD;

    for (const cue of cues) {
        const cueNormalized = normalizeText(cue.text);
        if (cueNormalized.length < 3) continue;

        const shorter = normalized.length < cueNormalized.length ? normalized : cueNormalized;
        const longer = normalized.length < cueNormalized.length ? cueNormalized : normalized;

        if (Math.abs(shorter.length - longer.length) / Math.max(shorter.length, longer.length) > 0.6) {
            continue;
        }

        const distance = normalizedDistance(normalized, cueNormalized);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestMatch = cue;
        }
    }

    return bestMatch;
}

function computeOffset(whisperChunks, cues, audioStartTimeMs) {
    const offsets = [];

    for (const chunk of whisperChunks) {
        if (!chunk.text || !chunk.timestamp || chunk.timestamp[0] == null) continue;

        const whisperStartMs = audioStartTimeMs + chunk.timestamp[0] * 1000;
        const match = findBestMatch(chunk.text, cues);

        if (match) {
            const offset = whisperStartMs - match.start;
            offsets.push(offset);
        }
    }

    if (offsets.length < MIN_MATCHES_FOR_CONFIDENCE) {
        return {
            offset: offsets.length > 0 ? median(offsets) : 0,
            confidence: offsets.length / Math.max(whisperChunks.length, 1),
            matchCount: offsets.length,
            totalChunks: whisperChunks.length,
        };
    }

    return {
        offset: median(offsets),
        confidence: offsets.length / Math.max(whisperChunks.length, 1),
        matchCount: offsets.length,
        totalChunks: whisperChunks.length,
    };
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
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

/**
 * Finds the best time offsets to extract audio, ranked by subtitle density.
 *
 * Divides the subtitle timeline into non-overlapping windows, scores each
 * by the number of cues it contains, then picks the densest windows while
 * keeping them in chronological order. This lets us sample dialogue-rich
 * regions from anywhere in the video (beginning, middle, end) while
 * respecting the HLS transcoder's sequential processing requirement.
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
        const winStart = t;
        const winEnd = t + chunkDurationSec;
        const winStartMs = winStart * 1000;
        const winEndMs = winEnd * 1000;
        let count = 0;
        for (const cue of cues) {
            if (cue.end > winStartMs && cue.start < winEndMs) count++;
        }
        windows.push({ offset: winStart, density: count });
    }

    // Sort by density descending, pick the top N
    const ranked = [...windows].sort((a, b) => b.density - a.density);
    const selected = new Set();
    for (const win of ranked) {
        if (selected.size >= maxChunks) break;
        if (win.density === 0) continue;
        selected.add(win.offset);
    }

    // Return in chronological order so the transcoder processes sequentially
    const offsets = [...selected].sort((a, b) => a - b);
    return offsets.length > 0 ? offsets : [startSec];
}

module.exports = {
    parseSubtitles,
    computeOffset,
    findBestMatch,
    fetchAndParseSubtitles,
    findBestChunkOffsets,
    MIN_MATCHES_FOR_CONFIDENCE,
};
