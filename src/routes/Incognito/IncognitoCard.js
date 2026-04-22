// Dedicated card component for Incognito catalogs.
//
// Unlike the normal MetaItem, these cards:
//   - Have NO poster image. Adult torrents rarely come with useful
//     artwork, and the generic fallback tiles made the grid feel
//     sparse. We use a hash-stable solid tint derived from the
//     infoHash (decoded from the torrent payload) so every card has
//     a unique colour without a network fetch.
//   - Have NO hover pane with watchlist / not-interested / rate-this
//     buttons. None of those actions make sense for a torrent result.
//   - Surface seeders/leechers/size/quality/indexer directly ON the
//     card as badges (top-left, top-right, bottom strip). The old
//     approach of burying them in `description` under a hover menu
//     meant users had to hover every card to see whether it was
//     playable.
//
// Props contract matches what MetaRow passes (spread-`...item`):
//   id, name, description, seeders, leechers, size, quality, indexer,
//   deepLinks, className.
// Legacy `description` parsing is kept as a fallback in case the
// addon hasn't been updated to emit structured fields yet.

const React = require('react');
const classnames = require('classnames');
const { default: Button } = require('stremio/components/Button');
const styles = require('./IncognitoCard.less');

// Fallback parser for the compact description string
// "S 42 · L 3 · 2.1 GB · 1080p · MyPornClub". Only used when the meta
// hasn't been re-fetched since the addon was upgraded to emit explicit
// fields, so this should disappear naturally over a few hours of cache
// churn.
function parseDescription(desc) {
    if (typeof desc !== 'string' || !desc) return {};
    const parts = desc.split(' · ');
    const out = {};
    for (const part of parts) {
        const m = part.match(/^S\s+(\d+)$/);
        if (m) { out.seeders = Number(m[1]); continue; }
        const l = part.match(/^L\s+(\d+)$/);
        if (l) { out.leechers = Number(l[1]); continue; }
        const sz = part.match(/^([\d.]+\s*(?:GB|MB|KB))$/i);
        if (sz) { out.size = sz[1]; continue; }
        const q = part.match(/^(4K|1080p|720p|480p)$/i);
        if (q) { out.quality = q[1]; continue; }
        if (part && !out.indexer) out.indexer = part;
    }
    return out;
}

// Extract infoHash from the base64url-encoded torrent id so we can
// pick a stable hash-derived tint for the card. Doing this client-side
// (vs. passing a colour through from the addon) keeps the addon's meta
// schema identical to Stremio-standard shape.
function decodeInfoHash(id) {
    if (typeof id !== 'string' || !id.startsWith('torrent:')) return '';
    try {
        const payload = id.slice('torrent:'.length);
        const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
        const b64 = payload.replace(/-/g, '+').replace(/_/g, '/') + pad;
        const decoded = JSON.parse(atob(b64));
        return typeof decoded.infoHash === 'string' ? decoded.infoHash : '';
    } catch { return ''; }
}

// Build a restrained dark tint from the first 6 hex chars of infoHash,
// mixed toward near-black so text stays legible without extra shadow.
function tintFromHash(hash) {
    if (!hash || hash.length < 6) return '#1f2430';
    const r = parseInt(hash.slice(0, 2), 16) || 30;
    const g = parseInt(hash.slice(2, 4), 16) || 36;
    const b = parseInt(hash.slice(4, 6), 16) || 48;
    // Darken so the base is always below luminance 0.25
    const mix = (c) => Math.max(18, Math.min(90, Math.round(c * 0.35 + 10)));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function formatSeeders(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

const IncognitoCard = React.memo(({
    id, name, description, deepLinks,
    seeders, leechers, peers, size, quality, indexer,
    className,
}) => {
    const parsed = React.useMemo(() => parseDescription(description), [description]);
    // Prefer explicit fields on the meta; fall back to parsed description.
    const S = typeof seeders === 'number' ? seeders : parsed.seeders ?? 0;
    const L = typeof leechers === 'number' ? leechers :
              typeof peers === 'number' ? peers :
              parsed.leechers ?? 0;
    const sizeStr = size || parsed.size || '';
    const qualityStr = quality || parsed.quality || '';
    const indexerStr = indexer || parsed.indexer || '';

    const href = React.useMemo(() => {
        if (!deepLinks) return null;
        return deepLinks.metaDetailsStreams ||
               deepLinks.metaDetailsVideos ||
               deepLinks.player ||
               null;
    }, [deepLinks]);

    const tint = React.useMemo(() => tintFromHash(decodeInfoHash(id)), [id]);

    return (
        <Button
            href={href}
            className={classnames(className, styles['incognito-card'])}
            style={{ backgroundColor: tint }}
        >
            <div className={styles['badge-top-left']} title={`${S} seeders · ${L} leechers`}>
                <span className={styles['seed']}>{'\u25B2'} {formatSeeders(S)}</span>
                <span className={styles['leech']}>{'\u25BC'} {formatSeeders(L)}</span>
            </div>
            {
                sizeStr || qualityStr ? (
                    <div className={styles['badge-top-right']}>
                        {qualityStr ? <span className={styles['quality']}>{qualityStr}</span> : null}
                        {sizeStr ? <span className={styles['size']}>{sizeStr}</span> : null}
                    </div>
                ) : null
            }
            <div className={styles['card-title']}>{name}</div>
            {
                indexerStr ? (
                    <div className={styles['badge-bottom']} title={`Source: ${indexerStr}`}>
                        {indexerStr}
                    </div>
                ) : null
            }
        </Button>
    );
});

IncognitoCard.displayName = 'IncognitoCard';

module.exports = IncognitoCard;
