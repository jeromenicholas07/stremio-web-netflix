const React = require('react');
const { createAudioSession } = require('stremio/services/subtitleSync/audioExtractor');
const { computeOffset, findBestMatch: findBestMatchExport, fetchAndParseSubtitles, findBestChunkOffsets, MIN_MATCHES_FOR_CONFIDENCE } = require('stremio/services/subtitleSync/subtitleAligner');

const SYNC_STATUS = {
    IDLE: 'idle',
    DOWNLOADING: 'downloading',
    EXTRACTING: 'extracting',
    TRANSCRIBING: 'transcribing',
    ALIGNING: 'aligning',
    DONE: 'done',
    ERROR: 'error',
};

const CHUNK_DURATION = 15;
const MAX_CHUNK_ATTEMPTS = 8;
const MAX_RETRIES = 3;

const useWhisperSync = (extraSubtitlesTracks, selectedExtraSubtitlesTrackId, setSubtitlesDelay, streamingServerUrl, streamContent) => {
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
        const scriptUrl = `${origin}/${process.env.COMMIT_HASH}/scripts/whisperWorker.js`;
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

    const runSync = React.useCallback(async () => {
        const track = getSelectedTrack();
        if (!track || !streamContent || !streamingServerUrl) return;

        cancelledRef.current = false;
        setSyncStatus(SYNC_STATUS.EXTRACTING);
        setSyncProgress(0);
        setSyncError(null);
        setSyncResult(null);

        let lastError = null;

        for (let retry = 0; retry < MAX_RETRIES; retry++) {
            if (cancelledRef.current) return;

            let session = null;
            try {
                // Parse subtitle cues
                const cues = await fetchAndParseSubtitles(track);
                if (cancelledRef.current) return;
                if (!cues.length) throw new Error('No subtitle cues found');

                setSyncStatus(SYNC_STATUS.EXTRACTING);

                // Create audio session (fetches HLS playlist + init segment once)
                session = await createAudioSession(streamingServerUrl, streamContent);
                if (cancelledRef.current) return;

                // Density-ranked chunk offsets in chronological order — samples
                // the most dialogue-rich regions from anywhere in the video
                const chunkOffsets = findBestChunkOffsets(cues, CHUNK_DURATION, MAX_CHUNK_ATTEMPTS);

                // Create worker once per sync attempt — model stays loaded across chunks
                const worker = createWorker();

                // Accumulate matches across ALL chunks instead of per-chunk.
                // This lets us build confidence even when individual chunks
                // only produce 1-2 matches.
                const allOffsets = [];

                for (let attempt = 0; attempt < chunkOffsets.length; attempt++) {
                    if (cancelledRef.current) return;

                    const startTime = chunkOffsets[attempt];
                    setSyncStatus(SYNC_STATUS.EXTRACTING);

                    const audioData = await session.getChunk(startTime, CHUNK_DURATION);
                    if (cancelledRef.current) return;

                    const transcription = await transcribeAudio(worker, audioData);
                    if (cancelledRef.current) return;

                    setSyncStatus(SYNC_STATUS.ALIGNING);

                    const result = computeOffset(
                        transcription.chunks,
                        cues,
                        audioData.startTime * 1000,
                    );

                    // Collect individual match offsets from this chunk
                    if (result.matchCount > 0) {
                        // Re-derive the raw offsets from this chunk's transcription
                        for (const chunk of transcription.chunks) {
                            if (!chunk.text || !chunk.timestamp || chunk.timestamp[0] == null) continue;
                            const whisperStartMs = audioData.startTime * 1000 + chunk.timestamp[0] * 1000;
                            const match = findBestMatchExport(chunk.text, cues);
                            if (match) {
                                allOffsets.push(whisperStartMs - match.start);
                            }
                        }
                    }

                    if (allOffsets.length >= MIN_MATCHES_FOR_CONFIDENCE) {
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
                            totalChunks: attempt + 1,
                        });
                        setSyncStatus(SYNC_STATUS.DONE);
                        session.close();
                        return;
                    }

                    // Last chunk — move on to retry
                    if (attempt === chunkOffsets.length - 1) {
                        lastError = `Low confidence: only ${allOffsets.length} matches found. ` +
                            'Subtitle language may not match audio.';
                        setSyncResult({
                            offset: allOffsets.length > 0
                                ? allOffsets.sort((a, b) => a - b)[Math.floor(allOffsets.length / 2)]
                                : 0,
                            matchCount: allOffsets.length,
                            totalChunks: chunkOffsets.length,
                        });
                    }
                }

                session.close();
            } catch (error) {
                if (session) session.close();
                if (cancelledRef.current) return;
                lastError = error.message || 'Sync failed';
            }

            // Brief pause before retry
            if (retry < MAX_RETRIES - 1) {
                setSyncStatus(SYNC_STATUS.EXTRACTING);
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        // All retries exhausted
        if (!cancelledRef.current) {
            setSyncStatus(SYNC_STATUS.ERROR);
            setSyncError(lastError || 'Sync failed after multiple attempts');
        }
    }, [streamingServerUrl, streamContent, getSelectedTrack, createWorker, setSubtitlesDelay, transcribeAudio]);

    const startSync = React.useCallback(() => {
        runSync();
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
