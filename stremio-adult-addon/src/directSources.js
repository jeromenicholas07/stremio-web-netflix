// Direct torrent-search adapters — the qBittorrent-plugin model.
//
// Each adapter queries ONE fast, non-Cloudflare JSON API and maps the
// response to the addon's normalized item shape (the same shape
// `searchProwlarr` returns and `itemToMeta` consumes):
//
//   { title, link, guid, pubDate, size, seeders, peers, infoHash,
//     magnetUrl, downloadUrl, category, poster, indexer }
//
// Adapters are failure-isolated: any error/timeout/bad-shape yields []
// (the orchestrator also wraps them, belt-and-braces). Adding a provider
// later is just one more object in SOURCES.
//
// Cloudflare-walled sites (1337x, TorrentGalaxy, …) deliberately do NOT
// belong here — they need FlareSolverr and would reintroduce the slowness
// we're removing. Those stay under Prowlarr (the background supplement).

const fetch = require('node-fetch');

const FETCH_TIMEOUT_MS = 5000;

// Standard public trackers appended to magnets built from a bare infoHash.
const PUBLIC_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
];

function isHash40(s) {
    return typeof s === 'string' && /^[a-f0-9]{40}$/i.test(s);
}

function buildMagnet(infoHash, name) {
    const tr = PUBLIC_TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || infoHash)}${tr}`;
}

// Map a loose source record into the addon's normalized item shape.
// Returns null if there's no usable 40-hex infoHash — direct sources are
// only worth surfacing when the result is immediately playable.
function normalize({ title, infoHash, seeders, peers, size, pubDate, indexer }) {
    const hash = isHash40(infoHash) ? String(infoHash).toLowerCase() : '';
    if (!hash) return null;
    const name = title || '';
    const magnetUrl = buildMagnet(hash, name);
    return {
        title: name,
        link: magnetUrl,
        guid: hash,
        pubDate: pubDate || '',
        size: Number(size) || 0,
        seeders: Number(seeders) || 0,
        peers: Number(peers) || 0,
        infoHash: hash,
        magnetUrl,
        downloadUrl: '',
        category: '',
        poster: '',
        indexer: indexer || '',
    };
}

// ─── apibay (The Pirate Bay JSON API) ───────────────────────────────────
// https://apibay.org/q.php?q=<query>&cat=<cat>  → JSON array.
// cat 500 = Porn; cat 0 = all categories. The no-results response is a
// single object with id "0" / an all-zero info_hash — filtered out.
async function searchApibay({ query, cat }) {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${encodeURIComponent(cat)}`;
    const res = await fetch(url, {
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const r of data) {
        if (!r || String(r.id) === '0') continue;
        if (/^0+$/.test(r.info_hash || '')) continue;
        const item = normalize({
            title: r.name,
            infoHash: r.info_hash,
            seeders: r.seeders,
            peers: r.leechers,
            size: r.size,
            pubDate: r.added ? Number(r.added) * 1000 : '',
            indexer: 'ThePirateBay',
        });
        if (item) out.push(item);
    }
    return out;
}

// ─── Knaben (torrent-search aggregator, indexes 300+ trackers) ───────────
// POST https://api.knaben.org/v1 with a JSON body → { hits: [...] }.
// Knaben uses the infoHash as the record `id`; `hash` and `magnetUrl` are
// frequently null, so we fall back id → hash → magnet. For adult searches
// we scope to Knaben category 5000000 (XXX).
async function searchKnaben({ query, cat }) {
    const body = {
        query,
        order_by: 'seeders',
        order_direction: 'desc',
        size: 100,
        hide_unsafe: false,
    };
    if (cat === 500) body.categories = [5000000];
    const res = await fetch('https://api.knaben.org/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        timeout: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const hits = data && Array.isArray(data.hits) ? data.hits : [];
    const out = [];
    for (const h of hits) {
        let hash = isHash40(h.hash) ? h.hash : (isHash40(h.id) ? h.id : '');
        if (!hash && typeof h.magnetUrl === 'string') {
            const m = h.magnetUrl.match(/btih:([a-f0-9]{40})/i);
            if (m) hash = m[1];
        }
        const item = normalize({
            title: h.title,
            infoHash: hash,
            seeders: h.seeders,
            peers: h.peers,
            size: h.bytes,
            pubDate: h.date || '',
            indexer: h.tracker ? `Knaben/${h.tracker}` : 'Knaben',
        });
        if (item) out.push(item);
    }
    return out;
}

// ─── Torrents-CSV (clean, fast, static torrent database) ─────────────────
// https://torrents-csv.com/service/search?q=<query>  → { torrents: [...] }.
// Mostly general content (little adult) — contributes most to the generic
// torrent-search catalog; harmless (returns ~empty) on adult queries.
async function searchTorrentsCsv({ query }) {
    const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=100`;
    const res = await fetch(url, {
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data && Array.isArray(data.torrents) ? data.torrents : [];
    const out = [];
    for (const t of list) {
        const item = normalize({
            title: t.name,
            infoHash: t.infohash,
            seeders: t.seeders,
            peers: t.leechers,
            size: t.size_bytes,
            pubDate: t.created_unix ? Number(t.created_unix) * 1000 : '',
            indexer: 'Torrents-CSV',
        });
        if (item) out.push(item);
    }
    return out;
}

// ─── Adapter registry ────────────────────────────────────────────────────
// Each adapter: { id, label, search({ query, cat }) -> Promise<item[]> }.
// (TorrentProject was evaluated but every modern mirror is unreachable, so
// it is intentionally omitted — Knaben already aggregates 300+ trackers.)
const SOURCES = [
    { id: 'apibay', label: 'The Pirate Bay', search: searchApibay },
    { id: 'knaben', label: 'Knaben', search: searchKnaben },
    { id: 'torrentscsv', label: 'Torrents-CSV', search: searchTorrentsCsv },
];

module.exports = { SOURCES, buildMagnet, isHash40 };
