import React, { forwardRef, useState, useCallback } from 'react';
import { Section, Option } from '../components';
import styles from './NetflixUI.less';

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
    const [tmdbKey, setTmdbKey] = useState(() => getSetting('tmdb_api_key', 'b06102636e7efd95cfc1676d0d78c70a'));
    const [trailerSource, setTrailerSource] = useState(() => getSetting('netflix_ui_trailer_source', 'tmdb'));
    const [trailerLang, setTrailerLang] = useState(() => getSetting('netflix_ui_trailer_lang', 'en'));
    const [recSource, setRecSource] = useState(() => getSetting('netflix_ui_rec_source', 'tmdb'));
    const [autoPickEnabled, setAutoPickEnabled] = useState(() => getSetting('netflix_ui_autopick', 'false') === 'true');
    const [autoPickQuality, setAutoPickQuality] = useState(() => getSetting('netflix_ui_autopick_quality', '4k'));
    const [autoPickFallback, setAutoPickFallback] = useState(() => getSetting('netflix_ui_autopick_fallback', '1080p'));
    const [autoPickSource, setAutoPickSource] = useState(() => getSetting('netflix_ui_autopick_source', 'realdebrid'));
    const [saved, setSaved] = useState(false);

    // Test results
    const [apiTest, setApiTest] = useState<TestResult>({ status: 'idle', message: '' });
    const [trailerTest, setTrailerTest] = useState<TestResult>({ status: 'idle', message: '' });
    const [recTest, setRecTest] = useState<TestResult>({ status: 'idle', message: '' });

    const flashSaved = useCallback(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }, []);

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
