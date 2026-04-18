const React = require('react');
const classnames = require('classnames');
const styles = require('./IncognitoSettings.less');

// Bundled defaults — every endpoint is loopback and deterministic, so there
// is nothing the user needs (or should be able) to misconfigure here.
const ADDON_URL = 'http://127.0.0.1:7000';
const PROWLARR_URL = 'http://127.0.0.1:9696';

const RD_TOKEN_KEY = 'rd_token';

const IncognitoSettings = React.memo(({ onClose, onResetPin }) => {
    const [status, setStatus] = React.useState(null);
    const [checking, setChecking] = React.useState(false);
    const [rdToken, setRdToken] = React.useState(() => {
        try { return localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { return ''; }
    });
    const [rdSaved, setRdSaved] = React.useState(false);

    const handleRdTokenChange = React.useCallback((e) => {
        setRdToken(e.target.value);
        setRdSaved(false);
    }, []);

    const handleSaveRdToken = React.useCallback(() => {
        try {
            const trimmed = rdToken.trim();
            if (trimmed) localStorage.setItem(RD_TOKEN_KEY, trimmed);
            else localStorage.removeItem(RD_TOKEN_KEY);
            setRdSaved(true);
        } catch (_e) { /* ignore */ }
    }, [rdToken]);

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

                <div className={styles['settings-description']} style={{ marginTop: '1rem' }}>
                    Real-Debrid token (optional). Paste your API token from
                    real-debrid.com/apitoken to stream through RD — torrents resolve to
                    HTTPS links playable in the browser without local torrent client.
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0 1rem' }}>
                    <input
                        type="password"
                        placeholder="Real-Debrid API token"
                        value={rdToken}
                        onChange={handleRdTokenChange}
                        style={{ flex: 1, padding: '0.5rem', background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px' }}
                    />
                    <button
                        className={classnames(styles['settings-button'], styles['primary'])}
                        onClick={handleSaveRdToken}
                        type="button"
                    >
                        {rdSaved ? 'Saved' : 'Save'}
                    </button>
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
