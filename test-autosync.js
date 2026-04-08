/**
 * Auto-Sync Diagnostic Test
 *
 * Run this in the browser console while watching a video in Stremio.
 * It will test each step of the subtitle sync pipeline and report
 * what works and what fails.
 *
 * Usage: paste this entire script into the DevTools console.
 */
(async function() {
    const SIDECAR_URL = 'http://127.0.0.1:12471';
    const STREAMING_SERVER = 'http://127.0.0.1:11470';
    const CORS_PROXY = 'http://127.0.0.1:12470';

    const results = {};
    function log(label, status, detail) {
        const icon = status === 'OK' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
        console.log(`${icon} [${label}] ${detail || ''}`);
        results[label] = { status, detail };
    }

    // ══════════════════════════════════════════════════
    //  Step 1: Check services
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 1: Service Health ══════');

    // Streaming server
    try {
        const r = await fetch(STREAMING_SERVER + '/settings', { signal: AbortSignal.timeout(3000) });
        log('Streaming Server (11470)', r.ok ? 'OK' : 'FAIL', `Status ${r.status}`);
    } catch(e) {
        log('Streaming Server (11470)', 'FAIL', e.message);
    }

    // CORS proxy
    try {
        const r = await fetch(CORS_PROXY + '/settings', { signal: AbortSignal.timeout(3000) });
        log('CORS Proxy (12470)', r.ok ? 'OK' : 'FAIL', `Status ${r.status}`);
    } catch(e) {
        log('CORS Proxy (12470)', 'FAIL', e.message);
    }

    // Sidecar
    try {
        const r = await fetch(SIDECAR_URL + '/health', { signal: AbortSignal.timeout(3000) });
        const data = await r.json();
        log('Sidecar (12471)', r.ok ? 'OK' : 'FAIL', `FFmpeg: ${data.ffmpeg}`);
    } catch(e) {
        log('Sidecar (12471)', 'FAIL', e.message);
    }

    // ══════════════════════════════════════════════════
    //  Step 2: Find the active video element
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 2: Active Video ══════');

    const video = document.querySelector('video');
    if (!video) {
        log('Video Element', 'FAIL', 'No <video> element found. Are you watching something?');
        return results;
    }
    log('Video Element', 'OK', `src=${video.src ? video.src.substring(0, 120) + '...' : 'blob/MSE'}`);
    log('Video Duration', 'OK', `${Math.round(video.duration)}s (${(video.duration/60).toFixed(1)} min)`);
    log('Video Current Time', 'OK', `${Math.round(video.currentTime)}s`);

    // Check if video uses MSE (MediaSource)
    if (video.src && video.src.startsWith('blob:')) {
        log('Video Source Type', 'INFO', 'Uses MediaSource Extensions (MSE/blob URL)');
    } else if (video.src) {
        log('Video Source Type', 'INFO', `Direct URL: ${video.src.substring(0, 200)}`);
    }

    // ══════════════════════════════════════════════════
    //  Step 3: Check active HLS sessions on streaming server
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 3: Active Streaming Sessions ══════');

    // Check network requests for HLS URLs
    const perfEntries = performance.getEntriesByType('resource')
        .filter(e => e.name.includes('hlsv2') || e.name.includes('/proxy/') || e.name.includes('11470') || e.name.includes('12470'))
        .slice(-20);

    if (perfEntries.length > 0) {
        console.log('Recent streaming requests:');
        perfEntries.forEach(e => {
            const url = new URL(e.name);
            console.log(`  ${url.port}${url.pathname.substring(0, 80)}... (${Math.round(e.duration)}ms)`);
        });
    }

    // Try to find the active HLS session by looking at network requests
    const hlsEntries = perfEntries.filter(e => e.name.includes('hlsv2'));
    let activeHlsSession = null;
    if (hlsEntries.length > 0) {
        const match = hlsEntries[0].name.match(/hlsv2\/([^/]+)\//);
        if (match) {
            activeHlsSession = match[1];
            log('Active HLS Session', 'OK', `Session ID: ${activeHlsSession}`);
        }
    }

    // ══════════════════════════════════════════════════
    //  Step 4: Get stream content from player state
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 4: Stream Content ══════');

    // Try to access the Stremio core state to get streamContent
    let streamContent = null;
    try {
        // The player state is stored in the stremio core
        // Try to find it via the global state or DOM
        const stateEl = document.querySelector('[data-stream]');
        if (stateEl) {
            streamContent = JSON.parse(stateEl.dataset.stream);
        }
    } catch(e) {}

    // Fallback: try to extract from URL params
    if (!streamContent) {
        try {
            const urlParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
            const streamParam = urlParams.get('stream');
            if (streamParam) {
                streamContent = JSON.parse(atob(streamParam));
                log('Stream Content (from URL)', 'OK', JSON.stringify(streamContent).substring(0, 200));
            }
        } catch(e) {}
    }

    if (!streamContent) {
        log('Stream Content', 'WARN', 'Could not auto-detect. Will test with proxy URL patterns from network.');
    }

    // ══════════════════════════════════════════════════
    //  Step 5: Test URL formats against streaming server
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 5: URL Format Tests ══════');

    // Find any proxy URL from network entries
    const proxyEntries = perfEntries.filter(e => e.name.includes('/proxy/'));
    let proxyUrl = null;
    if (proxyEntries.length > 0) {
        proxyUrl = proxyEntries[0].name;
        // Convert to streaming server URL if it's going through CORS proxy
        proxyUrl = proxyUrl.replace(':12470', ':11470');
        log('Proxy URL Found', 'OK', proxyUrl.substring(0, 150) + '...');
    }

    // Test A: Direct streaming server stats
    try {
        const r = await fetch(CORS_PROXY + '/stats.json', { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
            const stats = await r.json();
            log('Server Stats', 'OK', JSON.stringify(stats).substring(0, 200));
        } else {
            log('Server Stats', 'FAIL', `Status ${r.status}`);
        }
    } catch(e) {
        log('Server Stats', 'FAIL', e.message);
    }

    // Test B: If we found a proxy URL, test fetching a tiny range from it
    if (proxyUrl) {
        try {
            const testUrl = proxyUrl.replace(':11470', ':12470'); // Use CORS proxy for browser
            const r = await fetch(testUrl, {
                headers: { 'Range': 'bytes=0-1023' },
                signal: AbortSignal.timeout(10000)
            });
            log('Proxy URL Fetch', r.ok || r.status === 206 ? 'OK' : 'FAIL',
                `Status ${r.status}, ${r.headers.get('content-type')}`);
        } catch(e) {
            log('Proxy URL Fetch', 'FAIL', e.message);
        }
    }

    // Test C: Test HLS transcoder with a known-good source (public test stream)
    const testHlsId = 'diag_test_' + Math.random().toString(36).slice(2);
    const publicTestUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    try {
        const hlsTestUrl = `${CORS_PROXY}/hlsv2/${testHlsId}/master.m3u8?` +
            new URLSearchParams({ mediaURL: publicTestUrl, videoCodecs: 'h264', audioCodecs: 'aac' });
        const r = await fetch(hlsTestUrl, { signal: AbortSignal.timeout(15000) });
        if (r.ok) {
            const text = await r.text();
            log('HLS Transcoder (public URL)', 'OK', `Playlist lines: ${text.split('\n').length}`);
        } else {
            const body = await r.text().catch(() => '');
            log('HLS Transcoder (public URL)', 'FAIL', `Status ${r.status}: ${body.substring(0, 100)}`);
        }
    } catch(e) {
        log('HLS Transcoder (public URL)', 'FAIL', e.message);
    }

    // Test D: If we have a proxy URL, test HLS transcoder with it
    if (proxyUrl) {
        const hlsId2 = 'diag_proxy_' + Math.random().toString(36).slice(2);
        try {
            const hlsUrl = `${CORS_PROXY}/hlsv2/${hlsId2}/master.m3u8?` +
                new URLSearchParams({ mediaURL: proxyUrl, videoCodecs: 'h264', audioCodecs: 'aac', maxAudioChannels: '1' });
            const r = await fetch(hlsUrl, { signal: AbortSignal.timeout(15000) });
            if (r.ok) {
                const text = await r.text();
                log('HLS Transcoder (proxy URL)', 'OK', `Playlist lines: ${text.split('\n').length}`);
            } else {
                const body = await r.text().catch(() => '');
                log('HLS Transcoder (proxy URL)', 'FAIL', `Status ${r.status}: ${body.substring(0, 100)}`);
            }
        } catch(e) {
            log('HLS Transcoder (proxy URL)', 'FAIL', e.message);
        }
    }

    // ══════════════════════════════════════════════════
    //  Step 6: Test sidecar audio extraction
    // ══════════════════════════════════════════════════
    console.log('\n══════ STEP 6: Sidecar Audio Extraction ══════');

    // Test E: Extract audio via sidecar with a public test URL
    try {
        const testMediaUrl = publicTestUrl;
        const params = new URLSearchParams({ mediaURL: testMediaUrl, start: '0', duration: '3' });
        const r = await fetch(`${SIDECAR_URL}/audio-extract?${params}`, { signal: AbortSignal.timeout(15000) });
        if (r.ok) {
            const buf = await r.arrayBuffer();
            const samples = buf.byteLength / 4;
            const duration = samples / 16000;
            log('Sidecar Extract (public HLS)', 'OK', `${buf.byteLength} bytes, ${duration.toFixed(1)}s audio`);
        } else {
            const body = await r.text().catch(() => '');
            log('Sidecar Extract (public HLS)', 'FAIL', `Status ${r.status}: ${body.substring(0, 150)}`);
        }
    } catch(e) {
        log('Sidecar Extract (public HLS)', 'FAIL', e.message);
    }

    // Test F: Extract audio via sidecar with the proxy URL (current stream)
    if (proxyUrl) {
        try {
            const params = new URLSearchParams({ mediaURL: proxyUrl, start: '30', duration: '5' });
            const r = await fetch(`${SIDECAR_URL}/audio-extract?${params}`, { signal: AbortSignal.timeout(15000) });
            if (r.ok) {
                const buf = await r.arrayBuffer();
                log('Sidecar Extract (proxy URL)', 'OK', `${buf.byteLength} bytes`);
            } else {
                const body = await r.text().catch(() => '');
                log('Sidecar Extract (proxy URL)', 'FAIL', `Status ${r.status}: ${body.substring(0, 150)}`);
            }
        } catch(e) {
            log('Sidecar Extract (proxy URL)', 'FAIL', e.message);
        }
    }

    // Test G: Extract audio via sidecar using HLS transcoder URL
    if (proxyUrl) {
        const hlsId3 = 'diag_ffmpeg_' + Math.random().toString(36).slice(2);
        const hlsMediaUrl = `${STREAMING_SERVER}/hlsv2/${hlsId3}/master.m3u8?` +
            new URLSearchParams({ mediaURL: proxyUrl, videoCodecs: 'h264', audioCodecs: 'aac', maxAudioChannels: '1' });
        try {
            const params = new URLSearchParams({ mediaURL: hlsMediaUrl, start: '0', duration: '3' });
            const r = await fetch(`${SIDECAR_URL}/audio-extract?${params}`, { signal: AbortSignal.timeout(30000) });
            if (r.ok) {
                const buf = await r.arrayBuffer();
                log('Sidecar Extract (HLS URL)', 'OK', `${buf.byteLength} bytes`);
            } else {
                const body = await r.text().catch(() => '');
                log('Sidecar Extract (HLS URL)', 'FAIL', `Status ${r.status}: ${body.substring(0, 150)}`);
            }
        } catch(e) {
            log('Sidecar Extract (HLS URL)', 'FAIL', e.message);
        }
    }

    // Test H: Try to reuse the ACTIVE HLS session (if found)
    if (activeHlsSession) {
        // Find the actual master.m3u8 URL from network entries
        const masterEntry = hlsEntries.find(e => e.name.includes('master.m3u8'));
        if (masterEntry) {
            // Get the audio playlist from the master
            const masterUrl = masterEntry.name.replace(':12470', ':11470');
            log('Active Session Master URL', 'INFO', masterUrl.substring(0, 150));

            try {
                const params = new URLSearchParams({ mediaURL: masterUrl, start: '0', duration: '3' });
                const r = await fetch(`${SIDECAR_URL}/audio-extract?${params}`, { signal: AbortSignal.timeout(30000) });
                if (r.ok) {
                    const buf = await r.arrayBuffer();
                    log('Sidecar Extract (active session)', 'OK', `${buf.byteLength} bytes`);
                } else {
                    const body = await r.text().catch(() => '');
                    log('Sidecar Extract (active session)', 'FAIL', `Status ${r.status}: ${body.substring(0, 150)}`);
                }
            } catch(e) {
                log('Sidecar Extract (active session)', 'FAIL', e.message);
            }
        }
    }

    // ══════════════════════════════════════════════════
    //  Summary
    // ══════════════════════════════════════════════════
    console.log('\n══════ SUMMARY ══════');
    const passed = Object.values(results).filter(r => r.status === 'OK').length;
    const failed = Object.values(results).filter(r => r.status === 'FAIL').length;
    console.log(`${passed} passed, ${failed} failed, ${Object.keys(results).length} total`);

    console.log('\n📋 Copy this summary and share it:');
    console.log(JSON.stringify(results, null, 2));

    return results;
})();
