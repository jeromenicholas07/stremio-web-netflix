const React = require('react');
const classnames = require('classnames');
const styles = require('./IncognitoSettings.less');

// Bundled defaults — every endpoint is loopback and deterministic, so there
// is nothing the user needs (or should be able) to misconfigure here.
const ADDON_URL = 'http://127.0.0.1:7000';
const PROWLARR_URL = 'http://127.0.0.1:9696';

const IncognitoSettings = React.memo(({ onClose, onResetPin }) => {
    const [status, setStatus] = React.useState(null);
    const [checking, setChecking] = React.useState(false);

    // Probe the addon on mount so the user gets immediate feedback about
    // whether bundled services are up.
    React.useEffect(() => {
        let cancelled = false;
        setChecking(true);
        (async () => {
            try {
                const res = await fetch(`${ADDON_URL}/status`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                if (data.prowlarrApiKeySet) {
                    setStatus({ ok: true, message: 'Bundled services running — Prowlarr connected.' });
                } else {
                    setStatus({
                        ok: false,
                        message: 'Addon is up but no Prowlarr API key found yet. Open Prowlarr to finish first-run setup.',
                    });
                }
            } catch (_err) {
                if (cancelled) return;
                setStatus({
                    ok: false,
                    message: 'Cannot reach the bundled addon. Make sure you launched StremioLauncherFULL.exe.',
                });
            } finally {
                if (!cancelled) setChecking(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleOpenProwlarr = React.useCallback(() => {
        window.open(PROWLARR_URL, '_blank', 'noopener,noreferrer');
    }, []);

    const handleOverlayClick = React.useCallback((event) => {
        if (event.target === event.currentTarget) {
            onClose(false);
        }
    }, [onClose]);

    return (
        <div className={styles['settings-overlay']} onClick={handleOverlayClick}>
            <div className={styles['settings-panel']}>
                <div className={styles['settings-title']}>Incognito Settings</div>

                <div className={styles['settings-description']}>
                    Incognito uses bundled services running locally — no URLs or API keys
                    to configure. To add or manage indexers, open Prowlarr below.
                </div>

                <div className={styles['settings-status-row']}>
                    {checking ? (
                        <div className={styles['settings-status']}>Checking bundled services...</div>
                    ) : status ? (
                        <div className={classnames(styles['settings-status'], {
                            [styles['connected']]: status.ok,
                            [styles['disconnected']]: !status.ok,
                        })}>
                            {status.message}
                        </div>
                    ) : null}
                </div>

                <div className={styles['settings-buttons']}>
                    <button
                        className={classnames(styles['settings-button'], styles['danger'])}
                        onClick={onResetPin}
                        type="button"
                    >
                        Reset PIN
                    </button>
                    <button
                        className={classnames(styles['settings-button'], styles['secondary'])}
                        onClick={handleOpenProwlarr}
                        type="button"
                    >
                        Open Prowlarr
                    </button>
                    <button
                        className={classnames(styles['settings-button'], styles['primary'])}
                        onClick={() => onClose(false)}
                        type="button"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
});

IncognitoSettings.displayName = 'IncognitoSettings';

module.exports = IncognitoSettings;
