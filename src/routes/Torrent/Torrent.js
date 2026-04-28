// /torrent/<payload> — play-through route.
//
// The payload is base64url(JSON.stringify({infoHash, name, title, indexer,
// seeders, peers, size, quality})), produced by the addon's torrent-search
// handler.
//
// Normally: decode payload → POST /rd/files → if 1 playable video, straight
// to /rd/resolve → encode the returned HTTPS URL for stremio-core's Player
// and redirect. When `files.length > 1` we show a picker so the user
// chooses which file to play; the spinner only re-appears after selection.
//
// Fallback: if RD isn't configured or every step fails, we queue the magnet
// with the local streaming server and hand off an infoHash Stream to the
// Player (existing behaviour — preserved).
//
// No PIN gate here — this is the regular (non-Incognito) torrent play path
// used by the Prowlarr row in the main Search page.

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

// stremio-core's Stream::encode: serde_json → deflate → standard base64.
async function encodeStreamForCore(streamObj) {
    const json = JSON.stringify(streamObj);
    const compressed = await new Response(
        new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer();
    const bytes = new Uint8Array(compressed);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

const ADDON_URL = 'http://127.0.0.1:7000';
const RD_TOKEN_KEY = 'rd_token';

async function rdFiles(infoHash, title, token) {
    if (!token) return null;
    try {
        const res = await fetch(`${ADDON_URL}/rd/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ infoHash, title, token }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data.files) ? data.files : null;
    } catch { return null; }
}

// Lazy resolve a downloadUrl/magnetUrl → infoHash. Used when the catalog
// item came through without an enriched hash (ratio-limited / captcha /
// HTML-serving indexers often can't be enriched eagerly without blowing
// quotas; asking the addon to retry on click is cheap and avoids wasting
// daily quota on items the user never clicks).
//
// Returns one of:
//   { infoHash: '<40-hex>' }                         — resolved
//   { error: 'quota_exceeded', indexer, message }    — daily cap reached
//   { error: 'not_resolvable', message }             — hash truly unavailable
//   { error: 'network', message }                    — addon unreachable
async function resolveHashFromUrl({ downloadUrl, magnetUrl, indexer }) {
    try {
        const res = await fetch(`${ADDON_URL}/rd/resolve-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadUrl, magnetUrl, indexer }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && typeof data.infoHash === 'string' && /^[a-f0-9]{40}$/i.test(data.infoHash)) {
            return { infoHash: data.infoHash.toLowerCase() };
        }
        if (res.status === 429 && data && data.error === 'quota_exceeded') {
            const mins = typeof data.minutesRemaining === 'number' ? data.minutesRemaining : 60;
            return {
                error: 'quota_exceeded',
                indexer: data.indexer || indexer || '',
                minutesRemaining: mins,
                message: data.message || `${indexer || 'This indexer'} daily limit reached — try another indexer (retries in ~${mins}min)`,
            };
        }
        return {
            error: 'not_resolvable',
            message: (data && data.message) || 'Could not resolve this release',
        };
    } catch (err) {
        return { error: 'network', message: 'Addon unreachable' };
    }
}

async function rdResolve(infoHash, title, token, fileId) {
    if (!token) return null;
    try {
        const body = { infoHash, title, token };
        if (fileId) body.fileId = fileId;
        const res = await fetch(`${ADDON_URL}/rd/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data && typeof data.url === 'string' ? data : null;
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

function formatSize(size) {
    if (typeof size === 'string' && size.trim()) return size.trim();
    if (typeof size !== 'number' || !isFinite(size) || size <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = size;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 1 ? 1 : 0)} ${units[i]}`;
}

function tintFromHash(hash) {
    if (!hash || hash.length < 6) return 'rgb(30, 36, 48)';
    const r = parseInt(hash.slice(0, 2), 16) || 30;
    const g = parseInt(hash.slice(2, 4), 16) || 36;
    const b = parseInt(hash.slice(4, 6), 16) || 48;
    const mix = (c) => Math.max(20, Math.min(90, Math.round(c * 0.35 + 12)));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function decodePayload(urlParams) {
    const raw = urlParams && urlParams.payload;
    if (!raw) return null;
    const json = base64UrlDecode(decodeURIComponent(raw));
    if (!json) return null;
    try { return JSON.parse(json); } catch { return null; }
}

// Shorten `path/to/some/release/main-file.mkv` to `main-file.mkv` for the
// picker button label; fall back to the full path if no separator found.
function basename(p) {
    if (typeof p !== 'string') return '';
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

const Torrent = ({ urlParams }) => {
    const { core } = useServices();
    const [error, setError] = React.useState(null);
    const [status, setStatus] = React.useState('Starting...');

    // Multi-file picker state. `files === null` while we haven't asked RD
    // yet; an empty array means we asked and got nothing playable (fall
    // through to magnet).
    const [files, setFiles] = React.useState(null);
    const [picking, setPicking] = React.useState(false);

    const ranRef = React.useRef(false);
    const startedMagnetRef = React.useRef(false);
    // Mirrors the current infoHash state so the play* callbacks — which
    // are memoised before lazy resolution completes — can read the latest
    // value without waiting for a re-render cycle.
    const hashRef = React.useRef('');

    const payload = React.useMemo(() => decodePayload(urlParams), [urlParams]);
    const payloadHash = payload && typeof payload.infoHash === 'string'
        ? payload.infoHash.toLowerCase() : '';
    // infoHash is stateful because catalog items without server-side
    // enrichment arrive hash-less; we lazy-resolve via /rd/resolve-url on
    // mount and then flip the state so downstream RD/magnet callbacks
    // re-memo with the resolved value.
    const [infoHash, setInfoHashState] = React.useState(payloadHash);
    // Seed the ref so SSR / first paint can reference it before the effect
    // runs; kept in sync with state via setInfoHash below.
    if (hashRef.current === '' && payloadHash) hashRef.current = payloadHash;
    const setInfoHash = React.useCallback((h) => {
        hashRef.current = h || '';
        setInfoHashState(h || '');
    }, []);
    const title = (payload && (payload.name || payload.title)) || 'Torrent';
    const tint = React.useMemo(() => tintFromHash(infoHash || payloadHash), [infoHash, payloadHash]);
    const sizeStr = payload ? formatSize(payload.size) : '';
    const seeders = payload && typeof payload.seeders === 'number' ? payload.seeders : null;
    const peers = payload && typeof payload.peers === 'number' ? payload.peers : null;
    const quality = payload && payload.quality ? String(payload.quality) : '';
    const indexer = payload && payload.indexer ? String(payload.indexer) : '';

    const fromIncognito = typeof document !== 'undefined' &&
        (document.referrer || '').includes('/incognito');

    // Fallback path: queue magnet in streaming server, encode an infoHash
    // Stream, hand off to the Player. Reads `hashRef` (not the state
    // closure) so a lazy-resolved hash from /rd/resolve-url is visible
    // even if the callback was memoised before the state flipped.
    const playViaMagnet = React.useCallback(async () => {
        if (startedMagnetRef.current) return;
        startedMagnetRef.current = true;
        const hash = hashRef.current;
        if (!hash) { setError('Missing infoHash — cannot queue torrent.'); return; }
        setStatus('Queuing torrent in streaming server...');
        try {
            core.transport.dispatch({
                action: 'StreamingServer',
                args: { action: 'CreateTorrent', args: buildMagnet(hash, title) }
            });
        } catch (err) {
            console.error('[torrent-route] CreateTorrent dispatch failed', err);
        }

        const streamObj = {
            name: payload?.name || 'Torrent',
            description: title || 'Torrent',
            infoHash: hash,
            announce: DEFAULT_TRACKERS,
            behaviorHints: { bingeGroup: `torrent:${hash}` }
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
                return;
            }
        } catch (err) {
            setError('Stremio threw decoding the stream (see DevTools console).');
            console.error('[torrent-route] decodeStream threw', err);
            return;
        }
        window.location.replace(`#/player/${encodeURIComponent(encoded)}`);
    }, [core, title, payload]);

    // RD resolve path (optionally with fileId). On success redirects to
    // /player; on failure falls back to magnet.
    const playViaRD = React.useCallback(async (fileId) => {
        setPicking(false);
        setStatus('Resolving via Real-Debrid...');
        const hash = hashRef.current;
        if (!hash) { await playViaMagnet(); return; }
        let token = '';
        try { token = localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { /* ignore */ }
        if (!token) {
            await playViaMagnet();
            return;
        }
        const rd = await rdResolve(hash, title, token, fileId);
        if (!rd || !rd.url) {
            await playViaMagnet();
            return;
        }
        const rdStream = {
            name: payload?.name || 'RD',
            description: rd.filename || title || 'Torrent',
            url: rd.url,
            behaviorHints: { bingeGroup: `torrent-rd:${hash}` },
        };
        try {
            const rdEncoded = await encodeStreamForCore(rdStream);
            const decoded = await core.transport.decodeStream(rdEncoded);
            if (decoded) {
                window.location.replace(`#/player/${encodeURIComponent(rdEncoded)}`);
                return;
            }
            console.warn('[torrent-route] RD decodeStream returned null');
        } catch (err) {
            console.warn('[torrent-route] RD encode/decodeStream failed', err);
        }
        await playViaMagnet();
    }, [core, title, payload, playViaMagnet]);

    React.useEffect(() => {
        if (ranRef.current) return;
        ranRef.current = true;

        (async () => {
            if (!payload) { setError('Invalid torrent payload'); return; }

            // Lazy-resolve the hash if the catalog entry arrived without
            // one (adult indexers frequently return HTML instead of
            // .torrent bytes, breaking the server-side enrichment step).
            let hash = infoHash;
            if (!hash || hash.length < 16) {
                // We deliberately do NOT short-circuit on payload.cold here.
                // The frontend caches catalog metas in localStorage for hours,
                // which means a stale `cold: true` flag from a previous
                // (over-eager) version of the addon would lock the user out
                // of every release on that indexer until cache expiry — even
                // after the addon was fixed. Always go through the resolver
                // so the live cold state on the addon is what matters.
                const dl = payload.downloadUrl || '';
                const mag = payload.magnetUrl || '';
                if (!dl && !mag) { setError('Torrent has no infoHash'); return; }
                setStatus('Resolving release…');
                const resolved = await resolveHashFromUrl({
                    downloadUrl: dl,
                    magnetUrl: mag,
                    indexer: payload.indexer || '',
                });
                if (resolved && resolved.infoHash) {
                    hash = resolved.infoHash;
                    setInfoHash(resolved.infoHash);
                } else if (resolved && resolved.error === 'quota_exceeded') {
                    // PornoLab-style daily cap. Show a distinct, actionable
                    // message so the user knows exactly what went wrong and
                    // can pick a different indexer instead of retrying.
                    setError(resolved.message);
                    return;
                } else {
                    setError((resolved && resolved.message) || 'This release could not be resolved to a magnet. Try another result.');
                    return;
                }
            }

            let token = '';
            try { token = localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { /* ignore */ }

            // No RD token → skip the file enumeration round-trip entirely.
            if (!token) {
                await playViaMagnet();
                return;
            }

            setStatus('Checking Real-Debrid…');
            const list = await rdFiles(hash, title, token);
            if (!Array.isArray(list) || list.length === 0) {
                // RD failed or returned nothing usable — let resolve try its
                // own path (it may still succeed; otherwise playViaRD falls
                // through to magnet).
                await playViaRD(null);
                return;
            }

            const videos = list.filter(f => f.isVideo);
            if (videos.length <= 1) {
                // Single playable video (or none identified — resolve will
                // pick the biggest file as fallback). No picker needed.
                await playViaRD(null);
                return;
            }

            // Multiple videos → show picker.
            setFiles(videos);
            setPicking(true);
            setStatus('Choose a video to play');
        })();
    }, [payload, infoHash, title, playViaRD, playViaMagnet]);

    const handlePick = React.useCallback((fileId) => {
        playViaRD(fileId);
    }, [playViaRD]);

    return (
        <MainNavBars route={fromIncognito ? 'incognito' : 'search'}>
            <div className={styles['resolving-root']}>
                <div
                    className={styles['resolving-backdrop']}
                    style={{ backgroundColor: tint }}
                />
                {/* HeroBanner-style animated sheen over the tint */}
                <div className={styles['resolving-shimmer']} />
                <div className={styles['resolving-gradient-bottom']} />
                <div className={styles['resolving-gradient-left']} />

                <div className={styles['resolving-content']}>
                    <div className={styles['resolving-title']} title={title}>{title}</div>
                    <div className={classnames(styles['resolving-status'], error && styles['error'])}>
                        {error || picking ? null : <span className={styles['resolving-spinner']} aria-hidden="true" />}
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

                    {picking && files && files.length > 1 ? (
                        <div className={styles['file-picker']}>
                            <div className={styles['file-picker-hint']}>
                                {files.length} videos in this torrent — pick one:
                            </div>
                            <div className={styles['file-picker-list']}>
                                {files.map((f) => (
                                    <button
                                        key={f.id}
                                        className={styles['file-picker-item']}
                                        onClick={() => handlePick(f.id)}
                                        type="button"
                                    >
                                        <span className={styles['file-picker-name']}>{basename(f.path)}</span>
                                        <span className={styles['file-picker-size']}>{formatSize(f.bytes)}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        </MainNavBars>
    );
};

module.exports = Torrent;
