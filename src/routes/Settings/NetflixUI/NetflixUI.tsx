import React, { forwardRef, useState, useCallback, useEffect, useRef } from 'react';
import { Section, Option } from '../components';
import styles from './NetflixUI.less';

const { useToast } = require('stremio/common');
const traktBridge = require('stremio/services/TraktBridge');

const TMDB_BASE = 'https://api.themoviedb.org/3';

function getSetting(key: string, fallback: string): string {
    try { return localStorage.getItem(key) || fallback; }
    catch { return fallback; }
}

function setSetting(key: string, value: string): void {
    try { localStorage.setItem(key, value); }
    catch { /* silent */ }
}

const TRAILER_SOURCES = [
    { value: 'tmdb', label: 'TMDB (Recommended)' },
    { value: 'stremio', label: 'Stremio Add-ons' },
];

const TRAILER_LANGUAGES = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'it', label: 'Italian' },
    { value: 'pt', label: 'Portuguese' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
    { value: 'zh', label: 'Chinese' },
    { value: 'hi', label: 'Hindi' },
    { value: 'ar', label: 'Arabic' },
    { value: 'ru', label: 'Russian' },
];

const REC_SOURCES = [
    { value: 'tmdb', label: 'TMDB (Recommended)' },
    { value: 'disabled', label: 'Disabled' },
];

const QUALITY_OPTIONS = [
    { value: '4k_hdr', label: '4K HDR (2160p)' },
    { value: '4k', label: '4K (2160p)' },
    { value: '1080p', label: '1080p' },
    { value: '720p', label: '720p' },
    { value: '480p', label: '480p' },
    { value: 'any', label: 'Any Quality' },
];

const SOURCE_OPTIONS = [
    { value: 'realdebrid', label: 'RealDebrid [RD+]' },
    { value: 'debridlink', label: 'Debrid-Link [DL+]' },
    { value: 'alldebrid', label: 'AllDebrid [AD+]' },
    { value: 'premiumize', label: 'Premiumize [PM+]' },
    { value: 'any', label: 'Any Source' },
];

type TestStatus = 'idle' | 'loading' | 'success' | 'error';

