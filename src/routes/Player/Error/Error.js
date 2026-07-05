// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useTranslation } = require('react-i18next');
const PropTypes = require('prop-types');
const classNames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button } = require('stremio/components');
const { usePlatform } = require('stremio/common/Platform');
const { IOS_EXTERNAL_PLAYERS, getExternalMediaUrl } = require('stremio/common/iosExternalPlayers');
const styles = require('./styles');

const Error = React.forwardRef(({ className, code, message, stream }, ref) => {
    const { t } = useTranslation();
    const platform = usePlatform();

    const [playlist, fileName] = React.useMemo(() => {
        return [
            stream?.deepLinks?.externalPlayer?.playlist,
            stream?.deepLinks?.externalPlayer?.fileName,
        ];
    }, [stream]);

    // iOS: Safari can't decode MKV/HEVC/AC3 inline, so offer one-tap hand-off to
    // the native player apps (Infuse/VLC/…) via their URL schemes. Desktop keeps
    // the single generic "open in external player" button below.
    const iosMediaUrl = React.useMemo(() => {
        return platform.name === 'ios' ? getExternalMediaUrl(stream?.deepLinks?.externalPlayer, stream) : null;
    }, [platform.name, stream]);

    return (
        <div ref={ref} className={classNames(className, styles['error'])}>
            <div className={styles['error-label']} title={message}>{message}</div>
            {
                code === 2 ?
                    <div className={styles['error-sub']} title={t('EXTERNAL_PLAYER_HINT')}>{t('EXTERNAL_PLAYER_HINT')}</div>
                    :
                    null
            }
            {
                iosMediaUrl ?
                    <div className={styles['external-players']}>
                        {
                            IOS_EXTERNAL_PLAYERS.map((player) => (
                                <Button
                                    key={player.value}
                                    className={styles['external-player-button']}
                                    title={player.label}
                                    href={player.build(iosMediaUrl)}
                                >
                                    <Icon className={styles['icon']} name={player.icon} />
                                    <div className={styles['label']}>{player.label}</div>
                                </Button>
                            ))
                        }
                    </div>
                    :
                    playlist && fileName ?
                        <Button
                            className={styles['playlist-button']}
                            title={t('PLAYER_OPEN_IN_EXTERNAL')}
                            href={playlist}
                            download={fileName}
                            target={'_blank'}
                        >
                            <Icon className={styles['icon']} name={'ic_downloads'} />
                            <div className={styles['label']}>{t('PLAYER_OPEN_IN_EXTERNAL')}</div>
                        </Button>
                        :
                        null
            }
        </div>
    );
});

Error.propTypes = {
    className: PropTypes.string,
    code: PropTypes.number,
    message: PropTypes.string,
    stream: PropTypes.object,
};

module.exports = Error;
