import { pipeline, env } from '@huggingface/transformers';

// Enable browser Cache API so the model is stored locally after first download.
// Subsequent loads will be instant (no network requests).
env.useBrowserCache = true;
env.allowLocalModels = false;

let transcriber = null;
let activeDevice = null;

/**
 * Detect the best available device and matching dtype.
 * Prefers WebGPU (GPU acceleration) → falls back to WASM (CPU).
 */
async function detectDevice() {
    // Try WebGPU first
    if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const hasFp16 = adapter.features.has('shader-f16');
                return {
                    device: 'webgpu',
                    dtype: hasFp16 ? 'fp16' : 'fp32',
                };
            }
        } catch (_) { /* WebGPU not usable, fall through */ }
    }
    // Fallback: WASM with quantized model
    return { device: 'wasm', dtype: 'q8' };
}

async function loadModel(progressCallback) {
    if (transcriber) return transcriber;

    const { device, dtype } = await detectDevice();
    activeDevice = device;

    self.postMessage({
        type: 'status',
        status: 'downloading',
        device,
    });

    transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny',
        {
            dtype,
            device,
            progress_callback: (progress) => {
                if (progress.status === 'progress' && typeof progress.progress === 'number') {
                    progressCallback({
                        type: 'download_progress',
                        progress: Math.round(progress.progress),
                        cached: false,
                    });
                }
                // When loading from cache, status will be 'ready' almost instantly
                if (progress.status === 'ready') {
                    progressCallback({
                        type: 'download_progress',
                        progress: 100,
                        cached: true,
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
            const model = await loadModel((msg) => self.postMessage(msg));

            self.postMessage({
                type: 'status',
                status: 'transcribing',
                device: activeDevice,
            });

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
