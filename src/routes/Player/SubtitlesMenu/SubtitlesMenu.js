// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { comparatorWithPriorities, languages } = require('stremio/common');
const { SUBTITLES_SIZES } = require('stremio/common/CONSTANTS');
const { Button } = require('stremio/components');
const styles = require('./styles');
const { t } = require('i18next');
const { default: Stepper } = require('./Stepper');

const SYNC_STATUS = {
    IDLE: 'idle',
    DOWNLOADING: 'downloading',
    EXTRACTING: 'extracting',
    TRANSCRIBING: 'transcribing',
    ALIGNING: 'aligning',
    DONE: 'done',
    ERROR: 'error',
};

const getSyncLabel = (syncStatus, syncProgress, syncError, syncResult) => {
    switch (syncStatus) {
        case SYNC_STATUS.DOWNLOADING:
            return `Downloading model${syncProgress > 0 ? ` ${syncProgress}%` : '...'}`;
        case SYNC_STATUS.EXTRACTING:
            return 'Extracting audio...';
        case SYNC_STATUS.TRANSCRIBING:
            return 'Transcribing...';
        case SYNC_STATUS.ALIGNING:
            return 'Aligning...';
        case SYNC_STATUS.DONE: {
            const delay = syncResult?.offset || 0;
            const sign = delay >= 0 ? '+' : '';
            return `Subtitles synced (${sign}${(delay / 1000).toFixed(1)}s offset applied)`;
        }
        case SYNC_STATUS.ERROR:
            return syncError || 'Sync failed';
        default:
            return 'Auto Sync';
    }
};

const ORIGIN_PRIORITIES = {
    'LOCAL': 3,
    'EMBEDDED': 2,
    'EXCLUSIVE': 1,
};
const LANGUAGE_PRIORITIES = {
    'local': 2,
    'eng': 1,
};