// ─── Inline status icon with tooltip on hover ───
const StatusIcon = ({ status, tooltip }: { status: TestStatus; tooltip: string }) => {
    const [showTip, setShowTip] = useState(false);
    const tipRef = useRef<HTMLDivElement>(null);

    if (status === 'idle') return null;

    return (
        <span
            className={styles['status-icon-wrap']}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
        >
            {status === 'loading' && <span className={styles['status-spinner']} />}
            {status === 'success' && <span className={styles['status-check']}>&#10003;</span>}
            {status === 'error' && <span className={styles['status-x']}>&#10007;</span>}
            {showTip && tooltip && (
                <div ref={tipRef} className={styles['status-tooltip']}>
                    {tooltip}
                </div>
            )}
        </span>
    );
};

// ─── Trakt Device Auth States ───
type TraktAuthState =
    | { phase: 'disconnected' }
    | { phase: 'requesting' } // Getting device code
    | { phase: 'waiting'; userCode: string; verificationUrl: string } // Waiting for user
    | { phase: 'connected'; username: string };

const ModernUI = forwardRef<HTMLDivElement>((_, ref) => {
    const toast = useToast();

    // ─── State ───
    const [tmdbKey, setTmdbKey] = useState(() => getSetting('tmdb_api_key', 'b06102636e7efd95cfc1676d0d78c70a'));
    const [trailerSource, setTrailerSource] = useState(() => getSetting('netflix_ui_trailer_source', 'tmdb'));
    const [trailerLang, setTrailerLang] = useState(() => getSetting('netflix_ui_trailer_lang', 'en'));
    const [recSource, setRecSource] = useState(() => getSetting('netflix_ui_rec_source', 'tmdb'));
    const [autoPickEnabled, setAutoPickEnabled] = useState(() => getSetting('netflix_ui_autopick', 'false') === 'true');
    const [autoPickQuality, setAutoPickQuality] = useState(() => getSetting('netflix_ui_autopick_quality', '4k'));
    const [autoPickFallback, setAutoPickFallback] = useState(() => getSetting('netflix_ui_autopick_fallback', '1080p'));
    const [autoPickSource, setAutoPickSource] = useState(() => getSetting('netflix_ui_autopick_source', 'realdebrid'));
    const [debugEnabled, setDebugEnabled] = useState(() => getSetting('netflix_ui_debug', 'false') === 'true');
    const [saved, setSaved] = useState(false);

    // Trakt auth state
    const [authState, setAuthState] = useState<TraktAuthState>(() => {
        if (traktBridge.isConnected()) {
            return { phase: 'connected', username: traktBridge.getUsername() || 'connected' };
        }
        return { phase: 'disconnected' };
    });
    const [authError, setAuthError] = useState('');

    // Trakt client credentials
    const [traktClientId, setTraktClientId] = useState(() => traktBridge.getClientId());
    const [traktClientSecret, setTraktClientSecret] = useState(() => traktBridge.getClientSecret());

    // Sync status
    const [syncStatus, setSyncStatus] = useState<TestStatus>('idle');
    const [syncTip, setSyncTip] = useState('');

    // TMDB test status
    const [tmdbStatus, setTmdbStatus] = useState<TestStatus>('idle');
    const [tmdbTip, setTmdbTip] = useState('');
    const [trailerStatus, setTrailerStatus] = useState<TestStatus>('idle');
    const [trailerTip, setTrailerTip] = useState('');
    const [recStatus, setRecStatus] = useState<TestStatus>('idle');
    const [recTip, setRecTip] = useState('');

    const flashSaved = useCallback(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }, []);

    // Verify stored token on mount
    useEffect(() => {
        if (traktBridge.isConnected() && authState.phase === 'connected') {
            traktBridge.testConnection().then((result) => {
                if (result.ok && result.user?.username) {
                    setAuthState({ phase: 'connected', username: result.user.username });
                } else if (!result.ok && result.message?.includes('expired')) {
                    setAuthState({ phase: 'disconnected' });
                }
            });
        }
    }, []);

    // ─── Trakt OAuth: Device Code Flow ───
    const startTraktAuth = useCallback(async () => {
        setAuthError('');
        setAuthState({ phase: 'requesting' });

        try {
            const deviceData = await traktBridge.startDeviceAuth();
            // deviceData: { device_code, user_code, verification_url, expires_in, interval }

            setAuthState({
                phase: 'waiting',
                userCode: deviceData.user_code,
                verificationUrl: deviceData.verification_url,
            });

            // Open Trakt activation page in new tab
            window.open(deviceData.verification_url, '_blank');

            // Start polling
            await traktBridge.pollDeviceAuth(
                deviceData.device_code,
                deviceData.interval,
                deviceData.expires_in,
                (status: string) => {
                    if (status === 'success') {
                        // Fetch username
                        traktBridge.testConnection().then((result) => {
                            const username = result.user?.username || 'connected';
                            setAuthState({ phase: 'connected', username });
                        });
                    }
                }
            );

            // If we get here, auth succeeded
            const result = await traktBridge.testConnection();
            const username = result.user?.username || 'connected';
            setAuthState({ phase: 'connected', username });

            // Auto-sync after connecting
            try { await traktBridge.syncAll(true); } catch { /* */ }

        } catch (err: any) {
            setAuthError(err.message);
            setAuthState({ phase: 'disconnected' });
        }
    }, []);

    const cancelTraktAuth = useCallback(() => {
        traktBridge.cancelDevicePoll();
        setAuthState({ phase: 'disconnected' });
        setAuthError('');
    }, []);

    const disconnectTrakt = useCallback(() => {
        traktBridge.disconnect();
        setAuthState({ phase: 'disconnected' });
        setAuthError('');
        setSyncStatus('idle');
        setSyncTip('');
    }, []);

    // ─── Trakt Client Credentials ───
    const onTraktClientIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setTraktClientId(val);
        traktBridge.setClientId(val);
        flashSaved();
    }, []);

    const onTraktClientSecretChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setTraktClientSecret(val);
        traktBridge.setClientSecret(val);
        flashSaved();
    }, []);

    // ─── Handlers ───
    const onTmdbKeyChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setTmdbKey(val);
        setSetting('tmdb_api_key', val);
        flashSaved();
    }, []);

    const onTrailerSourceChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setTrailerSource(e.target.value);
        setSetting('netflix_ui_trailer_source', e.target.value);
        flashSaved();
    }, []);

    const onTrailerLangChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setTrailerLang(e.target.value);
        setSetting('netflix_ui_trailer_lang', e.target.value);
        flashSaved();
    }, []);

    const onRecSourceChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setRecSource(e.target.value);
        setSetting('netflix_ui_rec_source', e.target.value);
        flashSaved();
    }, []);

    const onAutoPickToggle = useCallback(() => {
        const next = !autoPickEnabled;
        setAutoPickEnabled(next);
        setSetting('netflix_ui_autopick', String(next));
        flashSaved();
    }, [autoPickEnabled]);

    const onAutoPickQualityChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setAutoPickQuality(e.target.value);
        setSetting('netflix_ui_autopick_quality', e.target.value);
        flashSaved();
    }, []);

    const onAutoPickFallbackChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setAutoPickFallback(e.target.value);
        setSetting('netflix_ui_autopick_fallback', e.target.value);
        flashSaved();
    }, []);

    const onAutoPickSourceChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setAutoPickSource(e.target.value);
        setSetting('netflix_ui_autopick_source', e.target.value);
        flashSaved();
    }, []);

    // ─── Debug toggle ───
    // Stored in localStorage for the in-app indicator + posted to the launcher's
    // CORS proxy (port 12470) which writes/removes a flag file the .exe checks
    // at startup to decide whether to attach a console window. Effect lands on
    // the next Stremio launch, not the current session.
    const onDebugToggle = useCallback(() => {
        const next = !debugEnabled;
        setDebugEnabled(next);
        setSetting('netflix_ui_debug', String(next));
        flashSaved();
        fetch('http://127.0.0.1:12470/_launcher/debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
        }).then((r) => {
            if (!r.ok) {
                toast?.show?.({ type: 'error', title: 'Debug toggle', message: `Launcher returned ${r.status}`, timeout: 4000 });
            }
        }).catch(() => {
            // Browser/dev mode without the launcher running — toggle is best-effort.
            toast?.show?.({
                type: 'info',
                title: 'Saved (UI only)',
                message: 'Run via the launcher for the console window to follow this setting.',
                timeout: 5000,
            });
        });
    }, [debugEnabled, toast]);

    // ─── Sync Trakt Data ───
    const syncTraktData = useCallback(async () => {
        if (!traktBridge.isConnected()) {
            setSyncStatus('error');
            setSyncTip('Not connected to Trakt');
            return;
        }
        setSyncStatus('loading');
        setSyncTip('Syncing...');
        try {
            await traktBridge.syncAll(true);
            const rated = traktBridge._ratedIds.size;
            const watched = traktBridge._watchedIds.size;
            setSyncStatus('success');
            setSyncTip(`Synced ${rated} rated, ${watched} watched`);
        } catch (err: any) {
            setSyncStatus('error');
            setSyncTip(err.message);
        }
    }, []);

    // ─── Test: TMDB API ───
    const testTmdbApi = useCallback(async () => {
        setTmdbStatus('loading');
        setTmdbTip('Testing...');
        try {
            const res = await fetch(`${TMDB_BASE}/configuration?api_key=${tmdbKey}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setTmdbStatus('success');
            setTmdbTip('API key is valid');
        } catch (err: any) {
            setTmdbStatus('error');
            setTmdbTip(err.message);
        }
    }, [tmdbKey]);

    // ─── Test: Trailer Fetch ───
    const testTrailerFetch = useCallback(async () => {
        setTrailerStatus('loading');
        setTrailerTip('Testing...');
        try {
            const findRes = await fetch(`${TMDB_BASE}/find/tt1375666?api_key=${tmdbKey}&external_source=imdb_id`);
            if (!findRes.ok) throw new Error(`Find API: ${findRes.status}`);
            const findData = await findRes.json();
            const tmdbId = findData.movie_results?.[0]?.id;
            if (!tmdbId) throw new Error('Could not resolve TMDB ID');

            const vidRes = await fetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${tmdbKey}&append_to_response=videos&language=${trailerLang}`);
            if (!vidRes.ok) throw new Error(`Videos API: ${vidRes.status}`);
            const vidData = await vidRes.json();
            const trailers = (vidData.videos?.results || []).filter((v: any) => v.type === 'Trailer' && v.site === 'YouTube');

            if (trailers.length === 0) throw new Error('No trailers found for Inception');

            setTrailerStatus('success');
            setTrailerTip(`Found ${trailers.length} trailer(s) — "${trailers[0].name}"`);
        } catch (err: any) {
            setTrailerStatus('error');
            setTrailerTip(err.message);
        }
    }, [tmdbKey, trailerLang]);

    // ─── Test: Recommendations ───
    const testRecommendations = useCallback(async () => {
        setRecStatus('loading');
        setRecTip('Testing...');
        try {
            const findRes = await fetch(`${TMDB_BASE}/find/tt1375666?api_key=${tmdbKey}&external_source=imdb_id`);
            if (!findRes.ok) throw new Error(`Find API: ${findRes.status}`);
            const findData = await findRes.json();
            const tmdbId = findData.movie_results?.[0]?.id;
            if (!tmdbId) throw new Error('Could not resolve TMDB ID');

            const recRes = await fetch(`${TMDB_BASE}/movie/${tmdbId}/recommendations?api_key=${tmdbKey}&language=${trailerLang}`);
            if (!recRes.ok) throw new Error(`Recommendations API: ${recRes.status}`);
            const recData = await recRes.json();
            const results = recData.results || [];

            if (results.length === 0) throw new Error('No recommendations returned');

            setRecStatus('success');
            setRecTip(`Found ${results.length} recommendations`);
        } catch (err: any) {
            setRecStatus('error');
            setRecTip(err.message);
        }
    }, [tmdbKey, trailerLang]);

    // ─── Copy user code to clipboard ───
    const copyCode = useCallback((code: string) => {
        navigator.clipboard?.writeText(code).then(() => {
            toast?.show?.({ type: 'success', title: 'Code copied to clipboard' });
        }).catch(() => {});
    }, []);

    return (
        <Section ref={ref} label={'Modern UI'}>
            {/* ─── Trakt ─── */}
            <div className={styles['section-divider']}>Trakt Integration</div>

            <Option label={'Account'}>
                {authState.phase === 'disconnected' && (
                    <div className={styles['trakt-auth-section']}>
                        <button
                            className={styles['connect-btn']}
                            onClick={startTraktAuth}
                        >
                            Connect to Trakt
                        </button>
                        {authError && (
                            <div className={styles['auth-error']}>{authError}</div>
                        )}
                    </div>
                )}

                {authState.phase === 'requesting' && (
                    <div className={styles['trakt-auth-section']}>
                        <div className={styles['auth-waiting']}>
                            <span className={styles['status-spinner']} />
                            <span>Requesting authorization code...</span>
                        </div>
                    </div>
                )}

                {authState.phase === 'waiting' && (
                    <div className={styles['trakt-auth-section']}>
                        <div className={styles['device-code-box']}>
                            <div className={styles['device-code-instruction']}>
                                Go to <a href={authState.verificationUrl} target="_blank" rel="noopener noreferrer" className={styles['auth-link']}>{authState.verificationUrl}</a> and enter:
                            </div>
                            <div
                                className={styles['device-code-display']}
                                onClick={() => copyCode(authState.userCode)}
                                title="Click to copy"
                            >
                                {authState.userCode}
                            </div>
                            <div className={styles['device-code-hint']}>Click code to copy • Waiting for authorization...</div>
                        </div>
                        <div className={styles['auth-waiting']}>
                            <span className={styles['status-spinner']} />
                            <span>Waiting for you to authorize on Trakt...</span>
                        </div>
                        <button className={styles['cancel-btn']} onClick={cancelTraktAuth}>
                            Cancel
                        </button>
                    </div>
                )}

                {authState.phase === 'connected' && (
                    <div className={styles['trakt-auth-section']}>
                        <div className={styles['connected-info']}>
                            <span className={styles['status-check']}>&#10003;</span>
                            <span className={styles['connected-username']}>
                                Connected as <strong>{authState.username}</strong>
                            </span>
                        </div>
                        <button className={styles['disconnect-btn']} onClick={disconnectTrakt}>
                            Disconnect
                        </button>
                    </div>
                )}
            </Option>

            {authState.phase === 'connected' && (
                <Option label={'Sync'}>
                    <div className={styles['input-row']}>
                        <span className={styles['option-desc']}>Pull ratings, watched &amp; watchlist from Trakt</span>
                        <button
                            className={styles['action-btn']}
                            onClick={syncTraktData}
                            disabled={syncStatus === 'loading'}
                        >
                            {syncStatus === 'loading' ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <StatusIcon status={syncStatus} tooltip={syncTip} />
                    </div>
                </Option>
            )}

            <Option label={'Client ID'}>
                <div className={styles['input-row']}>
                    <input
                        type="text"
                        className={styles['text-input']}
                        value={traktClientId}
                        onChange={onTraktClientIdChange}
                        placeholder="Trakt Client ID..."
                        spellCheck={false}
                    />
                </div>
            </Option>

            <Option label={'Client Secret'}>
                <div className={styles['input-row']}>
                    <input
                        type="password"
                        className={styles['text-input']}
                        value={traktClientSecret}
                        onChange={onTraktClientSecretChange}
                        placeholder="Trakt Client Secret..."
                        spellCheck={false}
                    />
                </div>
            </Option>

            {/* ─── Content ─── */}
            <div className={styles['section-divider']}>Content &amp; Discovery</div>

            <Option label={'TMDB API Key'}>
                <div className={styles['input-row']}>
                    <input
                        type="text"
                        className={styles['text-input']}
                        value={tmdbKey}
                        onChange={onTmdbKeyChange}
                        placeholder="TMDB API key..."
                        spellCheck={false}
                    />
                    <button
                        className={styles['action-btn']}
                        onClick={testTmdbApi}
                        disabled={tmdbStatus === 'loading'}
                    >
                        Test
                    </button>
                    <StatusIcon status={tmdbStatus} tooltip={tmdbTip} />
                </div>
            </Option>

            <Option label={'Trailer Source'}>
                <div className={styles['input-row']}>
                    <select className={styles['select-input']} value={trailerSource} onChange={onTrailerSourceChange}>
                        {TRAILER_SOURCES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                    <button
                        className={styles['action-btn']}
                        onClick={testTrailerFetch}
                        disabled={trailerStatus === 'loading'}
                    >
                        Test
                    </button>
                    <StatusIcon status={trailerStatus} tooltip={trailerTip} />
                </div>
            </Option>

            <Option label={'Trailer Language'}>
                <select className={styles['select-input']} value={trailerLang} onChange={onTrailerLangChange}>
                    {TRAILER_LANGUAGES.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                </select>
            </Option>

            <Option label={'Recommendations'}>
                <div className={styles['input-row']}>
                    <select className={styles['select-input']} value={recSource} onChange={onRecSourceChange}>
                        {REC_SOURCES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                    <button
                        className={styles['action-btn']}
                        onClick={testRecommendations}
                        disabled={recStatus === 'loading'}
                    >
                        Test
                    </button>
                    <StatusIcon status={recStatus} tooltip={recTip} />
                </div>
            </Option>

            {/* ─── Playback ─── */}
            <div className={styles['section-divider']}>Playback</div>

            <Option label={'Auto-Pick Stream'}>
                <div className={styles['input-row']}>
                    <span className={styles['option-desc']}>Automatically select the best available stream</span>
                    <button
                        className={autoPickEnabled ? styles['toggle-on'] : styles['toggle-off']}
                        onClick={onAutoPickToggle}
                    >
                        {autoPickEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
            </Option>

            {autoPickEnabled && (
                <>
                    <Option label={'Preferred Quality'}>
                        <select className={styles['select-input']} value={autoPickQuality} onChange={onAutoPickQualityChange}>
                            {QUALITY_OPTIONS.map((q) => (
                                <option key={q.value} value={q.value}>{q.label}</option>
                            ))}
                        </select>
                    </Option>

                    <Option label={'Fallback Quality'}>
                        <select className={styles['select-input']} value={autoPickFallback} onChange={onAutoPickFallbackChange}>
                            {QUALITY_OPTIONS.map((q) => (
                                <option key={q.value} value={q.value}>{q.label}</option>
                            ))}
                        </select>
                    </Option>

                    <Option label={'Preferred Source'}>
                        <select className={styles['select-input']} value={autoPickSource} onChange={onAutoPickSourceChange}>
                            {SOURCE_OPTIONS.map((s) => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                        </select>
                    </Option>
                </>
            )}

            {/* ─── Developer ─── */}
            <div className={styles['section-divider']}>Developer</div>

            <Option label={'Debug'}>
                <div className={styles['input-row']}>
                    <span className={styles['option-desc']}>Show the launcher console window. Takes effect on next Stremio start.</span>
                    <button
                        className={debugEnabled ? styles['toggle-on'] : styles['toggle-off']}
                        onClick={onDebugToggle}
                    >
                        {debugEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
            </Option>

            {saved && <div className={styles['saved-toast']}>Saved</div>}
        </Section>
    );
});

export default ModernUI;
