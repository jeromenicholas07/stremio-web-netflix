// Copyright (C) 2017-2024 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { default: Button } = require('stremio/components/Button');
const { default: Image } = require('stremio/components/Image');
const { useModelState } = require('stremio/common');
const { useServices } = require('stremio/services');
const styles = require('./styles');

const map = (metaDetails) => ({
    ...metaDetails,
    metaItem: metaDetails.metaItem !== null && metaDetails.metaItem.content.type === 'Ready' ?
        {
            ...metaDetails.metaItem,
            content: {
                ...metaDetails.metaItem.content,
                content: {
                    ...metaDetails.metaItem.content.content,
                    released: new Date(
                        typeof metaDetails.metaItem.content.content.released === 'string' ?
                            metaDetails.metaItem.content.content.released : NaN
                    ),
                    videos: metaDetails.metaItem.content.content.videos.map((video) => ({
                        ...video,
                        released: new Date(
                            typeof video.released === 'string' ? video.released : NaN
                        ),
                    }))
                }
            }
        }
        :
        metaDetails.metaItem
});

const DetailModal = React.memo(({ type, id, onClose }) => {
    const { core } = useServices();
    const action = React.useMemo(() => {
        if (typeof type === 'string' && typeof id === 'string') {
            return {
                action: 'Load',
                args: {
                    model: 'MetaDetails',
                    args: {
                        metaPath: { resource: 'meta', type, id, extra: [] },
                        streamPath: null,
                        guessStream: false,
                    }
                }
            };
        }
        return { action: 'Unload' };
    }, [type, id]);

    const metaDetails = useModelState({ model: 'meta_details', action, map });

    const meta = React.useMemo(() => {
        if (metaDetails?.metaItem?.content?.type === 'Ready') {
            return metaDetails.metaItem.content.content;
        }
        return null;
    }, [metaDetails]);

    const [selectedSeason, setSelectedSeason] = React.useState(1);

    const seasons = React.useMemo(() => {
        if (!meta || !Array.isArray(meta.videos)) return [];
        const seasonSet = new Set();
        meta.videos.forEach(v => { if (v.season) seasonSet.add(v.season); });
        return Array.from(seasonSet).sort((a, b) => a - b);
    }, [meta]);

    const episodesForSeason = React.useMemo(() => {
        if (!meta || !Array.isArray(meta.videos)) return [];
        if (seasons.length === 0) return meta.videos;
        return meta.videos.filter(v => v.season === selectedSeason);
    }, [meta, selectedSeason, seasons]);

    React.useEffect(() => {
        if (seasons.length > 0) setSelectedSeason(seasons[0]);
    }, [seasons]);

    const genres = React.useMemo(() => {
        if (!meta || !Array.isArray(meta.links)) return [];
        return meta.links.filter(l => l.category === 'Genres').map(l => l.name);
    }, [meta]);

    const cast = React.useMemo(() => {
        if (!meta || !Array.isArray(meta.links)) return [];
        return meta.links.filter(l => l.category === 'Cast').map(l => l.name).slice(0, 6);
    }, [meta]);

    const trailerYtId = React.useMemo(() => {
        if (!meta || !Array.isArray(meta.trailerStreams) || meta.trailerStreams.length === 0) return null;
        return meta.trailerStreams[0].ytId || null;
    }, [meta]);

    const playHref = React.useMemo(() => {
        if (!meta) return null;
        return meta.deepLinks?.player ?? meta.deepLinks?.metaDetailsStreams ?? null;
    }, [meta]);

    const handleBackdropClick = React.useCallback((e) => {
        if (e.target === e.currentTarget) onClose();
    }, [onClose]);

    const handleKeyDown = React.useCallback((e) => {
        if (e.key === 'Escape') onClose();
    }, [onClose]);

    React.useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [handleKeyDown]);

    const addToLibrary = React.useCallback(() => {
        if (!meta) return;
        core.transport.dispatch({
            action: 'Ctx',
            args: { action: 'AddToLibrary', args: meta }
        });
    }, [meta, core]);

    const isLoading = !meta;

    return (
        <div className={styles['modal-overlay']} onClick={handleBackdropClick}>
            <div className={styles['modal-container']}>
                <button className={styles['close-btn']} onClick={onClose}>
                    <Icon className={styles['close-icon']} name={'close'} />
                </button>
                {
                    isLoading ?
                        <div className={styles['loading-container']}>
                            <div className={styles['loading-spinner']} />
                        </div>
                        :
                        <React.Fragment>
                            <div className={styles['modal-hero']}>
                                <Image
                                    className={styles['modal-backdrop']}
                                    src={meta.background || meta.poster}
                                    alt={' '}
                                />
                                {
                                    trailerYtId ?
                                        <iframe
                                            className={styles['modal-trailer']}
                                            src={`https://www.youtube.com/embed/${trailerYtId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0`}
                                            allow="autoplay; encrypted-media"
                                            allowFullScreen
                                            frameBorder="0"
                                        />
                                        :
                                        null
                                }
                                <div className={styles['modal-hero-gradient']} />
                                <div className={styles['modal-hero-content']}>
                                    <h2 className={styles['modal-title']}>{meta.name}</h2>
                                    <div className={styles['modal-hero-buttons']}>
                                        {
                                            playHref ?
                                                <Button className={styles['play-btn']} href={playHref}>
                                                    <Icon className={styles['play-btn-icon']} name={'play'} />
                                                    <span>Play</span>
                                                </Button>
                                                :
                                                null
                                        }
                                        <button className={styles['circle-btn']} onClick={addToLibrary} title="Add to My List">
                                            <Icon className={styles['circle-btn-icon']} name={'add'} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className={styles['modal-info']}>
                                <div className={styles['modal-info-main']}>
                                    <div className={styles['modal-meta-row']}>
                                        <span className={styles['match-text']}>97% Match</span>
                                        {
                                            meta.released instanceof Date && !isNaN(meta.released.getTime()) ?
                                                <span className={styles['meta-text']}>{meta.released.getFullYear()}</span>
                                                :
                                                typeof meta.releaseInfo === 'string' ?
                                                    <span className={styles['meta-text']}>{meta.releaseInfo}</span>
                                                    :
                                                    null
                                        }
                                        {
                                            typeof meta.runtime === 'string' ?
                                                <span className={styles['meta-text']}>{meta.runtime}</span>
                                                :
                                                null
                                        }
                                    </div>
                                    {
                                        typeof meta.description === 'string' ?
                                            <p className={styles['modal-description']}>{meta.description}</p>
                                            :
                                            null
                                    }
                                </div>
                                <div className={styles['modal-info-side']}>
                                    {
                                        cast.length > 0 ?
                                            <div className={styles['info-label']}>
                                                <span className={styles['info-label-title']}>Cast: </span>
                                                {cast.join(', ')}
                                            </div>
                                            :
                                            null
                                    }
                                    {
                                        genres.length > 0 ?
                                            <div className={styles['info-label']}>
                                                <span className={styles['info-label-title']}>Genres: </span>
                                                {genres.join(', ')}
                                            </div>
                                            :
                                            null
                                    }
                                </div>
                            </div>
                            {
                                seasons.length > 0 ?
                                    <div className={styles['episodes-section']}>
                                        <div className={styles['episodes-header']}>
                                            <h3 className={styles['episodes-title']}>Episodes</h3>
                                            <select
                                                className={styles['season-select']}
                                                value={selectedSeason}
                                                onChange={(e) => setSelectedSeason(Number(e.target.value))}
                                            >
                                                {seasons.map(s => (
                                                    <option key={s} value={s}>Season {s}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className={styles['episodes-list']}>
                                            {episodesForSeason.map((ep, i) => (
                                                <Button
                                                    key={ep.id || i}
                                                    className={styles['episode-item']}
                                                    href={ep.deepLinks?.player || ep.deepLinks?.metaDetailsStreams || `#/meta/${type}/${id}/${encodeURIComponent(ep.id)}`}
                                                >
                                                    <div className={styles['episode-number']}>{ep.episode || i + 1}</div>
                                                    <div className={styles['episode-thumb']}>
                                                        <Image
                                                            className={styles['episode-thumb-img']}
                                                            src={ep.thumbnail || meta.poster}
                                                            alt={' '}
                                                        />
                                                        <div className={styles['episode-play-overlay']}>
                                                            <Icon className={styles['episode-play-icon']} name={'play'} />
                                                        </div>
                                                    </div>
                                                    <div className={styles['episode-info']}>
                                                        <div className={styles['episode-name']}>{ep.title || `Episode ${ep.episode || i + 1}`}</div>
                                                        {
                                                            typeof ep.overview === 'string' ?
                                                                <div className={styles['episode-overview']}>{ep.overview}</div>
                                                                :
                                                                null
                                                        }
                                                    </div>
                                                </Button>
                                            ))}
                                        </div>
                                    </div>
                                    :
                                    null
                            }
                        </React.Fragment>
                }
            </div>
        </div>
    );
});

DetailModal.displayName = 'DetailModal';

DetailModal.propTypes = {
    type: PropTypes.string.isRequired,
    id: PropTypes.string.isRequired,
    onClose: PropTypes.func.isRequired,
};

module.exports = DetailModal;