const SubtitlesMenu = React.memo((props) => {
    const subtitlesLanguages = React.useMemo(() => {
        return (Array.isArray(props.subtitlesTracks) ? props.subtitlesTracks : [])
            .concat(Array.isArray(props.extraSubtitlesTracks) ? props.extraSubtitlesTracks : [])
            .reduce((subtitlesLanguages, { lang }) => {
                if (!subtitlesLanguages.includes(lang)) {
                    subtitlesLanguages.push(lang);
                }

                return subtitlesLanguages;
            }, [])
            .sort(comparatorWithPriorities(LANGUAGE_PRIORITIES));
    }, [props.subtitlesTracks, props.extraSubtitlesTracks]);
    const selectedSubtitlesLanguage = React.useMemo(() => {
        return typeof props.selectedSubtitlesTrackId === 'string' ?
            (Array.isArray(props.subtitlesTracks) ? props.subtitlesTracks : [])
                .reduce((selectedSubtitlesLanguage, { id, lang }) => {
                    if (id === props.selectedSubtitlesTrackId) {
                        return lang;
                    }

                    return selectedSubtitlesLanguage;
                }, null)
            :
            typeof props.selectedExtraSubtitlesTrackId === 'string' ?
                (Array.isArray(props.extraSubtitlesTracks) ? props.extraSubtitlesTracks : [])
                    .reduce((selectedSubtitlesLanguage, { id, lang }) => {
                        if (id === props.selectedExtraSubtitlesTrackId) {
                            return lang;
                        }

                        return selectedSubtitlesLanguage;
                    }, null)
                :
                null;
    }, [props.subtitlesTracks, props.extraSubtitlesTracks, props.selectedSubtitlesTrackId, props.selectedExtraSubtitlesTrackId]);
    const subtitlesTracksForLanguage = React.useMemo(() => {
        return (Array.isArray(props.subtitlesTracks) ? props.subtitlesTracks : [])
            .concat(Array.isArray(props.extraSubtitlesTracks) ? props.extraSubtitlesTracks : [])
            .filter(({ lang }) => lang === selectedSubtitlesLanguage)
            .sort((t1, t2) => comparatorWithPriorities(ORIGIN_PRIORITIES)(t1.origin, t2.origin));
    }, [props.subtitlesTracks, props.extraSubtitlesTracks, selectedSubtitlesLanguage]);
    const onMouseDown = React.useCallback((event) => {
        event.nativeEvent.subtitlesMenuClosePrevented = true;
    }, []);
    const subtitlesLanguageOnClick = React.useCallback((event) => {
        const track = (Array.isArray(props.subtitlesTracks) ? props.subtitlesTracks : [])
            .concat(Array.isArray(props.extraSubtitlesTracks) ? props.extraSubtitlesTracks : [])
            .filter(({ lang }) => lang === event.currentTarget.dataset.lang)
            .sort((t1, t2) => comparatorWithPriorities(ORIGIN_PRIORITIES)(t1.origin, t2.origin))
            .shift();
        if (!track) {
            if (typeof props.onSubtitlesTrackSelected === 'function') {
                props.onSubtitlesTrackSelected(null);
            }
            if (typeof props.onExtraSubtitlesTrackSelected === 'function') {
                props.onExtraSubtitlesTrackSelected(null);
            }
        } else if (track.embedded) {
            // Selecting an embedded track must turn OFF any external track,
            // otherwise both render at once (double subtitles).
            if (typeof props.onExtraSubtitlesTrackSelected === 'function') {
                props.onExtraSubtitlesTrackSelected(null);
            }
            if (typeof props.onSubtitlesTrackSelected === 'function') {
                props.onSubtitlesTrackSelected(track.id);
            }
        } else {
            // ...and vice versa: selecting an external track turns off embedded.
            if (typeof props.onSubtitlesTrackSelected === 'function') {
                props.onSubtitlesTrackSelected(null);
            }
            if (typeof props.onExtraSubtitlesTrackSelected === 'function') {
                props.onExtraSubtitlesTrackSelected(track.id);
            }
        }
    }, [props.subtitlesTracks, props.extraSubtitlesTracks, props.onSubtitlesTrackSelected, props.onExtraSubtitlesTrackSelected]);
    const subtitlesTrackOnClick = React.useCallback((event) => {
        if (event.currentTarget.dataset.embedded === 'true') {
            // Mutually exclusive with external subtitles — clear the other side.
            if (typeof props.onExtraSubtitlesTrackSelected === 'function') {
                props.onExtraSubtitlesTrackSelected(null);
            }
            if (typeof props.onSubtitlesTrackSelected === 'function') {
                props.onSubtitlesTrackSelected(event.currentTarget.dataset.id);
            }
        } else {
            if (typeof props.onSubtitlesTrackSelected === 'function') {
                props.onSubtitlesTrackSelected(null);
            }
            if (typeof props.onExtraSubtitlesTrackSelected === 'function') {
                props.onExtraSubtitlesTrackSelected(event.currentTarget.dataset.id);
            }
        }
    }, [props.onSubtitlesTrackSelected, props.onExtraSubtitlesTrackSelected]);
    const onSubtitlesDelayChanged = React.useCallback((value) => {
        if (typeof props.selectedExtraSubtitlesTrackId === 'string') {
            if (props.extraSubtitlesDelay !== null && !isNaN(props.extraSubtitlesDelay)) {
                if (typeof props.onExtraSubtitlesDelayChanged === 'function') {
                    props.onExtraSubtitlesDelayChanged(value * 1000);
                }
            }
        }
    }, [props.selectedExtraSubtitlesTrackId, props.extraSubtitlesDelay, props.onExtraSubtitlesDelayChanged]);
    const onSubtitlesSizeChanged = React.useCallback((value) => {
        if (typeof props.selectedSubtitlesTrackId === 'string') {
            if (props.subtitlesSize !== null && !isNaN(props.subtitlesSize)) {
                if (typeof props.onSubtitlesSizeChanged === 'function') {
                    props.onSubtitlesSizeChanged(value);
                }
            }
        } else if (typeof props.selectedExtraSubtitlesTrackId === 'string') {
            if (props.extraSubtitlesSize !== null && !isNaN(props.extraSubtitlesSize)) {
                if (typeof props.onExtraSubtitlesSizeChanged === 'function') {
                    props.onExtraSubtitlesSizeChanged(value);
                }
            }
        }
    }, [props.selectedSubtitlesTrackId, props.selectedExtraSubtitlesTrackId, props.subtitlesSize, props.extraSubtitlesSize, props.onSubtitlesSizeChanged, props.onExtraSubtitlesSizeChanged]);
    const onSubtitlesOffsetChanged = React.useCallback((value) => {
        if (typeof props.selectedSubtitlesTrackId === 'string') {
            if (props.subtitlesOffset !== null && !isNaN(props.subtitlesOffset)) {
                if (typeof props.onSubtitlesOffsetChanged === 'function') {
                    props.onSubtitlesOffsetChanged(value);
                }
            }
        } else if (typeof props.selectedExtraSubtitlesTrackId === 'string') {
            if (props.extraSubtitlesOffset !== null && !isNaN(props.extraSubtitlesOffset)) {
                if (typeof props.onExtraSubtitlesOffsetChanged === 'function') {
                    props.onExtraSubtitlesOffsetChanged(value);
                }
            }
        }
    }, [props.selectedSubtitlesTrackId, props.selectedExtraSubtitlesTrackId, props.subtitlesOffset, props.extraSubtitlesOffset, props.onSubtitlesOffsetChanged, props.onExtraSubtitlesOffsetChanged]);
    return (
        <div className={classnames(props.className, styles['subtitles-menu-container'])} onMouseDown={onMouseDown}>
            <div className={styles['languages-container']}>
                <div className={styles['languages-header']}>{ t('PLAYER_SUBTITLES_LANGUAGES') }</div>
                <div className={styles['languages-list']}>
                    <Button title={t('OFF')} className={classnames(styles['language-option'], { 'selected': selectedSubtitlesLanguage === null })} onClick={subtitlesLanguageOnClick}>
                        <div className={styles['language-label']}>{ t('OFF') }</div>
                        {
                            selectedSubtitlesLanguage === null ?
                                <div className={styles['icon']} />
                                :
                                null
                        }
                    </Button>
                    {subtitlesLanguages.map((lang, index) => (
                        <Button key={index} title={languages.label(lang)} className={classnames(styles['language-option'], { 'selected': selectedSubtitlesLanguage === lang })} data-lang={lang} onClick={subtitlesLanguageOnClick}>
                            <div className={styles['language-label']}>
                                {
                                    lang === 'local' ? t('LOCAL') : languages.label(lang)
                                }
                            </div>
                            {
                                selectedSubtitlesLanguage === lang ?
                                    <div className={styles['icon']} />
                                    :
                                    null
                            }
                        </Button>
                    ))}
                </div>
            </div>
            <div className={styles['variants-container']}>
                <div className={styles['variants-header']}>{ t('PLAYER_SUBTITLES_VARIANTS') }</div>
                {
                    subtitlesTracksForLanguage.length > 0 ?
                        <div className={styles['variants-list']}>
                            {subtitlesTracksForLanguage.map((track, index) => (
                                <Button key={index} title={track.label} className={classnames(styles['variant-option'], { 'selected': props.selectedSubtitlesTrackId === track.id || props.selectedExtraSubtitlesTrackId === track.id })} data-id={track.id} data-origin={track.origin} data-embedded={track.embedded} onClick={subtitlesTrackOnClick}>
                                    <div className={styles['info']}>
                                        <div className={styles['variant-label']}>
                                            {
                                                languages.label(!track.label.startsWith('http') ? track.label : track.lang)
                                            }
                                        </div>
                                        <div className={styles['variant-origin']}>
                                            { t(track.origin) }
                                        </div>
                                    </div>
                                    {
                                        props.selectedSubtitlesTrackId === track.id || props.selectedExtraSubtitlesTrackId === track.id ?
                                            <div className={styles['icon']} />
                                            :
                                            null
                                    }
                                </Button>
                            ))}
                        </div>
                        :
                        <div className={styles['no-variants-container']}>
                            <div className={styles['no-variants-label']}>
                                { t('PLAYER_SUBTITLES_DISABLED') }
                            </div>
                        </div>
                }
            </div>
            <div className={styles['subtitles-settings-container']}>
                <div className={styles['settings-header']}>{t('PLAYER_SUBTITLES_SETTINGS')}</div>
                <div className={styles['settings-list']}>
                    <Stepper
                        className={styles['stepper']}
                        label={'DELAY'}
                        value={props.extraSubtitlesDelay / 1000}
                        unit={'s'}
                        step={0.25}
                        disabled={props.extraSubtitlesDelay === null}
                        onChange={onSubtitlesDelayChanged}
                    />
                    <Stepper
                        className={styles['stepper']}
                        label={'SIZE'}
                        value={props.selectedSubtitlesTrackId ? props.subtitlesSize : props.selectedExtraSubtitlesTrackId ? props.extraSubtitlesSize : null}
                        unit={'%'}
                        step={25}
                        min={SUBTITLES_SIZES[0]}
                        max={SUBTITLES_SIZES[SUBTITLES_SIZES.length - 1]}
                        disabled={(props.selectedSubtitlesTrackId && props.subtitlesSize === null) || (props.selectedExtraSubtitlesTrackId && props.extraSubtitlesSize === null)}
                        onChange={onSubtitlesSizeChanged}
                    />
                    <Stepper
                        className={styles['stepper']}
                        label={'PLAYER_SUBTITLES_VERTICAL_POSITION'}
                        value={props.selectedSubtitlesTrackId ? props.subtitlesOffset : props.selectedExtraSubtitlesTrackId ? props.extraSubtitlesOffset : null}
                        unit={'%'}
                        step={1}
                        min={0}
                        max={100}
                        disabled={(props.selectedSubtitlesTrackId && props.subtitlesOffset === null) || (props.selectedExtraSubtitlesTrackId && props.extraSubtitlesOffset === null)}
                        onChange={onSubtitlesOffsetChanged}
                    />
                    <div className={styles['auto-sync-container']}>
                        {
                            props.syncStatus !== SYNC_STATUS.IDLE && props.syncStatus !== SYNC_STATUS.DONE && props.syncStatus !== SYNC_STATUS.ERROR ?
                                <Button
                                    className={classnames(styles['sync-button'], styles['sync-cancel'])}
                                    onClick={props.onCancelSync}
                                    disabled={!props.selectedExtraSubtitlesTrackId}
                                >
                                    <div className={styles['sync-label']}>
                                        {getSyncLabel(props.syncStatus, props.syncProgress, props.syncError, props.syncResult)}
                                    </div>
                                    <div className={styles['sync-cancel-label']}>{t('BUTTON_CANCEL')}</div>
                                </Button>
                                :
                                <Button
                                    className={classnames(styles['sync-button'], {
                                        [styles['sync-done']]: props.syncStatus === SYNC_STATUS.DONE,
                                        [styles['sync-error']]: props.syncStatus === SYNC_STATUS.ERROR,
                                    })}
                                    onClick={props.onStartSync}
                                    disabled={!props.selectedExtraSubtitlesTrackId}
                                >
                                    <div className={styles['sync-label']}>
                                        {getSyncLabel(props.syncStatus, props.syncProgress, props.syncError, props.syncResult)}
                                    </div>
                                </Button>
                        }
                    </div>
                </div>
            </div>
        </div>
    );
});

