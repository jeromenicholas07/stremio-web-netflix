const React = require('react');
const classnames = require('classnames');
const styles = require('./IncognitoStreamRow.less');

const QUALITY_ORDER = { '4K': 0, '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4, 'SD': 5 };

function extractQuality(stream) {
    const hay = `${stream.name || ''} ${stream.title || ''}`.toUpperCase();
    if (/\b(4K|2160P)\b/.test(hay)) return '4K';
    if (/\b1080P\b/.test(hay)) return '1080p';
    if (/\b720P\b/.test(hay)) return '720p';
    if (/\b480P\b/.test(hay)) return '480p';
    if (/\b360P\b/.test(hay)) return '360p';
    return 'SD';
}

function IncognitoStreamRow({ stream, onPlay }) {
    const quality = stream.qualityLabel || extractQuality(stream);
    const isRD = stream?.behaviorHints?.realDebridReady === true;
    const subtitle = stream.title || '';

    const handleClick = React.useCallback(() => {
        if (typeof onPlay === 'function') onPlay(stream);
    }, [stream, onPlay]);

    return (
        <button className={styles['stream-row']} type="button" onClick={handleClick}>
            <div className={classnames(styles['quality-badge'], styles[`q-${quality.toLowerCase()}`])}>
                {quality}
            </div>
            <div className={styles['stream-main']}>
                <div className={styles['stream-name']}>{stream.name || 'Stream'}</div>
                {subtitle ? <div className={styles['stream-meta']}>{subtitle}</div> : null}
            </div>
            {isRD ? <div className={styles['rd-badge']}>RD+</div> : null}
            <div className={styles['play-icon']}>▶</div>
        </button>
    );
}

IncognitoStreamRow.sortKey = (stream) => QUALITY_ORDER[stream.qualityLabel || extractQuality(stream)] ?? 99;

module.exports = IncognitoStreamRow;
