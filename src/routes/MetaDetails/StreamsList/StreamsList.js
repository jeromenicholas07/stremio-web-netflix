// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { useTranslation } = require('react-i18next');
const { useRouteFocused } = require('stremio-router');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button, Image, MultiselectMenu, AutoPickEditor, Toggle } = require('stremio/components');
const { useServices } = require('stremio/services');
const Stream = require('./Stream');
const styles = require('./styles');
const { usePlatform, useProfile, useStreamingServer } = require('stremio/common');
const {
    clearAutoPickFailures,
    clearAutoPickFailure,
    clearAutoPickSelection,
    describeStream,
    detectAvailability,
    detectIsForeign,
    formatAutoPickSkipSummary,
    getAutoPickFailures,
    getAutoPickOverride,
    getGlobalAutoPickSettings,
    setGlobalAutoPickSettings,
    getQualityLabel,
    getSourceLabel,
    getStreamKey,
    getStreamAttemptNumber,
    getTopEnabledSourceKey,
    normalizeSettings,
    pickBestStream,
    setAutoPickOverride,
    storeAutoPickSelection,
} = require('stremio/common/autoPick');
const { preflightAutoPickStream } = require('stremio/common/streamPreflight');
const {
    CLEAN_RUNS_TO_CLEAR,
    getCopyrightCheckState,
    recordCopyrightCheckRun,
    setCopyrightCheckManual,
} = require('stremio/common/copyrightCheckHistory');
const { default: SeasonEpisodePicker } = require('../EpisodePicker');

const ALL_ADDONS_KEY = 'ALL';

// After the last addon reports, wait this long so streams that arrive in the
// same render batch are all considered before the candidate walk begins.
const AUTOPICK_SETTLE_MS = 500;
// Hard cap on how long auto-pick waits for addons. If one addon hangs in a
// Loading state, proceed with whatever has loaded rather than waiting forever.
const AUTOPICK_MAX_WAIT_MS = 12000;

function isPlaybackOrStreamsHash(hash) {
    const path = (hash || '').slice(1).split('?')[0];
    return /^\/player\//.test(path) || /^\/(?:metadetails|detail)\/[^/]*\/[^/]*\/[^/]*$/.test(path);
}

