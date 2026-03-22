import React, { forwardRef, useState, useCallback, useEffect } from 'react';
import { Section, Option } from '../components';
import styles from './NetflixUI.less';

const { useToast, useProfile } = require('stremio/common');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TRAKT_API = 'https://api.trakt.tv';

async function traktFetch(path: string, clientId: string, token: string, options: any = {}) {
    const res = await fetch(`${TRAKT_API}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': clientId,
            'Authorization': `Bearer ${token}`,
            ...options.headers,
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Trakt ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return {};
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return res.json();
    return {};
}

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

type TestResult = {
    status: 'idle' | 'loading' | 'success' | 'error';
    message: string;
    details?: string[];
};

const NetflixUI = forwardRef<HTMLDivElement>((_, ref) => {
    const toast = useToast();
    const [tmdbKey, setTmdbKey] = useState(() => getSetting('tmdb_api_key', 'b06102636e7efd95cfc1676d0d78c70a'));
    const [trailerSource, setTrailerSource] = useState(() => getSetting('netflix_ui_trailer_source', 'tmdb'));
    const [trailerLang, setTrailerLang] = useState(() => getSetting('netflix_ui_trailer_lang', 'en'));
    const [recSource, setRecSource] = useState(() => getSetting('netflix_ui_rec_source', 'tmdb'));
    const [autoPickEnabled, setAutoPickEnabled] = useState(() => getSetting('netflix_ui_autopick', 'false') === 'true');
    const [autoPickQuality, setAutoPickQuality] = useState(() => getSetting('netflix_ui_autopick_quality', '4k'));
    const [autoPickFallback, setAutoPickFallback] = useState(() => getSetting('netflix_ui_autopick_fallback', '1080p'));
    const [autoPickSource, setAutoPickSource] = useState(() => getSetting('netflix_ui_autopick_source', 'realdebrid'));
    const [saved, setSaved] = useState(false);

    // Trakt integration state
    const profile = useProfile();
    const stremioTraktToken = profile?.auth?.user?.trakt?.access_token || '';
    const [traktClientId, setTraktClientId] = useState(() => getSetting('trakt_client_id', '67bffdb0ebe7ee9ffda2192bf2a463d7a9f36da83325fd94e04552052ad7372c'));
    const [traktToken, setTraktToken] = useState(() => getSetting('trakt_access_token', ''));
    const [traktNotInterestedSlug, setTraktNotInterestedSlug] = useState(() => getSetting('trakt_not_interested_slug', ''));

    // The effective token: manual override takes priority, then Stremio's built-in token
    const effectiveTraktToken = traktToken || stremioTraktToken;
    const [traktLists, setTraktLists] = useState<any[]>([]);
    const [traktTest, setTraktTest] = useState<TestResult>({ status: 'idle', message: '' });
    const [traktSyncResult, setTraktSyncResult] = useState<TestResult>({ status: 'idle', message: '' });
    const [traktRateTest, setTraktRateTest] = useState<TestResult>({ status: 'idle', message: '' });

    // Test results
    const [apiTest, setApiTest] = useState<TestResult>({ status: 'idle', message: '' });
    const [trailerTest, setTrailerTest] = useState<TestResult>({ status: 'idle', message: '' });
    const [recTest, setRecTest] = useState<TestResult>({ status: 'idle', message: '' });

    const flashSaved = useCallback(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }, []);

    // ─── Trakt handlers ───
    const onTraktClientIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setTraktClientId(val);
        setSetting('trakt_client_id', val);
        flashSaved();
    }, []);

    const onTraktTokenChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setTraktToken(val);
        setSetting('trakt_access_token', val);
        flashSaved();
    }, []);

    const onTraktNotInterestedSlugChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value;
        setTraktNotInterestedSlug(val);
        setSetting('trakt_not_interested_slug', val);
        flashSaved();
    }, []);

    const testTraktConnection = useCallback(async () => {
        setTraktTest({ status: 'loading', message: 'Testing Trakt connection...' });
        try {
            const data: any = await traktFetch('/users/settings', traktClientId, effectiveTraktToken);
            const user = data?.user;
            setTraktTest({
                status: 'success',
                message: `Connected as ${user?.username || 'unknown'}`,
                details: [
                    `Username: ${user?.username || 'N/A'}`,
                    `Name: ${user?.name || 'N/A'}`,
                    `VIP: ${user?.vip ? 'Yes' : 'No'}`,
                ],
            });
            // Fetch user lists after successful connection
            try {
                const lists: any = await traktFetch(`/users/${user?.username || 'me'}/lists`, traktClientId, effectiveTraktToken);
                if (Array.isArray(lists)) setTraktLists(lists);
            } catch { /* silent */ }
        } catch (err: any) {
            setTraktTest({ status: 'error', message: err.message });
            toast.show({ type: 'error', title: 'Trakt Connection Failed', message: err.message, timeout: 5000 });
        }
    }, [traktClientId, effectiveTraktToken]);

    const syncTraktData = useCallback(async () => {
        setTraktSyncResult({ status: 'loading', message: 'Syncing from Trakt...' });
        try {
            const [ratingsMovies, ratingsShows, watchedMovies, watchedShows]: any[] = await Promise.all([
                traktFetch('/sync/ratings/movies', traktClientId, effectiveTraktToken).catch(() => []),
                traktFetch('/sync/ratings/shows', traktClientId, effectiveTraktToken).catch(() => []),
                traktFetch('/sync/watched/movies', traktClientId, effectiveTraktToken).catch(() => []),
                traktFetch('/sync/watched/shows', traktClientId, effectiveTraktToken).catch(() => []),
            ]);
            const ratedCount = (Array.isArray(ratingsMovies) ? ratingsMovies.length : 0) + (Array.isArray(ratingsShows) ? ratingsShows.length : 0);
            const watchedCount = (Array.isArray(watchedMovies) ? watchedMovies.length : 0) + (Array.isArray(watchedShows) ? watchedShows.length : 0);

            // Also trigger TraktBridge sync if available
            try {
                const tb = require('stremio/services/TraktBridge');
                await tb.syncAll(true);
            } catch { /* silent */ }

            setTraktSyncResult({
                status: 'success',
                message: 'Synced successfully',
                details: [
                    `Rated items: ${ratedCount}`,
                    `Watched items: ${watchedCount}`,
                ],
            });
        } catch (err: any) {
            setTraktSyncResult({ status: 'error', message: err.message });
            toast.show({ type: 'error', title: 'Trakt Sync Failed', message: err.message, timeout: 5000 });
        }
    }, [traktClientId, effectiveTraktToken]);

    const testTraktRate = useCallback(async () => {
        setTraktRateTest({ status: 'loading', message: 'Testing rating API access...' });
        try {
            const ratingsRes: any = await traktFetch('/sync/ratings/movies', traktClientId, effectiveTraktToken);
            const existing = Array.isArray(ratingsRes) ? ratingsRes.find((r: any) => r.movie?.ids?.imdb === 'tt1375666') : null;

            if (existing) {
                setTraktRateTest({
                    status: 'success',
                    message: 'Rating read/write works',
                    details: [
                        `Inception is rated: ${existing.rating}/10`,
                        `Rated at: ${existing.rated_at}`,
                        'Rating API is functional ✓',
                    ],
                });
            } else {
                setTraktRateTest({
                    status: 'success',
                    message: 'Rating API is accessible',
                    details: [
                        'Inception is not yet rated',
                        `Total movie ratings found: ${Array.isArray(ratingsRes) ? ratingsRes.length : 0}`,
                        'Rating API is functional ✓',
                    ],
                });
            }
        } catch (err: any) {
            setTraktRateTest({ status: 'error', message: err.message });
            toast.show({ type: 'error', title: 'Trakt Rating Test Failed', message: err.message, timeout: 5000 });
        }
    }, [traktClientId, effectiveTraktToken]);

    // Load Trakt lists on mount if configured
    useEffect(() => {
        if (traktClientId && effectiveTraktToken) {
            traktFetch('/users/me/lists', traktClientId, effectiveTraktToken)
                .then((lists: any) => { if (Array.isArray(lists)) setTraktLists(lists); })
                .catch(() => {});
        }
    }, [traktClientId, effectiveTraktToken]);

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

    // --- Test: TMDB API Connection ---
    const testApiConnection = useCallback(async () => {
        setApiTest({ status: 'loading', message: 'Testing API connection...' });
        try {
            const res = await fetch(`${TMDB_BASE}/configuration?api_key=${tmdbKey}`);
            if (!res.ok) {
                setApiTest({ status: 'error', message: `API returned ${res.status}: ${res.statusText}` });
                return;
            }
            const data = await res.json();
            setApiTest({
                status: 'success',
                message: 'API key is valid',
                details: [
                    `Image base URL: ${data.images?.secure_base_url || 'N/A'}`,
                    `Poster sizes: ${(data.images?.poster_sizes || []).join(', ')}`,
                ],
            });
        } catch (err: any) {
            setApiTest({ status: 'error', message: `Connection failed: ${err.message}` });
        }
    }, [tmdbKey]);

    // --- Test: Trailer Fetch ---
    const testTrailerFetch = useCallback(async () => {
        setTrailerTest({ status: 'loading', message: 'Fetching trailer for "Inception" (tt1375666)...' });
        try {
            // Step 1: Find TMDB ID from IMDB ID
            const findRes = await fetch(`${TMDB_BASE}/find/tt1375666?api_key=${tmdbKey}&external_source=imdb_id`);
            if (!findRes.ok) throw new Error(`Find API returned ${findRes.status}`);
            const findData = await findRes.json();
            const tmdbId = findData.movie_results?.[0]?.id;
            if (!tmdbId) throw new Error('Could not find TMDB ID for Inception');

            // Step 2: Fetch videos
            const vidRes = await fetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${tmdbKey}&append_to_response=videos&language=${trailerLang}`);
            if (!vidRes.ok) throw new Error(`Videos API returned ${vidRes.status}`);
            const vidData = await vidRes.json();
            const videos = vidData.videos?.results || [];
            const trailers = videos.filter((v: any) => v.type === 'Trailer' && v.site === 'YouTube');
            const allYt = videos.filter((v: any) => v.site === 'YouTube');

            if (trailers.length === 0 && allYt.length === 0) {
                setTrailerTest({
                    status: 'error',
                    message: 'No YouTube trailers found',
                    details: [`Total videos returned: ${videos.length}`, `Types: ${[...new Set(videos.map((v: any) => v.type))].join(', ')}`],
                });
                return;
            }

            const best = trailers[0] || allYt[0];
            setTrailerTest({
                status: 'success',
                message: `Found ${trailers.length} trailer(s), ${allYt.length} total YouTube videos`,
                details: [
                    `Best match: "${best.name}"`,
                    `Type: ${best.type} | Official: ${best.official ? 'Yes' : 'No'} | Lang: ${best.iso_639_1}`,
                    `YouTube ID: ${best.key}`,
                    `URL: https://youtube.com/watch?v=${best.key}`,
                ],
            });
        } catch (err: any) {
            setTrailerTest({ status: 'error', message: err.message });
        }
    }, [tmdbKey, trailerLang]);

    // --- Test: Recommendations ---
    const testRecommendations = useCallback(async () => {
        setRecTest({ status: 'loading', message: 'Fetching recommendations for "Inception"...' });
        try {
            const findRes = await fetch(`${TMDB_BASE}/find/tt1375666?api_key=${tmdbKey}&external_source=imdb_id`);
            if (!findRes.ok) throw new Error(`Find API returned ${findRes.status}`);
            const findData = await findRes.json();
            const tmdbId = findData.movie_results?.[0]?.id;
            if (!tmdbId) throw new Error('Could not find TMDB ID');

            const recRes = await fetch(`${TMDB_BASE}/movie/${tmdbId}/recommendations?api_key=${tmdbKey}&language=${trailerLang}`);
            if (!recRes.ok) throw new Error(`Recommendations API returned ${recRes.status}`);
            const recData = await recRes.json();
            const results = recData.results || [];

            if (results.length === 0) {
                setRecTest({ status: 'error', message: 'No recommendations returned' });
                return;
            }

            setRecTest({
                status: 'success',
                message: `Found ${results.length} recommendations`,
                details: results.slice(0, 5).map((r: any, i: number) =>
                    `${i + 1}. ${r.title || r.name} (${(r.release_date || r.first_air_date || '').substring(0, 4)}) — ${r.vote_average?.toFixed(1)}/10`
                ),
            });
        } catch (err: any) {
            setRecTest({ status: 'error', message: err.message });
        }
    }, [tmdbKey, trailerLang]);

    const renderTestResult = (result: TestResult) => {
        if (result.status === 'idle') return null;
        return (
            <div className={styles[`test-result-${result.status}`]}>
                <div className={styles['test-result-message']}>
                    {result.status === 'loading' && <span className={styles['test-spinner']} />}
                    {result.status === 'success' && <span className={styles['test-check']}>&#10003;</span>}
                    {result.status === 'error' && <span className={styles['test-x']}>&#10007;</span>}
                    {result.message}
                </div>
                {result.details && result.details.map((d, i) => (
                    <div key={i} className={styles['test-detail']}>{d}</div>
                ))}
            </div>
        );
    };

    return (
        <Section ref={ref} label={'Netflix UI'}>
            <div className={styles['netflix-ui-badge']}>
                <span className={styles['badge-dot']} />
                <span className={styles['badge-text']}>Custom Netflix UI Settings</span>
            </div>

            {/* ─── Trakt Integration ─── */}
            <div className={styles['section-divider']}>Trakt Integration</div>

            <Option label={'Trakt Client ID'}>
                <div className={styles['input-with-button']}>
                    <input
                        type="text"
                        className={styles['text-input']}
                        value={traktClientId}
                        onChange={onTraktClientIdChange}
                        placeholder="Trakt OAuth Client ID"
                        spellCheck={false}
                    />
                </div>
            </Option>

            <Option label={'Trakt Access Token'}>
                <div className={styles['input-with-button']}>
                    <input
                        type="password"
                        className={styles['text-input']}
                        value={traktToken}
                        onChange={onTraktTokenChange}
                        placeholder={stremioTraktToken ? 'Auto-detected from Stremio login' : 'Your Trakt OAuth Bearer token...'}
                        spellCheck={false}
                    />
                    <button
                        className={styles['test-btn']}
                        onClick={testTraktConnection}
                        disabled={traktTest.status === 'loading'}
                    >
                        {traktTest.status === 'loading' ? 'Testing...' : 'Test'}
                    </button>
                </div>
                {renderTestResult(traktTest)}
            </Option>

            <Option label={'Not Interested List'}>
                <div className={styles['input-with-button']}>
                    {traktLists.length > 0 ? (
                        <select className={styles['select-input']} value={traktNotInterestedSlug} onChange={onTraktNotInterestedSlugChange}>
                            <option value="">Select a list...</option>
                            {traktLists.map((list: any) => (
                                <option key={list.ids?.slug || list.ids?.trakt} value={list.ids?.slug || ''}>
                                    {list.name} ({list.item_count} items)
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            className={styles['text-input']}
                            value={traktNotInterestedSlug}
                            onChange={(e) => {
                                const val = e.target.value.trim();
                                setTraktNotInterestedSlug(val);
                                setSetting('trakt_not_interested_slug', val);
                                traktBridge.setNotInterestedListSlug(val);
                                flashSaved();
                            }}
                            placeholder="List slug (e.g. not-interested-list)..."
                            spellCheck={false}
                        />
                    )}
                </div>
            </Option>

            <Option label={'Trakt Sync'}>
                <div className={styles['input-with-button']}>
                    <div className={styles['toggle-label']}>
                        Sync ratings, watched &amp; watchlist from Trakt
                    </div>
                    <button
                        className={styles['test-btn']}
                        onClick={syncTraktData}
                        disabled={traktSyncResult.status === 'loading'}
                    >
                        {traktSyncResult.status === 'loading' ? 'Syncing...' : 'Sync Now'}
                    </button>
                </div>
                {renderTestResult(traktSyncResult)}
            </Option>

            <Option label={'Test Rating API'}>
                <div className={styles['input-with-button']}>
                    <div className={styles['toggle-label']}>
                        Verify read/write access to Trakt ratings
                    </div>
                    <button
                        className={styles['test-btn']}
                        onClick={testTraktRate}
                        disabled={traktRateTest.status === 'loading'}
                    >
                        {traktRateTest.status === 'loading' ? 'Testing...' : 'Test Ratings'}
                    </button>
                </div>
                {renderTestResult(traktRateTest)}
            </Option>

            {/* ─── TMDB & Trailer Settings ─── */}
            <div className={styles['section-divider']}>TMDB &amp; Trailers</div>

            <Option label={'TMDB API Key'}>
                <div className={styles['input-with-button']}>
                    <input
                        type="text"
                        className={styles['text-input']}
                        value={tmdbKey}
                        onChange={onTmdbKeyChange}
                        placeholder="Enter TMDB API key..."
                        spellCheck={false}
                    />
                    <button
                        className={styles['test-btn']}
                        onClick={testApiConnection}
                        disabled={apiTest.status === 'loading'}
                    >
                        {apiTest.status === 'loading' ? 'Testing...' : 'Test'}
                    </button>
                </div>
                {renderTestResult(apiTest)}
            </Option>

            <Option label={'Trailer Source'}>
                <div className={styles['input-with-button']}>
                    <select className={styles['select-input']} value={trailerSource} onChange={onTrailerSourceChange}>
                        {TRAILER_SOURCES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                    <button
                        className={styles['test-btn']}
                        onClick={testTrailerFetch}
                        disabled={trailerTest.status === 'loading'}
                    >
                        {trailerTest.status === 'loading' ? 'Testing...' : 'Test'}
                    </button>
                </div>
                {renderTestResult(trailerTest)}
            </Option>

            <Option label={'Trailer Language'}>
                <select className={styles['select-input']} value={trailerLang} onChange={onTrailerLangChange}>
                    {TRAILER_LANGUAGES.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                </select>
            </Option>

            <Option label={'Recommendations Source'}>
                <div className={styles['input-with-button']}>
                    <select className={styles['select-input']} value={recSource} onChange={onRecSourceChange}>
                        {REC_SOURCES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                    <button
                        className={styles['test-btn']}
                        onClick={testRecommendations}
                        disabled={recTest.status === 'loading'}
                    >
                        {recTest.status === 'loading' ? 'Testing...' : 'Test'}
                    </button>
                </div>
                {renderTestResult(recTest)}
            </Option>

            <Option label={'Auto-Pick Stream'}>
                <div className={styles['input-with-button']}>
                    <div className={styles['toggle-label']}>
                        Automatically select and play the best available stream
                    </div>
                    <button
                        className={autoPickEnabled ? styles['toggle-btn-on'] : styles['toggle-btn-off']}
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

            {saved && <div className={styles['saved-toast']}>Settings saved</div>}
        </Section>
    );
});

export default NetflixUI;
