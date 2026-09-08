const React = require('react');
const {
    checkExtractServer,
    extractBatch,
    resolveMediaUrl,
    createAudioSession,
} = require('stremio/services/subtitleSync/audioExtractor');
const {
    findBestMatch: findBestMatchExport,
    consensusOffset,
    isConfident,
    indexCues,
    fetchAndParseSubtitles,
    findBestChunkOffsets,
    findChunkOffsetsNearTime,
    MAX_PLAUSIBLE_OFFSET_MS,
    REFINE_WINDOW_MS,
} = require('stremio/services/subtitleSync/subtitleAligner');

const SYNC_STATUS = {
    IDLE: 'idle',
    DOWNLOADING: 'downloading',
    EXTRACTING: 'extracting',
    TRANSCRIBING: 'transcribing',
    ALIGNING: 'aligning',
    DONE: 'done',
    ERROR: 'error',
};

const CHUNK_DURATION = 5;           // seconds per chunk (was 15)
const MAX_CHUNK_ATTEMPTS = 16;      // max chunks to try (auto-sync, a long movie)
const BATCH_SIZE = 3;               // parallel fetches per batch (auto-sync)
const MANUAL_CHUNK_ATTEMPTS = 2;    // manual sync: 1 batch of 2 near current time
const MAX_RETRIES = 3;              // full pipeline retries (HLS fallback only)

// Floor for the auto-sync budget: what a ~45min episode has always used.
const MIN_CHUNK_ATTEMPTS = 8;
// Runtime per chunk, between that floor and MAX_CHUNK_ATTEMPTS.
const SECONDS_PER_CHUNK = 420;

// A movie is 2-3x an episode, so a fixed 8-chunk budget samples it 2-3x more
// thinly. Scale with runtime instead. The early stop still applies, so a
// cleanly-matching movie costs nothing extra — only the ones that need more
// evidence spend it, and episodes stay exactly where they were.
const chunkBudget = (durationSec) => {
    if (!durationSec || !isFinite(durationSec) || durationSec <= 0) return MIN_CHUNK_ATTEMPTS;
    const scaled = Math.round(durationSec / SECONDS_PER_CHUNK);
    return Math.max(MIN_CHUNK_ATTEMPTS, Math.min(MAX_CHUNK_ATTEMPTS, scaled));
};

// whisper-tiny emits these stock phrases over music and silence, which movies
// serve up constantly during scored sequences. They are pure spurious-match
// fuel: fake text that still scores above threshold against some real line.
const HALLUCINATION_PATTERNS = [
    /^thanks? (you|for watching)\b/i,
    /\bsubtitles?\s+(by|provided)\b/i,
    /\bamara\.org\b/i,
    /^[\s♪♫*[\]()-]*$/,
];

const isHallucination = (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return true;
    return HALLUCINATION_PATTERNS.some((re) => re.test(trimmed));
};

