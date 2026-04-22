// /torrent/<payload> — thin play-through route.
//
// The payload is base64url(JSON.stringify({infoHash, name, title, indexer,
// seeders, peers, size, quality})), produced by the addon's torrent-search
// handler. We:
//   1. Decode the payload.
//   2. Build a magnet URI and tell stremio-core's streaming server to queue it.
//   3. Redirect to #/player/<encoded-stream>.
//
// No PIN gate here — this is the regular (non-Incognito) torrent play path
// used by the Prowlarr row in the main Search page.
//
// The visible UI while that's happening is a HeroBanner-style layered
// gradient backdrop with the torrent's details (indexer, seeders, leechers,
// size, quality) surfaced as badges, so the user isn't staring at a blank
// "Resolving..." string during the 1–5 s Real-Debrid round-trip.

const React = require('react');
const classnames = require('classnames');
const { useServices } = require('stremio/services');
const { MainNavBars } = require('stremio/components');
const styles = require('./styles.less');

function base64UrlDecode(s) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    try {
        const utf8 = atob(b64);
        return decodeURIComponent(escape(utf8));
    } catch {
        return null;
    }
}

// Stream encoding for stremio-core's Player.
//
// stremio-core's Rust code (types/resource/stream.rs Stream::encode) does:
//   1. serde_json::to_string(stream)
//   2. zlib-deflate (RFC 1950, with header + adler32)
//   3. STANDARD base64 (not base64url) with '=' padding, '+'/'/' alphabet
// stremio-core-web does NOT expose the symmetric `encodeStream` via
// wasm_bindgen, so we replicate it here. The native CompressionStream API
// (Chrome/Edge 80+, Firefox 113+, Safari 16.4+) gives us deflate with the
// correct zlib wrapper — no pako dependency needed.
async function encodeStreamForCore(streamObj) {
    const json = JSON.stringify(streamObj);
    const compressed = await new Response(
        new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer();
    const bytes = new Uint8Array(compressed);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    // Plain btoa — DO NOT url-safe this. stremio-core's base64 decoder is
    // the STANDARD alphabet and rejects '-'/'_'. Percent-encode for the
    // URL fragment so '+' and '/' survive the router.
    return btoa(binary);
}

const ADDON_URL = 'http://127.0.0.1:7000';
const RD_TOKEN_KEY = 'rd_token';

async function resolveViaRD(infoHash, title) {
    let token = '';
    try { token = localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { /* ignore */ }
    if (!token) return null;
    try {
        const res = await fetch(`${ADDON_URL}/rd/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ infoHash, title, token }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && typeof data.url === 'string') return data;
        return null;
    } catch { return null; }
}

const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce'
];

function buildMagnet(infoHash, title) {
    const dn = title ? `&dn=${encodeURIComponent(title)}` : '';
    const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

// Format a size value that may be either a number of bytes (preferred, sent
// by the updated addon) or a preformatted string (legacy).
function formatSize(size) {
    if (typeof size === 'string' && size.trim()) return size.trim();
    if (typeof size !== 'number' || !isFinite(size) || size <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = size;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 1 ? 1 : 0)} ${units[i]}`;
}

// Derive a stable tint from the first 6 hex chars of infoHash so the
// backdrop is visually distinct per-torrent without a network fetch.
function tintFromHash(hash) {
    if (!hash || hash.length < 6) return 'rgb(30, 36, 48)';
    const r = parseInt(hash.slice(0, 2), 16) || 30;
    const g = parseInt(hash.slice(2, 4), 16) || 36;
    const b = parseInt(hash.slice(4, 6), 16) || 48;
    const mix = (c) => Math.max(20, Math.min(90, Math.round(c * 0.35 + 12)));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Decode the payload eagerly so render has something to show immediately.
function decodePayload(urlParams) {
    const raw = urlParams && urlParams.payload;
    if (!raw) return null;
    const json = base64UrlDecode(decodeURIComponent(raw));
    if (!json) return null;
    try { return JSON.parse(json); } catch { return null; }
}

const Torrent = ({ urlParams }) => {
    const { core } = useServices();
    const [error, setError] = React.useState(null);
    const [status, setStatus] = React.useState('Starting...');
    const ranRef = React.useRef(false);

    const payload = React.useMemo(() => decodePayload(urlParams), [urlParams]);
    const infoHash = payload && typeof payload.infoHash === 'string'
        ? payload.infoHash.toLowerCase() : '';
    const title = (payload && (payload.name || payload.title)) || 'Torrent';
    const tint = React.useMemo(() => tintFromHash(infoHash), [infoHash]);
    const sizeStr = payload ? formatSize(payload.size) : '';
    const seeders = payload && typeof payload.seeders === 'number' ? payload.seeders : null;
    const peers = payload && typeof payload.peers === 'number' ? payload.peers : null;
    const quality = payload && payload.quality ? String(payload.quality) : '';
    const indexer = payload && payload.indexer ? String(payload.indexer) : '';

    // If the previous hash was /incognito/* keep that nav highlighted so
    // clicking Back from Player returns to the incognito tab visually.
    const fromIncognito = typeof document !== 'undefined' &&
        (document.referrer || '').includes('/incognito');

    React.useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        (async () => {
            if (!payload) { setError('Invalid torrent payload'); return; }
            if (!infoHash || infoHash.length < 16) { setError('Torrent has no infoHash'); return; }

            // Try Real-Debrid first (HTTPS URL, no local torrenting).
            setStatus('Resolving via Real-Debrid...');
            const rd = await resolveViaRD(infoHash, title);
            if (rd && rd.url) {
                const rdStream = {
                    name: payload.name || 'RD',
                    description: rd.filename || title || 'Torrent',
                    url: rd.url,
                    behaviorHints: { bingeGroup: `torrent-rd:${infoHash}` },
                };
                try {
                    const rdEncoded = await encodeStreamForCore(rdStream);
                    const decoded = await core.transport.decodeStream(rdEncoded);
                    if (decoded) {
                        // encodeURIComponent so standard-base64's '+' and '/' survive the URL fragment.
                        window.location.replace(`#/player/${encodeURIComponent(rdEncoded)}`);
                        return;
                    }
                    console.warn('[torrent-route] RD decodeStream returned null for', rdStream);
                } catch (err) {
                    console.warn('[torrent-route] RD encode/decodeStream failed, falling back to magnet', err);
                }
            }

            // Queue the torrent in the streaming server (fallback).
            setStatus('Queuing torrent in streaming server...');
            try {
                core.transport.dispatch({
                    action: 'StreamingServer',
                    args: { action: 'CreateTorrent', args: buildMagnet(infoHash, title) }
                });
            } catch (err) {
                console.error('[torrent-route] CreateTorrent dispatch failed', err);
            }

            // Stream shape matching stremio-core's Stream::Torrent variant.
            // `announce` is required for serde to pick the Torrent variant.
            const streamObj = {
                name: payload.name || 'Torrent',
                description: title || 'Torrent',
                infoHash,
                announce: DEFAULT_TRACKERS,
                behaviorHints: { bingeGroup: `torrent:${infoHash}` }
            };
            let encoded;
            try {
                encoded = await encodeStreamForCore(streamObj);
            } catch (err) {
                setError('Failed to encode stream payload (see DevTools console).');
                console.error('[torrent-route] encodeStreamForCore threw', err);
                return;
            }

            try {
                const decoded = await core.transport.decodeStream(encoded);
                if (!decoded) {
                    setError('Stremio rejected the stream payload (see DevTools console).');
                    console.error('[torrent-route] decodeStream returned null for', streamObj);
                    return;
                }
            } catch (err) {
                setError('Stremio threw decoding the stream (see DevTools console).');
                console.error('[torrent-route] decodeStream threw', err);
                return;
            }

            window.location.replace(`#/player/${encodeURIComponent(encoded)}`);
        })();
    }, [core, payload, infoHash, title]);

    return (
        <MainNavBars route={fromIncognito ? 'incognito' : 'search'}>
            <div className={styles['resolving-root']}>
                <div
                    className={styles['resolving-backdrop']}
                    style={{ backgroundColor: tint }}
                />
                <div className={styles['resolving-gradient-bottom']} />
                <div className={styles['resolving-gradient-left']} />

                <div className={styles['resolving-content']}>
                    <div className={styles['resolving-title']} title={title}>{title}</div>
                    <div className={classnames(styles['resolving-status'], error && styles['error'])}>
                        {error ? null : <span className={styles['resolving-spinner']} aria-hidden="true" />}
                        <span>{error ? `Error: ${error}` : status}</span>
                    </div>

                    <div className={styles['resolving-badges']}>
                        {seeders !== null ? (
                            <div className={classnames(styles['badge'], styles['badge-seed'])}>
                                <span className={styles['badge-label']}>Seeders</span>
                                <span className={styles['badge-value']}>{seeders}</span>
                            </div>
                        ) : null}
                        {peers !== null ? (
                            <div className={classnames(styles['badge'], styles['badge-peer'])}>
                                <span className={styles['badge-label']}>Leechers</span>
                                <span className={styles['badge-value']}>{peers}</span>
                            </div>
                        ) : null}
                        {sizeStr ? (
                            <div className={styles['badge']}>
                                <span className={styles['badge-label']}>Size</span>
                                <span className={styles['badge-value']}>{sizeStr}</span>
                            </div>
                        ) : null}
                        {quality ? (
                            <div className={styles['badge']}>
                                <span className={styles['badge-label']}>Quality</span>
                                <span className={styles['badge-value']}>{quality}</span>
                            </div>
                        ) : null}
                        {indexer ? (
                            <div className={styles['badge']}>
                                <span className={styles['badge-label']}>Source</span>
                                <span className={styles['badge-value']}>{indexer}</span>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </MainNavBars>
    );
};

module.exports = Torrent;
