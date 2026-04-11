const React = require('react');
const {
    checkExtractServer,
    extractBatch,
    resolveMediaUrl,
    createAudioSession,
} = require('stremio/services/subtitleSync/audioExtractor');
const {
    computeOffset,
    findBestMatch: findBestMatchExport,
    fetchAndParseSubtitles,
    findBestChunkOffsets,
    findChunkOffsetsNearTime,
    MIN_MATCHES_FOR_CONFIDENCE,
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
const MAX_CHUNK_ATTEMPTS = 8;       // max chunks to try
const BATCH_SIZE = 3;               // parallel fetches per batch
const MAX_RETRIES = 3;              // full pipeline retries (HLS fallback only)

const useWhisperSync = (extraSubtitlesTracks, selectedExtraSubtitlesTrackId, setSubtitlesDelay, streamingServerUrl, streamContent, currentTimeMs) => {
    // Keep latest currentTime in a ref so callbacks don't need to recreate
    const currentTimeMsRef = React.useRef(currentTimeMs);
    React.useEffect(() => { currentTimeMsRef.current = currentTimeMs; }, [currentTimeMs]);
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
            worker.onmessage = (event) => {
                const { type } = event.data;

                if (cancelledRef.current) {
                    worker.terminate();
                    reject(new Error('Cancelled'));
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
                    resolve(event.data);
                } else if (type === 'error') {
                    reject(new Error(event.data.error));
                }
            };

            worker.onerror = (error) => reject(error);

            worker.postMessage({
                type: 'transcribe',
                audio: audioData.audio,
                sampleRate: audioData.sampleRate,
            });
        });
    }, []);

    // ── Collect matches from a transcription result ──
    const collectMatches = React.useCallback((transcription, audioData, cues) => {
        const offsets = [];
        for (const chunk of transcription.chunks) {
            if (!chunk.text || !chunk.timestamp || chunk.timestamp[0] == null) continue;
            const whisperStartMs = audioData.startTime * 1000 + chunk.timestamp[0] * 1000;
            const match = findBestMatchExport(chunk.text, cues);
            if (match) {
                offsets.push(whisperStartMs - match.start);
            }
        }
        return offsets;
    }, []);

    // ── Compute and apply the final offset from accumulated matches ──
    const applyOffset = React.useCallback((allOffsets, totalChunksProcessed) => {
        const sorted = [...allOffsets].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianOffset = sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
        const delayMs = Math.round(medianOffset);
        setSubtitlesDelay(delayMs);
        setSyncResult({
            offset: medianOffset,
            confidence: allOffsets.length / Math.max(allOffsets.length + 1, 1),
            matchCount: allOffsets.length,
            totalChunks: totalChunksProcessed,
        });
        setSyncStatus(SYNC_STATUS.DONE);
    }, [setSubtitlesDelay]);

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

        // If a focus time is provided (manual sync while watching), pick chunks
        // centered around it for deterministic results. Otherwise use density
        // ranking across the whole episode (initial auto-sync on track load).
        const chunkOffsets = focusTimeSec != null
            ? findChunkOffsetsNearTime(cues, CHUNK_DURATION, MAX_CHUNK_ATTEMPTS, focusTimeSec)
            : findBestChunkOffsets(cues, CHUNK_DURATION, MAX_CHUNK_ATTEMPTS);

        // eslint-disable-next-line no-console
        console.log('[WhisperSync] Chunk strategy:',
            focusTimeSec != null ? 'focused @' + Math.round(focusTimeSec) + 's' : 'density-ranked',
            '| offsets:', chunkOffsets.map(function (o) { return o + 's'; }).join(', '));

        // Split into batches of BATCH_SIZE
        const batches = [];
        for (let i = 0; i < chunkOffsets.length; i += BATCH_SIZE) {
            batches.push(chunkOffsets.slice(i, i + BATCH_SIZE));
        }

        // Create worker once — model stays loaded across all chunks
        const worker = createWorker();
        const allOffsets = [];
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
            const audioResults = await extractBatch(extractUrl, batchChunks, mediaHeaders);
            if (cancelledRef.current) return;

            // ── Sequential transcribe + align per chunk ──
            for (let i = 0; i < audioResults.length; i++) {
                if (cancelledRef.current) return;

                const audioData = audioResults[i];
                const transcription = await transcribeAudio(worker, audioData);
                if (cancelledRef.current) return;

                setSyncStatus(SYNC_STATUS.ALIGNING);
                const matchOffsets = collectMatches(transcription, audioData, cues);
                allOffsets.push.apply(allOffsets, matchOffsets);
                totalChunksProcessed++;

                // eslint-disable-next-line no-console
                console.log(
                    '[WhisperSync]   Chunk', totalChunksProcessed, '(@' + audioData.startTime + 's):',
                    matchOffsets.length, 'matches — total:', allOffsets.length,
                );
            }

            // ── Early stop: enough confidence? ──
            if (allOffsets.length >= MIN_MATCHES_FOR_CONFIDENCE) {
                // eslint-disable-next-line no-console
                console.log('[WhisperSync] Confidence reached after', totalChunksProcessed, 'chunks');
                applyOffset(allOffsets, totalChunksProcessed);
                return;
            }
        }

        // All batches exhausted
        if (allOffsets.length > 0) {
            // eslint-disable-next-line no-console
            console.log('[WhisperSync] Low confidence — applying best effort with', allOffsets.length, 'matches');
            applyOffset(allOffsets, totalChunksProcessed);
        } else {
            throw new Error('No matches found. Subtitle language may not match audio.');
        }
    }, [streamingServerUrl, streamContent, createWorker, transcribeAudio, collectMatches, applyOffset]);

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
                const chunkOffsets = focusTimeSec != null
                    ? findChunkOffsetsNearTime(cues, CHUNK_DURATION, MAX_CHUNK_ATTEMPTS, focusTimeSec)
                    : findBestChunkOffsets(cues, CHUNK_DURATION, MAX_CHUNK_ATTEMPTS);
                const chronological = [...chunkOffsets].sort(function (a, b) { return a - b; });

                const worker = createWorker();
                const allOffsets = [];

                for (let attempt = 0; attempt < chronological.length; attempt++) {
                    if (cancelledRef.current) return;

                    const startTime = chronological[attempt];
                    setSyncStatus(SYNC_STATUS.EXTRACTING);

                    const audioData = await session.getChunk(startTime, CHUNK_DURATION);
                    if (cancelledRef.current) return;

                    const transcription = await transcribeAudio(worker, audioData);
                    if (cancelledRef.current) return;

                    setSyncStatus(SYNC_STATUS.ALIGNING);

                    const matchOffsets = collectMatches(transcription, audioData, cues);
                    allOffsets.push.apply(allOffsets, matchOffsets);

                    if (allOffsets.length >= MIN_MATCHES_FOR_CONFIDENCE) {
                        applyOffset(allOffsets, attempt + 1);
                        session.close();
                        return;
                    }

                    if (attempt === chronological.length - 1) {
                        lastError = 'Low confidence: only ' + allOffsets.length + ' matches found. ' +
                            'Subtitle language may not match audio.';
                        setSyncResult({
                            offset: allOffsets.length > 0
                                ? allOffsets.sort(function (a, b) { return a - b; })[Math.floor(allOffsets.length / 2)]
                                : 0,
                            matchCount: allOffsets.length,
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
    }, [streamingServerUrl, streamContent, createWorker, transcribeAudio, collectMatches, applyOffset]);

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

    // Auto-sync when an external subtitle track is selected
    React.useEffect(() => {
        if (selectedExtraSubtitlesTrackId && selectedExtraSubtitlesTrackId !== prevTrackIdRef.current) {
            prevTrackIdRef.current = selectedExtraSubtitlesTrackId;
            const track = (Array.isArray(extraSubtitlesTracks) ? extraSubtitlesTracks : [])
                .find((t) => t.id === selectedExtraSubtitlesTrackId);
            if (track && !track.embedded && streamContent && streamingServerUrl) {
                const timer = setTimeout(() => runSync(), 500);
                return () => clearTimeout(timer);
            }
        } else if (!selectedExtraSubtitlesTrackId) {
            prevTrackIdRef.current = null;
        }
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
