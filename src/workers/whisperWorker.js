import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let transcriber = null;

async function loadModel(progressCallback) {
    if (transcriber) return transcriber;

    transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny',
        {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: (progress) => {
                if (progress.status === 'progress' && typeof progress.progress === 'number') {
                    progressCallback({
                        type: 'download_progress',
                        progress: Math.round(progress.progress),
                    });
                }
            },
        },
    );

    return transcriber;
}

self.addEventListener('message', async (event) => {
    const { type, audio, sampleRate } = event.data;

    if (type === 'transcribe') {
        try {
            self.postMessage({ type: 'status', status: 'downloading' });

            const model = await loadModel((msg) => self.postMessage(msg));

            self.postMessage({ type: 'status', status: 'transcribing' });

            const result = await model(audio, {
                sampling_rate: sampleRate || 16000,
                chunk_length_s: 30,
                stride_length_s: 5,
                return_timestamps: true,
                language: null,
                task: 'transcribe',
            });

            const chunks = (result.chunks || []).map((chunk) => ({
                text: chunk.text.trim(),
                timestamp: chunk.timestamp,
            }));

            self.postMessage({
                type: 'result',
                chunks,
                text: result.text,
            });
        } catch (error) {
            self.postMessage({
                type: 'error',
                error: error.message || 'Transcription failed',
            });
        }
    }

    if (type === 'dispose') {
        if (transcriber) {
            await transcriber.dispose();
            transcriber = null;
        }
        self.postMessage({ type: 'disposed' });
    }
});
