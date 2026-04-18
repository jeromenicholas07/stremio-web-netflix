const React = require('react');
const { default: Icon } = require('@stremio/stremio-icons/react');
const useIncognitoDetails = require('./useIncognitoDetails');
const useIncognitoPlay = require('./useIncognitoPlay');
const IncognitoStreamRow = require('./IncognitoStreamRow');
const styles = require('./IncognitoDetails.less');

function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function IncognitoDetails({ id }) {
    const { meta, streams, loading, error } = useIncognitoDetails(id);
    const play = useIncognitoPlay();

    const sortedStreams = React.useMemo(() => {
        if (!Array.isArray(streams)) return [];
        return [...streams].sort((a, b) => {
            const qa = IncognitoStreamRow.sortKey(a);
            const qb = IncognitoStreamRow.sortKey(b);
            if (qa !== qb) return qa - qb;
            const sa = (a?.behaviorHints?.seeders ?? a?.seeders ?? 0);
            const sb = (b?.behaviorHints?.seeders ?? b?.seeders ?? 0);
            return sb - sa;
        });
    }, [streams]);

    const goBack = React.useCallback(() => {
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '#/incognito';
    }, []);

    if (loading) {
        return (
            <div className={styles['incognito-details']}>
                <div className={styles['loading']}>Loading…</div>
            </div>
        );
    }
    if (error || !meta) {
        return (
            <div className={styles['incognito-details']}>
                <button className={styles['back-button']} type="button" onClick={goBack}>
                    <Icon name="chevron-back" /> Back
                </button>
                <div className={styles['error']}>
                    {error ? `Failed to load: ${error}` : 'No details available.'}
                </div>
            </div>
        );
    }

    const poster = meta.poster || meta.background || '';

    return (
        <div className={styles['incognito-details']}>
            <button className={styles['back-button']} type="button" onClick={goBack}>
                <Icon name="chevron-back" /> Back
            </button>
            <div className={styles['hero']}>
                {poster ? (
                    <div className={styles['poster']}>
                        <img src={poster} alt={meta.name || ''} />
                    </div>
                ) : null}
                <div className={styles['hero-info']}>
                    <div className={styles['title']}>{meta.name || 'Untitled'}</div>
                    {meta.releaseInfo ? <div className={styles['release-info']}>{meta.releaseInfo}</div> : null}
                    {meta.description ? <div className={styles['description']}>{meta.description}</div> : null}
                </div>
            </div>

            <div className={styles['streams-section']}>
                <div className={styles['streams-header']}>
                    {sortedStreams.length > 0
                        ? `${sortedStreams.length} stream${sortedStreams.length === 1 ? '' : 's'} available`
                        : 'No streams available.'}
                </div>
                <div className={styles['streams-list']}>
                    {sortedStreams.map((s, i) => {
                        const enriched = {
                            ...s,
                            title: s.title || (s.behaviorHints?.videoSize
                                ? formatSize(s.behaviorHints.videoSize)
                                : undefined)
                        };
                        return <IncognitoStreamRow key={s.infoHash || i} stream={enriched} onPlay={play} />;
                    })}
                </div>
            </div>
        </div>
    );
}

module.exports = IncognitoDetails;