SubtitlesMenu.displayName = 'MainNavBars';

SubtitlesMenu.propTypes = {
    className: PropTypes.string,
    subtitlesTracks: PropTypes.arrayOf(PropTypes.shape({
        id: PropTypes.string.isRequired,
        lang: PropTypes.string.isRequired,
        origin: PropTypes.string.isRequired
    })),
    selectedSubtitlesTrackId: PropTypes.string,
    subtitlesOffset: PropTypes.number,
    subtitlesSize: PropTypes.number,
    extraSubtitlesTracks: PropTypes.arrayOf(PropTypes.shape({
        id: PropTypes.string.isRequired,
        lang: PropTypes.string.isRequired,
        origin: PropTypes.string.isRequired,
        label: PropTypes.string.isRequired
    })),
    selectedExtraSubtitlesTrackId: PropTypes.string,
    extraSubtitlesOffset: PropTypes.number,
    extraSubtitlesDelay: PropTypes.number,
    extraSubtitlesSize: PropTypes.number,
    onSubtitlesTrackSelected: PropTypes.func,
    onExtraSubtitlesTrackSelected: PropTypes.func,
    onSubtitlesOffsetChanged: PropTypes.func,
    onSubtitlesSizeChanged: PropTypes.func,
    onExtraSubtitlesOffsetChanged: PropTypes.func,
    onExtraSubtitlesDelayChanged: PropTypes.func,
    onExtraSubtitlesSizeChanged: PropTypes.func,
    syncStatus: PropTypes.string,
    syncProgress: PropTypes.number,
    syncError: PropTypes.string,
    syncResult: PropTypes.object,
    onStartSync: PropTypes.func,
    onCancelSync: PropTypes.func
};

module.exports = SubtitlesMenu;