const useWhisperSync = (extraSubtitlesTracks, selectedExtraSubtitlesTrackId, setSubtitlesDelay, streamingServerUrl, streamContent, currentTimeMs, durationMs) => {
    // Keep latest currentTime in a ref so callbacks don't need to recreate
    const currentTimeMsRef = React.useRef(currentTimeMs);
    React.useEffect(() => { currentTimeMsRef.current = currentTimeMs; }, [currentTimeMs]);
    const durationMsRef = React.useRef(durationMs);
    React.useEffect(() => { durationMsRef.current = durationMs; }, [durationMs]);
    const [syncStatus, setSyncStatus] = React.useState(SYNC_STATUS.IDLE);
    const [syncProgress, setSyncProgress] = React.useState(0);
    const [syncError, setSyncError] = React.useState(null);
    const [syncResult, setSyncResult] = React.useState(null);

    const workerRef = React.useRef(null);
    const cancelledRef = React.useRef(false);
    const prevTrackIdRef = React.useRef(null);

    const getSelectedTrack = React.useCallback(() => {
        if (!selectedExtraSubtitlesTrackId || !Array.isArray(extraSubtitlesTracks)) return null;
        return extraSubtitlesTracks.find((t) => t.id === selectedExtraSubtitlesTrackId) || null;
    }, [extraSubtitlesTracks, selectedExtraSubtitlesTrackId]);

    const createWorker = React.useCallback(() => {
        if (workerRef.current) {
            workerRef.current.terminate();
        }
        const origin = window.location.origin;
        // Use webpack's publicPath so the URL is correct on both localhost and GitHub Pages
        const publicPath = __webpack_public_path__ || '/';
        const scriptUrl = `${origin}${publicPath}${process.env.COMMIT_HASH}/scripts/whisperWorker.js`;
        const shim = 'if(typeof document==="undefined"){globalThis.document={baseURI:"' + origin + '/",currentScript:null};}';
        const blob = new Blob(
            [shim + 'importScripts("' + scriptUrl + '");'],
            { type: 'application/javascript' }
        );
        workerRef.current = new Worker(URL.createObjectURL(blob));
        return workerRef.current;
    }, []);

    const transcribeAudio = React.useCallback((worker, audioData) => {
        return new Promise((resolve, reject) => {
            // Watchdog: bail if the worker goes silent for too long. Reset on
            // every message so a slow first-run model download (which streams
            // download_progress messages) doesn't trip it. 60s of pure silence
            // is well past anything legitimate — model init or transcription.
            const SILENCE_MS = 60000;
            let watchdog = null;
            const armWatchdog = () => {
                if (watchdog) clearTimeout(watchdog);
                watchdog = setTimeout(() => {
                    reject(new Error('Transcription stalled (no worker progress for 60s)'));
                }, SILENCE_MS);
            };
            const settle = (fn, value) => { if (watchdog) clearTimeout(watchdog); fn(value); };
            armWatchdog();

            worker.onmessage = (event) => {
                armWatchdog(); // any message = worker is alive
                const { type } = event.data;

                if (cancelledRef.current) {
                    settle(reject, new Error('Cancelled'));
                    return;
                }

                if (type === 'status') {
                    if (event.data.status === 'downloading') {
                        setSyncStatus(SYNC_STATUS.DOWNLOADING);
                    } else if (event.data.status === 'transcribing') {
                        setSyncStatus(SYNC_STATUS.TRANSCRIBING);
                    }
                } else if (type === 'download_progress') {
                    setSyncProgress(event.data.progress);
                } else if (type === 'result') {
                    settle(resolve, event.data);
                } else if (type === 'error') {
                    settle(reject, new Error(event.data.error));
                }
            };

            worker.onerror = (error) => settle(reject, error);

            worker.postMessage({
                type: 'transcribe',
                audio: audioData.audio,
                sampleRate: audioData.sampleRate,
            });
        });
    }, []);

    // How many chunks this title earns, from player duration (cue span as fallback).
    const resolveAutoBudget = React.useCallback((cues) => {
        const fromPlayer = durationMsRef.current;
        const durationSec = (fromPlayer && isFinite(fromPlayer) && fromPlayer > 0)
            ? fromPlayer / 1000
            : (cues.length > 0 ? cues[cues.length - 1].end / 1000 : 0);
        return chunkBudget(durationSec);
    }, []);

    // ── Collect matches from a transcription result ──
    // Every sample carries the audio chunk it came from. One 5s chunk yields
    // several whisper segments, so without provenance three "agreeing" offsets
    // can all be the same 5 seconds of film agreeing with itself.
    //
    // `coarseOffset` switches this to the refine pass: search a tight window
    // around where the coarse estimate says the line should be, instead of the
    // whole plausible range.
    const collectSamples = React.useCallback((transcription, audioData, cues, coarseOffset) => {
        const refining = typeof coarseOffset === 'number' && isFinite(coarseOffset);
        const samples = [];
        for (const segment of transcription.chunks) {
            if (!segment.text || !segment.timestamp || segment.timestamp[0] == null) continue;
            if (isHallucination(segment.text)) continue;
            const whisperStartMs = audioData.startTime * 1000 + segment.timestamp[0] * 1000;
            const match = findBestMatchExport(segment.text, cues, {
                centerMs: refining ? whisperStartMs - coarseOffset : whisperStartMs,
                windowMs: refining ? REFINE_WINDOW_MS : MAX_PLAUSIBLE_OFFSET_MS,
            });
            if (match) {
                samples.push({
                    offset: whisperStartMs - match.start,
                    sourceSec: audioData.startTime,
                    score: match.score,
                });
            }
        }
        return samples;
    }, []);

    // ── Compute and apply the final offset from accumulated matches ──
    // Uses consensus clustering rather than raw median: if some matches locked
    // onto the wrong instance of a recurring phrase (causing -600s outliers),
    // they fall outside the cluster of agreeing matches and get dropped.
    //
    // Two passes. The first located the answer within a generous window; the
    // second re-matches every retained segment within REFINE_WINDOW_MS of it,
    // which drops the far-away lookalikes that survived pass one and tightens
    // what is left. Pass two only ever refines the answer pass one found.
    const finalize = React.useCallback((samples, transcripts, cues, totalChunksProcessed) => {
        const coarse = consensusOffset(samples);

        const refinedSamples = [];
        for (const t of transcripts) {
            const s = collectSamples(t.transcription, t.audioData, cues, coarse.offset);
            refinedSamples.push.apply(refinedSamples, s);
        }
        const refined = consensusOffset(refinedSamples);

        const chosen = refined.cluster.length > 0 ? refined : coarse;
        const delayMs = Math.round(chosen.offset);

        setSubtitlesDelay(delayMs);
        setSyncResult({
            offset: chosen.offset,
            confidence: chosen.confidence,
            matchCount: chosen.cluster.length,
            sourceCount: chosen.sourceCount,
            corroborated: isConfident(chosen),
            rejectedCount: chosen.outliers.length,
            totalChunks: totalChunksProcessed,
        });
        setSyncStatus(SYNC_STATUS.DONE);
        // eslint-disable-next-line no-console
        console.log(
            '[WhisperSync] Consensus offset:', delayMs + 'ms',
            '| pass1:', Math.round(coarse.offset) + 'ms (' + coarse.cluster.length + ' matches / ' +
                coarse.sourceCount + ' chunks)',
            '| pass2:', Math.round(refined.offset) + 'ms (' + refined.cluster.length + ' matches / ' +
                refined.sourceCount + ' chunks)',
            '| corroborated:', isConfident(chosen),
            '| rejected outliers:', chosen.outliers.length,
            chosen.outliers.length > 0
                ? '(' + chosen.outliers.map(function (o) { return Math.round(o) + 'ms'; }).join(', ') + ')'
                : '',
        );
    }, [setSubtitlesDelay, collectSamples]);

    // ══════════════════════════════════════════════════════════════
    //  Direct extraction path — batch-of-3, parallel fetch, fast
    // ══════════════════════════════════════════════════════════════

    const runDirectSync = React.useCallback(async (cues, focusTimeSec) => {
        if (cancelledRef.current) return;

        setSyncStatus(SYNC_STATUS.EXTRACTING);

        const resolved = await resolveMediaUrl(streamingServerUrl, streamContent);
        const mediaUrl = resolved.url;
        const mediaHeaders = resolved.headers;
        const extractUrl = resolved.hlsUrl || mediaUrl;
        if (cancelledRef.current) return;

        // eslint-disable-next-line no-console
        console.log('[WhisperSync] Stream type:', resolved.isTorrent ? 'torrent' : 'debrid/HTTP',
            '| extract via:', resolved.hlsUrl ? 'HLS transcoder' : 'direct proxy');

        // Manual sync (focusTimeSec set): pick densest chunks WITHIN a window
        // around the current playback time. Only 2 chunks in 1 batch — fast,
        // deterministic, and uses the same density quality signal as auto-sync.
        //
        // Auto-sync (no focusTimeSec): density-ranked chunks across the whole
        // episode (up to 8 chunks, 3 per batch).
        const isManual = focusTimeSec != null;
        const chunkLimit = isManual ? MANUAL_CHUNK_ATTEMPTS : resolveAutoBudget(cues);
        const batchSize = isManual ? MANUAL_CHUNK_ATTEMPTS : BATCH_SIZE;

        const chunkOffsets = isManual
            ? findChunkOffsetsNearTime(cues, CHUNK_DURATION, chunkLimit, focusTimeSec)
            : findBestChunkOffsets(cues, CHUNK_DURATION, chunkLimit);

        // eslint-disable-next-line no-console
        console.log('[WhisperSync] Chunk strategy:',
            isManual ? 'focused @' + Math.round(focusTimeSec) + 's (' + chunkLimit + ' chunks)' : 'density-ranked',
            '| offsets:', chunkOffsets.map(function (o) { return o + 's'; }).join(', '));

        // Split into batches
        const batches = [];
        for (let i = 0; i < chunkOffsets.length; i += batchSize) {
            batches.push(chunkOffsets.slice(i, i + batchSize));
        }

        // Create worker once — model stays loaded across all chunks
        const worker = createWorker();
        const allSamples = [];
        // Retained so the refine pass can re-match without re-transcribing.
        const transcripts = [];
        let totalChunksProcessed = 0;

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            if (cancelledRef.current) return;

            const batch = batches[batchIdx];
            const batchChunks = batch.map(function (offset) {
                return { start: offset, duration: CHUNK_DURATION };
            });

            // ── Parallel fetch: all chunks in this batch at once ──
            setSyncStatus(SYNC_STATUS.EXTRACTING);
            // eslint-disable-next-line no-console
            console.log(
                '[WhisperSync] Batch', batchIdx + 1, '/', batches.length,
                '— extracting', batchChunks.length, 'chunks at offsets:',
                batch.map(function (o) { return o + 's'; }).join(', '),
            );
            let audioResults;
            try {
                audioResults = await extractBatch(extractUrl, batchChunks, mediaHeaders);
            } catch (err) {
                if (cancelledRef.current) return;
                // Whole batch failed. If we already collected matches from
                // earlier batches, prefer applying those over throwing — losing
                // work just because a later batch dies is worse than a partial
                // sync. If nothing has worked yet, propagate so HLS fallback runs.
                // eslint-disable-next-line no-console
                console.warn('[WhisperSync] Batch', batchIdx + 1, 'failed:', err && err.message);
                if (allSamples.length === 0) throw err;
                break;
            }
            if (cancelledRef.current) return;

            // ── Sequential transcribe + align per chunk ──
            for (let i = 0; i < audioResults.length; i++) {
                if (cancelledRef.current) return;

                const audioData = audioResults[i];
                const transcription = await transcribeAudio(worker, audioData);
                if (cancelledRef.current) return;

                setSyncStatus(SYNC_STATUS.ALIGNING);
                const samples = collectSamples(transcription, audioData, cues);
                allSamples.push.apply(allSamples, samples);
                transcripts.push({ transcription, audioData });
                totalChunksProcessed++;

                // eslint-disable-next-line no-console
                console.log(
                    '[WhisperSync]   Chunk', totalChunksProcessed, '(@' + audioData.startTime + 's):',
                    samples.length, 'matches — total:', allSamples.length,
                );
            }

            // ── Early stop: enough *agreeing* matches, from enough places? ──
            // Don't stop on raw count alone — a few outlier matches with no
            // consensus would produce a wrong sync. And don't stop on cluster
            // size alone either: one 5s chunk emits several whisper segments,
            // so a single mis-matched window can hit the cluster threshold by
            // itself. isConfident also requires agreement across distinct
            // chunks, which the dispersed chunk ordering makes meaningful —
            // they are different regions of the film, not neighbours.
            const early = consensusOffset(allSamples);
            if (isConfident(early)) {
                // eslint-disable-next-line no-console
                console.log('[WhisperSync] Consensus reached after', totalChunksProcessed, 'chunks (',
                    early.cluster.length, 'agreeing across', early.sourceCount, 'chunks /',
                    allSamples.length, 'total)');
                finalize(allSamples, transcripts, cues, totalChunksProcessed);
                return;
            }
        }

        // All batches exhausted
        if (allSamples.length > 0) {
            // eslint-disable-next-line no-console
            console.log('[WhisperSync] Low confidence — applying best effort with', allSamples.length, 'matches');
            finalize(allSamples, transcripts, cues, totalChunksProcessed);
        } else {
            throw new Error('No matches found. Subtitle language may not match audio.');
        }
    }, [streamingServerUrl, streamContent, createWorker, transcribeAudio, collectSamples, finalize, resolveAutoBudget]);

    // ══════════════════════════════════════════════════════════════
    //  HLS fallback path — sequential, original algorithm
    // ══════════════════════════════════════════════════════════════

    const runHlsSync = React.useCallback(async (cues, focusTimeSec) => {
        let lastError = null;

        for (let retry = 0; retry < MAX_RETRIES; retry++) {
            if (cancelledRef.current) return;

            let session = null;
            try {
                setSyncStatus(SYNC_STATUS.EXTRACTING);

                session = await createAudioSession(streamingServerUrl, streamContent);
                if (cancelledRef.current) return;

                // For HLS fallback, chunks must be chronological (transcoder is sequential)
                const hlsChunkLimit = focusTimeSec != null ? MANUAL_CHUNK_ATTEMPTS : resolveAutoBudget(cues);
                const chunkOffsets = focusTimeSec != null
                    ? findChunkOffsetsNearTime(cues, CHUNK_DURATION, hlsChunkLimit, focusTimeSec)
                    : findBestChunkOffsets(cues, CHUNK_DURATION, hlsChunkLimit);
                const chronological = [...chunkOffsets].sort(function (a, b) { return a - b; });

                const worker = createWorker();
                const allSamples = [];
                const transcripts = [];

                for (let attempt = 0; attempt < chronological.length; attempt++) {
                    if (cancelledRef.current) return;

                    const startTime = chronological[attempt];
                    setSyncStatus(SYNC_STATUS.EXTRACTING);

                    const audioData = await session.getChunk(startTime, CHUNK_DURATION);
                    if (cancelledRef.current) return;

                    const transcription = await transcribeAudio(worker, audioData);
                    if (cancelledRef.current) return;

                    setSyncStatus(SYNC_STATUS.ALIGNING);

                    const samples = collectSamples(transcription, audioData, cues);
                    allSamples.push.apply(allSamples, samples);
                    transcripts.push({ transcription, audioData });

                    const hlsConsensus = consensusOffset(allSamples);
                    if (isConfident(hlsConsensus)) {
                        finalize(allSamples, transcripts, cues, attempt + 1);
                        session.close();
                        return;
                    }

                    if (attempt === chronological.length - 1) {
                        lastError = 'Low confidence: only ' + allSamples.length + ' matches found. ' +
                            'Subtitle language may not match audio.';
                        setSyncResult({
                            offset: hlsConsensus.offset,
                            confidence: hlsConsensus.confidence,
                            matchCount: hlsConsensus.cluster.length,
                            sourceCount: hlsConsensus.sourceCount,
                            corroborated: false,
                            totalChunks: chronological.length,
                        });
                    }
                }

                session.close();
            } catch (error) {
                if (session) session.close();
                if (cancelledRef.current) return;
                lastError = error.message || 'Sync failed';
            }

            if (retry < MAX_RETRIES - 1) {
                setSyncStatus(SYNC_STATUS.EXTRACTING);
                await new Promise(function (r) { setTimeout(r, 2000); });
            }
        }

        if (!cancelledRef.current) {
            throw new Error(lastError || 'Sync failed after multiple attempts');
        }
    }, [streamingServerUrl, streamContent, createWorker, transcribeAudio, collectSamples, finalize, resolveAutoBudget]);

    // ══════════════════════════════════════════════════════════════
    //  Main entry point — picks the best available extraction path
    // ══════════════════════════════════════════════════════════════

    const runSync = React.useCallback(async (focusTimeSec) => {
        const track = getSelectedTrack();
        if (!track || !streamContent || !streamingServerUrl) return;

        cancelledRef.current = false;
        setSyncStatus(SYNC_STATUS.EXTRACTING);
        setSyncProgress(0);
        setSyncError(null);
        setSyncResult(null);

        try {
            // Parse subtitle cues
            const cues = await fetchAndParseSubtitles(track);
            if (cancelledRef.current) return;
            if (!cues.length) throw new Error('No subtitle cues found');
            // Tokenize once up-front so every chunk's match step is O(N) cheap.
            indexCues(cues);

            // Prefer direct FFmpeg extraction (fast, seekable, parallel batches)
            const directAvailable = await checkExtractServer();

            if (directAvailable) {
                // eslint-disable-next-line no-console
                console.log('[WhisperSync] Using direct FFmpeg extraction (sidecar on :12471)');
                try {
                    await runDirectSync(cues, focusTimeSec);
                } catch (directError) {
                    if (cancelledRef.current) return;
                    // eslint-disable-next-line no-console
                    console.warn('[WhisperSync] Direct extraction failed:', directError.message, '— falling back to HLS');
                    await runHlsSync(cues, focusTimeSec);
                }
            } else {
                // eslint-disable-next-line no-console
                console.log('[WhisperSync] Sidecar unavailable — falling back to HLS extraction');
                await runHlsSync(cues, focusTimeSec);
            }
        } catch (error) {
            if (!cancelledRef.current) {
                setSyncStatus(SYNC_STATUS.ERROR);
                setSyncError(error.message || 'Sync failed');
            }
        }
    }, [streamingServerUrl, streamContent, getSelectedTrack, runDirectSync, runHlsSync]);

    // Manual sync (button click while watching) — focus on current playback time
    // so results are deterministic: seek to a clear-dialogue moment, click sync,
    // and the transcription happens exactly there.
    const startSync = React.useCallback(() => {
        const tMs = currentTimeMsRef.current;
        const focusTimeSec = (tMs != null && isFinite(tMs) && tMs > 0) ? tMs / 1000 : undefined;
        runSync(focusTimeSec);
    }, [runSync]);

    const cancelSync = React.useCallback(() => {
        cancelledRef.current = true;
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        setSyncStatus(SYNC_STATUS.IDLE);
        setSyncProgress(0);
        setSyncError(null);
    }, []);

    // Auto-sync when an external subtitle track is selected.
    // Mark the track as "synced" only AFTER we actually fire the sync — otherwise
    // a track selected before streamContent/streamingServerUrl arrives would update
    // prevTrackIdRef without syncing, and the next effect run (with deps ready)
    // would be blocked by the equality gate.
    React.useEffect(() => {
        if (!selectedExtraSubtitlesTrackId) {
            prevTrackIdRef.current = null;
            return;
        }
        if (selectedExtraSubtitlesTrackId === prevTrackIdRef.current) return;
        const track = (Array.isArray(extraSubtitlesTracks) ? extraSubtitlesTracks : [])
            .find((t) => t.id === selectedExtraSubtitlesTrackId);
        if (!track || track.embedded) {
            prevTrackIdRef.current = selectedExtraSubtitlesTrackId; // embedded tracks don't sync
            return;
        }
        if (!streamContent || !streamingServerUrl) {
            // Wait for player state to settle — don't mark as synced yet
            return;
        }
        prevTrackIdRef.current = selectedExtraSubtitlesTrackId;
        const timer = setTimeout(() => runSync(), 500);
        return () => clearTimeout(timer);
    }, [selectedExtraSubtitlesTrackId, extraSubtitlesTracks, streamContent, streamingServerUrl, runSync]);

    React.useEffect(() => {
        return () => {
            cancelledRef.current = true;
            if (workerRef.current) {
                workerRef.current.terminate();
                workerRef.current = null;
            }
        };
    }, []);

    return {
        syncStatus,
        syncProgress,
        syncError,
        syncResult,
        startSync,
        cancelSync,
        SYNC_STATUS,
    };
};

module.exports = useWhisperSync;