const StreamsList = ({ className, video, type, metaId, onEpisodeSearch, queryParams, ...props }) => {
    const { t } = useTranslation();
    const { core } = useServices();
    const platform = usePlatform();
    const profile = useProfile();
    const streamingServer = useStreamingServer();
    const routeFocused = useRouteFocused();
    const streamsContainerRef = React.useRef(null);
    const skipBackGuardRef = React.useRef(false);
    const [selectedAddon, setSelectedAddon] = React.useState(ALL_ADDONS_KEY);
    const [overrideSettings, setOverrideSettingsState] = React.useState(() => getAutoPickOverride(type, metaId));
    // Global defaults kept in state so the in-panel master toggle updates the UI
    // immediately (and the per-show effective settings recompute) without a
    // round-trip through the Settings page.
    const [globalSettings, setGlobalSettingsState] = React.useState(() => getGlobalAutoPickSettings());
    // Panel open state is session-only. Persisting it (as we briefly did) left
    // autoPickPanelOpen=true across launches and blocked auto-pick entirely.
    const [autoPickPanelOpen, setAutoPickPanelOpen] = React.useState(false);
    const toggleAutoPickPanel = React.useCallback(() => {
        setAutoPickPanelOpen((open) => !open);
    }, []);
    const onAddonSelected = React.useCallback((value) => {
        streamsContainerRef.current.scrollTo({ top: 0, left: 0, behavior: platform.name === 'ios' ? 'smooth' : 'instant' });
        setSelectedAddon(value);
    }, [platform]);
    React.useEffect(() => {
        if (typeof type !== 'string' || !type || typeof metaId !== 'string' || !metaId) return;
        setOverrideSettingsState(getAutoPickOverride(type, metaId));
        setGlobalSettingsState(getGlobalAutoPickSettings());
    }, [type, metaId]);
    const effectiveAutoPickSettings = React.useMemo(() => {
        return overrideSettings || globalSettings;
    }, [overrideSettings, globalSettings]);
    const isCustomMode = overrideSettings !== null;
    // Sources switched off in the global settings are hidden from the per-show
    // Custom editor so unused debrid services (e.g. AllDebrid) don't crowd it.
    const hiddenSourceKeys = React.useMemo(() => {
        return globalSettings.sources
            .filter((source) => !source.enabled)
            .map((source) => source.key);
    }, [globalSettings]);
    // Per-show copyright check. Automatic by default: a show whose top pick has
    // come back clean often enough stops being probed, and any observed block
    // puts the probe straight back. The toggle below writes a manual override
    // on top of that, which a block also clears (see copyrightCheckHistory).
    const [copyrightCheck, setCopyrightCheckState] = React.useState(() => getCopyrightCheckState(type, metaId));
    React.useEffect(() => {
        setCopyrightCheckState(getCopyrightCheckState(type, metaId));
    }, [type, metaId]);
    const onCopyrightCheckToggle = React.useCallback(() => {
        const next = !copyrightCheck.enabled;
        // Choosing the value automation would have picked anyway just hands the
        // show back to automatic rather than pinning it there.
        setCopyrightCheckState(setCopyrightCheckManual(type, metaId, next === copyrightCheck.auto ? null : next));
    }, [type, metaId, copyrightCheck]);
    const onAutoPickModeChange = React.useCallback((custom) => {
        if (custom) {
            const base = overrideSettings || globalSettings;
            setAutoPickOverride(type, metaId, base);
            const saved = getAutoPickOverride(type, metaId) || normalizeSettings(base);
            setOverrideSettingsState(saved);
            setAutoPickPanelOpen(true);
        } else {
            setAutoPickOverride(type, metaId, null);
            setOverrideSettingsState(null);
        }
    }, [type, metaId, overrideSettings, globalSettings]);
    const onOverrideChange = React.useCallback((next) => {
        const normalized = normalizeSettings(next);
        setAutoPickOverride(type, metaId, normalized);
        // Keep in-memory custom state even when storage writes fail (common in
        // the Stremio shell webview). Without the fallback, every editor click
        // set overrideSettingsState to null and snapped back to Global.
        setOverrideSettingsState(getAutoPickOverride(type, metaId) || normalized);
    }, [type, metaId]);
    // Master on/off lives on whichever scope is active: the per-show override in
    // Custom mode, the shared global defaults otherwise.
    const onAutoPickEnabledToggle = React.useCallback(() => {
        if (overrideSettings) {
            onOverrideChange({ ...overrideSettings, enabled: !overrideSettings.enabled });
        } else {
            setGlobalSettingsState(setGlobalAutoPickSettings({ enabled: !globalSettings.enabled }));
        }
    }, [overrideSettings, globalSettings, onOverrideChange]);
    const showInstallAddonsButton = React.useMemo(() => {
        return !profile || profile.auth === null || profile.auth?.user?.isNewUser === true && !video?.upcoming;
    }, [profile, video]);
    const backDestination = React.useMemo(() => {
        if (video?.deepLinks && typeof video.deepLinks.metaDetailsVideos === 'string') {
            return video.deepLinks.metaDetailsVideos + (
                typeof video.season === 'number' ?
                    `?${new URLSearchParams({ 'season': video.season })}`
                    :
                    ''
            );
        }

        return '#/';
    }, [video]);
    const backButtonOnClick = React.useCallback(() => {
        window.location.replace(backDestination);
    }, [backDestination]);
    React.useEffect(() => {
        if (!routeFocused) return undefined;

        const onHashChange = () => {
            if (skipBackGuardRef.current) {
                skipBackGuardRef.current = false;
                return;
            }

            if (isPlaybackOrStreamsHash(window.location.hash)) {
                window.location.replace(backDestination);
            }
        };

        window.addEventListener('hashchange', onHashChange);
        return () => {
            window.removeEventListener('hashchange', onHashChange);
        };
    }, [routeFocused, backDestination]);
    const countLoadingAddons = React.useMemo(() => {
        return props.streams.filter((stream) => stream.content.type === 'Loading').length;
    }, [props.streams]);
    const streamsByAddon = React.useMemo(() => {
        return props.streams
            .filter((streams) => streams.content.type === 'Ready')
            .reduce((streamsByAddon, streams) => {
                streamsByAddon[streams.addon.transportUrl] = {
                    addon: streams.addon,
                    streams: streams.content.content.map((stream) => ({
                        ...stream,
                        onClick: () => {
                            core.transport.analytics({
                                event: 'StreamClicked',
                                args: {
                                    stream
                                }
                            });
                        },
                        addonName: streams.addon.manifest.name
                    }))
                };

                return streamsByAddon;
            }, {});
    }, [props.streams]);
    const filteredStreams = React.useMemo(() => {
        const base = selectedAddon === ALL_ADDONS_KEY ?
            Object.values(streamsByAddon).map(({ streams }) => streams).flat(1)
            :
            streamsByAddon[selectedAddon] ?
                streamsByAddon[selectedAddon].streams
                :
                [];

        if (!effectiveAutoPickSettings.englishOnly) {
            return base;
        }

        // Keep foreign-language releases in the list but sink them below the
        // English ones (stable: original order preserved within each group).
        // Auto-pick still skips them entirely via rankStream.
        const english = [];
        const foreign = [];
        base.forEach((stream) => {
            (detectIsForeign(stream) ? foreign : english).push(stream);
        });
        return english.concat(foreign);
    }, [streamsByAddon, selectedAddon, effectiveAutoPickSettings.englishOnly]);
    // Auto-pick always walks the full merged list (all addons), independent of
    // the addon filter dropdown the user may have selected for browsing.
    const autoPickStreams = React.useMemo(() => {
        const base = Object.values(streamsByAddon).map(({ streams }) => streams).flat(1);

        if (!effectiveAutoPickSettings.englishOnly) {
            return base;
        }

        const english = [];
        const foreign = [];
        base.forEach((stream) => {
            (detectIsForeign(stream) ? foreign : english).push(stream);
        });
        return english.concat(foreign);
    }, [streamsByAddon, effectiveAutoPickSettings.englishOnly]);
    const selectableOptions = React.useMemo(() => {
        return {
            options: [
                {
                    value: ALL_ADDONS_KEY,
                    label: t('ALL_ADDONS'),
                    title: t('ALL_ADDONS')
                },
                ...Object.keys(streamsByAddon).map((transportUrl) => ({
                    value: transportUrl,
                    label: streamsByAddon[transportUrl].addon.manifest.name,
                    title: streamsByAddon[transportUrl].addon.manifest.name,
                }))
            ],
            value: selectedAddon,
            onSelect: onAddonSelected
        };
    }, [streamsByAddon, selectedAddon]);
    const onManualStreamClick = React.useCallback((stream) => {
        skipBackGuardRef.current = true;
        setTimeout(() => {
            skipBackGuardRef.current = false;
        }, 1000);
        clearAutoPickSelection(type, metaId, video?.id);
        if (video?.id) {
            clearAutoPickFailure(type, metaId, video.id, getStreamKey(stream));
        }
        if (typeof stream.onClick === 'function') {
            stream.onClick();
        }
    }, [type, metaId, video?.id]);

    // ─── Available options detected from the actually-loaded streams ───
    const allReadyStreams = React.useMemo(() => {
        return Object.values(streamsByAddon).map(({ streams }) => streams).flat(1);
    }, [streamsByAddon]);
    const availability = React.useMemo(() => {
        return detectAvailability(allReadyStreams, effectiveAutoPickSettings);
    }, [allReadyStreams, effectiveAutoPickSettings]);

    // ─── Auto-pick best stream ───
    // Solid flow:
    //   1. Wait until every stream addon has reported (countLoadingAddons === 0),
    //      then settle briefly so same-tick batches merge — or bail out of the
    //      wait after a hard cap so a single hung addon can't block forever.
    //   2. Walk the merged candidate list in strict priority order.
    //   3. Preflight each candidate; skip only confirmed copyright stubs.
    //   4. Play the first candidate that isn't a confirmed stub.
    // The driver effect is keyed on a STABLE content signature (not the array
    // reference) so it doesn't thrash/restart on every unrelated re-render, and
    // preflight-blocked keys persist in a ref so restarts never re-pick them.
    const autoPickTriggered = React.useRef(false);
    const blockedKeysRef = React.useRef(new Set());
    const waitStartRef = React.useRef(Date.now());
    const [autoPickInfo, setAutoPickInfo] = React.useState(null);
    const [autoPickReady, setAutoPickReady] = React.useState(false);
    const retryToken = queryParams?.get('autopickRetry') || null;
    const retryReason = queryParams?.get('autopickReason') || null;
    const failedCount = React.useMemo(() => {
        return video?.id ? getAutoPickFailures(type, metaId, video.id).length : 0;
        // retryToken changes whenever a new failure was recorded before redirect.
    }, [type, metaId, video?.id, retryToken]);
    const autoPickStateKey = React.useMemo(() => {
        return [
            type,
            metaId,
            video?.id,
            retryToken,
            JSON.stringify(effectiveAutoPickSettings),
        ].join('|');
    }, [type, metaId, video?.id, retryToken, effectiveAutoPickSettings]);
    // Stable signature of the candidate set — only changes when the actual
    // streams change, so the driver effect won't re-run on cosmetic re-renders.
    const autoPickSignature = React.useMemo(() => {
        return autoPickStreams.map(getStreamKey).join('\u241F');
    }, [autoPickStreams]);
    // Reset per-title state whenever the title/episode/settings/retry changes.
    React.useEffect(() => {
        autoPickTriggered.current = false;
        blockedKeysRef.current = new Set();
        waitStartRef.current = Date.now();
        setAutoPickReady(false);
        setAutoPickInfo(null);
    }, [autoPickStateKey]);
    // Readiness gate: ready once all addons settle, or after a hard cap.
    React.useEffect(() => {
        if (autoPickStreams.length === 0 && countLoadingAddons > 0) {
            setAutoPickReady(false);
        }
        if (countLoadingAddons === 0) {
            const settle = setTimeout(() => setAutoPickReady(true), AUTOPICK_SETTLE_MS);
            return () => clearTimeout(settle);
        }
        // Some addon is still loading — proceed anyway once the hard cap elapses.
        const elapsed = Date.now() - waitStartRef.current;
        const remaining = Math.max(0, AUTOPICK_MAX_WAIT_MS - elapsed);
        const cap = setTimeout(() => setAutoPickReady(true), remaining);
        return () => clearTimeout(cap);
    }, [countLoadingAddons, autoPickStreams.length, autoPickStateKey]);
    React.useEffect(() => {
        if (autoPickTriggered.current) return;
        // Don't auto-pick when user clicked "More Info" (info=1) or paused it.
        if (queryParams && queryParams.has('info')) return;
        if (queryParams && queryParams.has('autopickPaused')) return;

        const settings = effectiveAutoPickSettings.enabled ? effectiveAutoPickSettings : null;
        if (!settings) return;

        const topSourceKey = getTopEnabledSourceKey(settings);

        // Still waiting for addons to load/settle — show the waiting banner.
        if (!autoPickReady) {
            setAutoPickInfo({
                waiting: true,
                settling: countLoadingAddons === 0,
                sourceLabel: getSourceLabel(topSourceKey),
            });
            return undefined;
        }

        if (autoPickStreams.length === 0) return;

        // Fresh (non-retry) entry: drop any stale persisted player failures so
        // we always start the walk from the true top candidate.
        if (!retryToken && video?.id) {
            clearAutoPickFailures(type, metaId, video.id);
        }

        let cancelled = false;
        const controller = new AbortController();

        const commit = (best, described, attempt, blockedCount) => {
            autoPickTriggered.current = true;
            setAutoPickInfo({
                attempt,
                blockedCount,
                qualityLabel: described.qualityLabel,
                sourceLabel: described.sourceLabel,
            });
            storeAutoPickSelection({
                type,
                metaId,
                videoId: video?.id,
                stream: best,
                settings,
            });
            if (typeof best.onClick === 'function') best.onClick();
            if (profile.settings.playerType !== null) {
                core.transport.dispatch({
                    action: 'MetaDetails',
                    args: {
                        action: 'MarkVideoAsWatched',
                        args: [{ id: video?.id, released: video?.released }, true]
                    }
                });
            }
            // Small delay so the user sees what was picked.
            setTimeout(() => {
                if (cancelled) return;
                skipBackGuardRef.current = true;
                setTimeout(() => {
                    skipBackGuardRef.current = false;
                }, 1000);
                window.location = best.deepLinks.player;
            }, 800);
        };

        const run = async () => {
            // Seed skips from persisted player failures (this title) + any
            // preflight blocks remembered from a previous run of this effect.
            const failedSet = new Set([
                ...(video?.id ? getAutoPickFailures(type, metaId, video.id).map(({ streamKey }) => streamKey) : []),
                ...blockedKeysRef.current,
            ]);

            // Read straight from storage rather than the render closure so a
            // toggle flipped moments ago is honoured without restarting the run.
            const shouldCheckCopyright = getCopyrightCheckState(type, metaId).enabled;
            // Only the first definite verdict of a run feeds the history, and
            // only on a fresh entry: a retry run starts below the true top pick
            // (it is here *because* something was blocked), so a clean result
            // there says nothing about how this show usually behaves.
            const canRecordRun = !retryToken;
            let recordedRun = false;

            while (!cancelled) {
                const best = pickBestStream(autoPickStreams, settings, {
                    failedStreamKeys: Array.from(failedSet),
                    // iOS Safari can only play a subset of formats inline; prefer
                    // web-playable releases so auto-pick avoids kicking out to an
                    // external player. No-op on every other platform.
                    preferWebPlayable: platform.name === 'ios',
                });
                const blockedCount = blockedKeysRef.current.size;

                if (!best || !best.deepLinks?.player) {
                    // Nothing left to try. If addons are still arriving, keep
                    // waiting; otherwise report a clean failure.
                    if (countLoadingAddons > 0) {
                        setAutoPickInfo({
                            waiting: true,
                            settling: true,
                            sourceLabel: getSourceLabel(getTopEnabledSourceKey(settings)),
                        });
                        return;
                    }
                    autoPickTriggered.current = true;
                    setAutoPickInfo({ failed: true, blockedCount });
                    return;
                }

                const described = describeStream(best, settings);
                const attempt = getStreamAttemptNumber(autoPickStreams, best);

                // This show is trusted (or the user turned the check off) —
                // play without probing. If we are wrong, the player reports a
                // copyright error, which records a block and bounces back here
                // with checking switched on again.
                if (!shouldCheckCopyright) {
                    commit(best, described, attempt, blockedCount);
                    return;
                }

                setAutoPickInfo({
                    attempt,
                    blockedCount,
                    qualityLabel: described.qualityLabel,
                    sourceLabel: described.sourceLabel,
                    checking: true,
                });

                const verdict = await preflightAutoPickStream({
                    core,
                    stream: best,
                    ssBaseUrl: streamingServer.baseUrl,
                    signal: controller.signal,
                });
                if (cancelled) return;

                // An inconclusive probe has no `blocked` field and is not
                // evidence either way, so it never feeds the history.
                if (canRecordRun && !recordedRun && typeof verdict.blocked === 'boolean') {
                    recordedRun = true;
                    setCopyrightCheckState(recordCopyrightCheckRun(type, metaId, { clean: !verdict.blocked }));
                }

                if (verdict.blocked) {
                    // Confirmed copyright stub — remember it and try the next.
                    blockedKeysRef.current.add(getStreamKey(best));
                    failedSet.add(getStreamKey(best));
                    continue;
                }

                // Real media (or preflight inconclusive → fail open) — play it.
                commit(best, described, attempt, blockedKeysRef.current.size);
                return;
            }
        };

        run();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [autoPickSignature, autoPickReady, countLoadingAddons, autoPickStateKey]);

    const handleEpisodePicker = React.useCallback((season, episode) => {
        onEpisodeSearch(season, episode);
    }, [onEpisodeSearch]);

    const autoPickSummary = React.useMemo(() => {
        const sources = effectiveAutoPickSettings.sources.filter((s) => s.enabled).map((s) => getSourceLabel(s.key));
        const qualities = effectiveAutoPickSettings.qualities.filter((q) => q.enabled).map((q) => getQualityLabel(q.key));
        return {
            sources: sources.length > 0 ? sources.join(' \u203A ') : 'None',
            qualities: qualities.length > 0 ? qualities.join(' \u203A ') : 'None',
        };
    }, [effectiveAutoPickSettings]);

    const copyrightCheckHint = React.useMemo(() => {
        if (!copyrightCheck.enabled) {
            return copyrightCheck.manual === false ?
                'Off for this show, whatever its history.'
                :
                'Off — plays the top stream straight away. Turns itself on if this show ever serves a copyright-blocked file.';
        }

        if (copyrightCheck.manual === true) {
            return 'Always checking this show, however clean its picks are.';
        }

        const remaining = Math.max(1, CLEAN_RUNS_TO_CLEAR - copyrightCheck.cleanSinceBlock);
        return `A copyright-blocked stream turned up here, so the top pick is probed first. ${remaining} more clean ${remaining === 1 ? 'pick' : 'picks'} and it goes back off.`;
    }, [copyrightCheck]);

    const autoPickSkipSummary = React.useMemo(() => {
        return autoPickInfo && autoPickInfo.blockedCount > 0 ?
            formatAutoPickSkipSummary(autoPickInfo.blockedCount)
            :
            null;
    }, [autoPickInfo]);

    return (
        <div className={classnames(className, styles['streams-list-container'])}>
            <div className={styles['select-choices-wrapper']}>
                {
                    video ?
                        <React.Fragment>
                            <Button className={classnames(styles['button-container'], styles['back-button-container'])} tabIndex={-1} onClick={backButtonOnClick}>
                                <Icon className={styles['icon']} name={'chevron-back'} />
                            </Button>
                            <div className={styles['episode-title']}>
                                {`S${video?.season}E${video?.episode} ${(video?.title)}`}
                            </div>
                        </React.Fragment>
                        :
                        null
                }
                {
                    Object.keys(streamsByAddon).length > 1 ?
                        <MultiselectMenu
                            {...selectableOptions}
                            className={styles['select-input-container']}
                        />
                        :
                        null
                }
            </div>
            {
                video ?
                    <div className={classnames(styles['autopick-panel'], { 'open': autoPickPanelOpen })}>
                        <div className={styles['autopick-panel-header']}>
                            <Button
                                className={styles['autopick-header-main']}
                                title={autoPickPanelOpen ? 'Hide auto-pick settings' : 'Show auto-pick settings'}
                                onClick={toggleAutoPickPanel}
                            >
                                <span className={classnames(styles['autopick-status-dot'], { 'on': effectiveAutoPickSettings.enabled })} />
                                <div className={styles['autopick-status-text']}>
                                    <div className={styles['autopick-status-title']}>
                                        {'Auto-pick '}{effectiveAutoPickSettings.enabled ? 'on' : 'off'}
                                        <span className={styles['autopick-status-mode']}>
                                            {isCustomMode ? ' \u00b7 Custom' : ' \u00b7 Global'}
                                        </span>
                                        {
                                            copyrightCheck.enabled ?
                                                <span className={styles['autopick-check-badge']} title={copyrightCheckHint}>
                                                    {'Checked'}
                                                </span>
                                                :
                                                null
                                        }
                                    </div>
                                    <div className={styles['autopick-status-subtitle']}>
                                        {autoPickSummary.sources}{' \u203A '}{autoPickSummary.qualities}
                                    </div>
                                </div>
                                <span className={styles['autopick-chevron']}>{'\u203A'}</span>
                            </Button>
                            <Toggle
                                className={styles['autopick-header-toggle']}
                                checked={effectiveAutoPickSettings.enabled}
                                title={effectiveAutoPickSettings.enabled ? 'Turn auto-pick off' : 'Turn auto-pick on'}
                                onClick={onAutoPickEnabledToggle}
                            />
                        </div>
                        {
                            autoPickPanelOpen ?
                                <div className={styles['autopick-panel-body']}>
                                    <div className={styles['autopick-check-row']}>
                                        <div className={styles['autopick-check-text']}>
                                            <div className={styles['autopick-check-title']}>
                                                {'Copyright check'}
                                                <span className={styles['autopick-check-mode']}>
                                                    {copyrightCheck.manual === null ? ' · Auto' : ' · Manual'}
                                                </span>
                                            </div>
                                            <div className={styles['autopick-check-subtitle']}>
                                                {copyrightCheckHint}
                                            </div>
                                        </div>
                                        <Toggle
                                            className={styles['autopick-check-toggle']}
                                            checked={copyrightCheck.enabled}
                                            title={copyrightCheck.enabled ? 'Skip the copyright check for this show' : 'Check this show for copyright-blocked streams'}
                                            onClick={onCopyrightCheckToggle}
                                        />
                                    </div>
                                    <div className={styles['autopick-mode']}>
                                        <Button
                                            className={classnames(styles['autopick-mode-button'], { 'active': !isCustomMode })}
                                            title={'Use the global auto-pick defaults'}
                                            onClick={() => onAutoPickModeChange(false)}
                                        >
                                            Global
                                        </Button>
                                        <Button
                                            className={classnames(styles['autopick-mode-button'], { 'active': isCustomMode })}
                                            title={'Set auto-pick just for this show'}
                                            onClick={() => onAutoPickModeChange(true)}
                                        >
                                            Custom
                                        </Button>
                                    </div>
                                    {
                                        isCustomMode ?
                                            <AutoPickEditor
                                                className={styles['autopick-editor']}
                                                value={effectiveAutoPickSettings}
                                                onChange={onOverrideChange}
                                                availability={availability}
                                                hiddenSourceKeys={hiddenSourceKeys}
                                                showMasterToggle={false}
                                            />
                                            :
                                            <div className={styles['autopick-summary']}>
                                                <div className={styles['autopick-summary-hint']}>
                                                    {'Using your global defaults. Switch to Custom to tune this show.'}
                                                </div>
                                            </div>
                                    }
                                </div>
                                :
                                null
                        }
                    </div>
                    :
                    null
            }
            {
                autoPickInfo && autoPickInfo.waiting ?
                    <div className={classnames(styles['autopick-banner'], styles['autopick-banner-waiting'])}>
                        <span className={styles['autopick-spinner']} />
                        <span className={styles['autopick-text']}>
                            <span className={styles['autopick-title']}>
                                {'Loading '}{autoPickInfo.sourceLabel}{' streams\u2026'}
                            </span>
                            <span className={styles['autopick-subtle']}>
                                {
                                    autoPickInfo.settling ?
                                        'Collecting streams from all addons\u2026'
                                        :
                                        'Auto-pick starts once all stream addons finish loading'
                                }
                            </span>
                        </span>
                    </div>
                    :
                    autoPickInfo && !autoPickInfo.failed && autoPickInfo.checking ?
                        <div className={styles['autopick-banner']}>
                            <span className={styles['autopick-spinner']} />
                            <span className={styles['autopick-text']}>
                                <span className={styles['autopick-title']}>
                                    {'Checking #'}{autoPickInfo.attempt}{' \u00b7 '}{autoPickInfo.qualityLabel}{' \u00b7 '}{autoPickInfo.sourceLabel}
                                </span>
                                {
                                    autoPickSkipSummary ?
                                        <span className={styles['autopick-subtle']}>{autoPickSkipSummary}</span>
                                        :
                                        null
                                }
                            </span>
                        </div>
                        :
                        autoPickInfo && !autoPickInfo.failed && !autoPickInfo.checking ?
                            <div className={styles['autopick-banner']}>
                                <span className={styles['autopick-check']}>{'\u2713'}</span>
                                <span className={styles['autopick-text']}>
                                    <span className={styles['autopick-title']}>
                                        {'Playing #'}{autoPickInfo.attempt}{' \u00b7 '}{autoPickInfo.qualityLabel}{' \u00b7 '}{autoPickInfo.sourceLabel}
                                    </span>
                                    {
                                        autoPickSkipSummary ?
                                            <span className={styles['autopick-subtle']}>{autoPickSkipSummary}</span>
                                            :
                                            null
                                    }
                                </span>
                            </div>
                            :
                            autoPickInfo && autoPickInfo.failed ?
                                <div className={classnames(styles['autopick-banner'], styles['autopick-banner-failed'])}>
                                    <span className={styles['autopick-warning']}>!</span>
                                    <span className={styles['autopick-text']}>
                                        <span className={styles['autopick-title']}>
                                            {'Auto-pick stopped \u2014 no playable stream found'}
                                        </span>
                                        <span className={styles['autopick-subtle']}>
                                            {
                                                autoPickInfo.blockedCount > 0 ?
                                                    `${autoPickInfo.blockedCount} copyright-blocked, none left to try \u2014 pick one below`
                                                    :
                                                    'Pick one below'
                                            }
                                        </span>
                                    </span>
                                </div>
                                :
                                retryToken && retryReason ?
                                    <div className={styles['autopick-banner']}>
                                        <span className={styles['autopick-spinner']} />
                                        <span className={styles['autopick-text']}>
                                            <span className={styles['autopick-title']}>
                                                {retryReason === 'copyright' ? 'Previous stream was copyright-blocked' : 'Previous stream unavailable'}
                                            </span>
                                            <span className={styles['autopick-subtle']}>
                                                {'Finding attempt #'}{failedCount + 1}{'\u2026'}
                                            </span>
                                        </span>
                                    </div>
                                    :
                                    effectiveAutoPickSettings.enabled &&
                                countLoadingAddons > 0 ?
                                        <div className={classnames(styles['autopick-banner'], styles['autopick-banner-waiting'])}>
                                            <span className={styles['autopick-spinner']} />
                                            <span className={styles['autopick-text']}>
                                                <span className={styles['autopick-title']}>
                                                    {'Loading '}{getSourceLabel(getTopEnabledSourceKey(effectiveAutoPickSettings))}{' streams\u2026'}
                                                </span>
                                                <span className={styles['autopick-subtle']}>
                                                    {'Auto-pick starts once all stream addons finish loading'}
                                                </span>
                                            </span>
                                        </div>
                                        :
                                        null
            }
            {
                props.streams.length === 0 ?
                    <div className={styles['message-container']}>
                        {
                            type === 'series' ?
                                <SeasonEpisodePicker className={styles['search']} onSubmit={handleEpisodePicker} />
                                : null
                        }
                        <Image className={styles['image']} src={require('/assets/images/empty.png')} alt={' '} />
                        <div className={styles['label']}>{t('ERR_NO_ADDONS_FOR_STREAMS')}</div>
                    </div>
                    :
                    props.streams.every((streams) => streams.content.type === 'Err') ?
                        <div className={styles['message-container']}>
                            {
                                type === 'series' ?
                                    <SeasonEpisodePicker className={styles['search']} onSubmit={handleEpisodePicker} />
                                    : null
                            }
                            {
                                video?.upcoming ?
                                    <div className={styles['label']}>{t('UPCOMING')}...</div>
                                    : null
                            }
                            <Image className={styles['image']} src={require('/assets/images/empty.png')} alt={' '} />
                            <div className={styles['label']}>{t('NO_STREAM')}</div>
                            {
                                showInstallAddonsButton ?
                                    <Button className={styles['install-button-container']} title={t('ADDON_CATALOGUE_MORE')} href={'#/addons'}>
                                        <Icon className={styles['icon']} name={'addons'} />
                                        <div className={styles['label']}>{t('ADDON_CATALOGUE_MORE')}</div>
                                    </Button>
                                    :
                                    null
                            }
                        </div>
                        :
                        filteredStreams.length === 0 ?
                            <div className={styles['streams-container']}>
                                <Stream.Placeholder />
                                <Stream.Placeholder />
                            </div>
                            :
                            <React.Fragment>
                                {
                                    countLoadingAddons > 0 ?
                                        <div className={styles['addons-loading-container']}>
                                            <div className={styles['addons-loading']}>
                                                {countLoadingAddons} {t('MOBILE_ADDONS_LOADING')}
                                            </div>
                                            <span className={styles['addons-loading-bar']}></span>
                                        </div>
                                        :
                                        null
                                }
                                <div className={styles['streams-container']} ref={streamsContainerRef}>
                                    {filteredStreams.map((stream, index) => (
                                        <Stream
                                            key={index}
                                            videoId={video?.id}
                                            videoReleased={video?.released}
                                            addonName={stream.addonName}
                                            name={stream.name}
                                            description={stream.description}
                                            thumbnail={stream.thumbnail}
                                            progress={stream.progress}
                                            deepLinks={stream.deepLinks}
                                            onClick={() => onManualStreamClick(stream)}
                                        />
                                    ))}
                                    {
                                        showInstallAddonsButton ?
                                            <Button className={styles['install-button-container']} title={t('ADDON_CATALOGUE_MORE')} href={'#/addons'}>
                                                <Icon className={styles['icon']} name={'addons'} />
                                                <div className={styles['label']}>{t('ADDON_CATALOGUE_MORE')}</div>
                                            </Button>
                                            :
                                            null
                                    }
                                </div>
                            </React.Fragment>
            }
        </div>
    );
};

StreamsList.propTypes = {
    className: PropTypes.string,
    streams: PropTypes.arrayOf(PropTypes.object).isRequired,
    video: PropTypes.object,
    type: PropTypes.string,
    metaId: PropTypes.string,
    onEpisodeSearch: PropTypes.func,
    queryParams: PropTypes.instanceOf(URLSearchParams),
};

module.exports = StreamsList;
