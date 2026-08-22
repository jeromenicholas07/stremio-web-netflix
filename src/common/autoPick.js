// Copyright (C) 2017-2026 Smart code 203358507

// ─── Storage keys ───
// Legacy v1 keys (kept for migration only).
const LEGACY_KEYS = {
    enabled: 'netflix_ui_autopick',
    quality: 'netflix_ui_autopick_quality',
    fallback: 'netflix_ui_autopick_fallback',
    source: 'netflix_ui_autopick_source',
};

const CONFIG_KEY = 'netflix_ui_autopick_config';
const OVERRIDES_KEY = 'netflix_ui_autopick_overrides';
const SESSION_KEY = 'netflix_ui_autopick_session';

// Bump this to force a ONE-TIME reset of every existing install's GLOBAL
// auto-pick config to the current getDefaultAutoPickSettings(). The stamp is
// persisted next to the config; when it doesn't match we overwrite the config
// once and re-stamp, after which the user's later edits stick again. Per-show
// overrides are intentionally left untouched.
const DEFAULTS_VERSION_KEY = 'netflix_ui_autopick_defaults_version';
const CURRENT_DEFAULTS_VERSION = '2026-06-30-rd-torrentio';

// ─── Canonical option catalogs ───
// Quality buckets in default (highest-first) priority order. `other` is a
// catch-all for anything we cannot confidently classify.
const QUALITIES = [
    { key: '4k_hdr', label: '4K HDR' },
    { key: '4k', label: '4K' },
    { key: '1080p', label: '1080p' },
    { key: '720p', label: '720p' },
    { key: '480p', label: '480p' },
    { key: 'other', label: 'Other / SD' },
];

// Source buckets. Each describes a way a stream is delivered. A single stream
// can match several buckets (e.g. an [RD+] stream served by Torrentio matches
// both `rd_plus` and `torrentio`); ranking uses the highest-priority enabled
// bucket the stream belongs to. `other` is the universal fallback bucket.
const SOURCES = [
    { key: 'rd_plus', label: 'RealDebrid (cached)', test: (stream) => /\[rd\+\]/i.test(stream?.name || '') },
    { key: 'rd_download', label: 'RealDebrid (download)', test: (stream) => /\[rd(?:\s|-)?(?:download|dl)\]/i.test(stream?.name || '') },
    { key: 'debridlink', label: 'Debrid-Link', test: (stream) => /\[dl\+?\]|debrid-link/i.test(stream?.name || '') },
    { key: 'alldebrid', label: 'AllDebrid', test: (stream) => /\[ad\+?\]|alldebrid/i.test(stream?.name || '') },
    { key: 'premiumize', label: 'Premiumize', test: (stream) => /\[pm\+?\]|premiumize/i.test(stream?.name || '') },
    // Keyed by add-on name, but shown neutrally: this bucket is "P2P streams
    // from the main source add-on", as distinct from the catch-all below.
    // The key is persisted in user settings and must not be renamed.
    { key: 'torrentio', label: 'Main add-on (P2P)', test: (stream) => /torrentio/i.test(stream?.addonName || '') },
    { key: 'other', label: 'Other / P2P', test: () => true },
];

const QUALITY_KEYS = QUALITIES.map(({ key }) => key);
const SOURCE_KEYS = SOURCES.map(({ key }) => key);
const SOURCE_BY_KEY = SOURCES.reduce((acc, source) => {
    acc[source.key] = source;
    return acc;
}, {});

function getQualityLabel(key) {
    return QUALITIES.find((quality) => quality.key === key)?.label || key;
}

function getSourceLabel(key) {
    return SOURCES.find((source) => source.key === key)?.label || key;
}

// ─── Storage helpers ───
function safeGetStorage(storageName) {
    try {
        return typeof window === 'undefined' ? global[storageName] : window[storageName];
    } catch {
        return null;
    }
}

function getStorageItem(storageName, key) {
    const storage = safeGetStorage(storageName);
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function setStorageItem(storageName, key, value) {
    const storage = safeGetStorage(storageName);
    try {
        storage?.setItem(key, value);
    } catch {
        // Storage can be unavailable in private browsing or tests.
    }
}

function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length === 0) {
        return fallback;
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

// ─── Settings shape & normalization ───
// Settings v2:
// {
//   enabled: boolean,
//   sources: Array<{ key, enabled }>,    // ordered by priority (top = first tried)
//   qualities: Array<{ key, enabled }>,  // ordered by priority (top = preferred)
// }
// Out-of-the-box defaults. Auto-pick is on, English-only, and tuned for the
// common Real-Debrid + Torrentio setup: cached RD first, then RD download, then
// Torrentio P2P, with the other debrid services off (users enable the ones they
// pay for). Quality prefers plain 4K/1080p over HDR (HDR tone-mapping is often
// worse on non-HDR displays) before stepping down. The explicit order/enabled
// here is the source of truth for new users; normalizeList fills any gaps.
function getDefaultAutoPickSettings() {
    return {
        enabled: true,
        // Skip releases tagged for a non-English language (e.g. ITA, 🇮🇹).
        englishOnly: true,
        sources: [
            { key: 'rd_plus', enabled: true },
            { key: 'rd_download', enabled: true },
            { key: 'debridlink', enabled: false },
            { key: 'alldebrid', enabled: false },
            { key: 'premiumize', enabled: false },
            { key: 'torrentio', enabled: true },
            { key: 'other', enabled: false },
        ],
        qualities: [
            { key: '4k', enabled: true },
            { key: '1080p', enabled: true },
            { key: '4k_hdr', enabled: true },
            { key: '720p', enabled: true },
            { key: '480p', enabled: true },
            { key: 'other', enabled: true },
        ],
    };
}

function normalizeList(list, canonicalKeys) {
    const seen = new Set();
    const result = [];

    (Array.isArray(list) ? list : []).forEach((item) => {
        const key = item && item.key;
        if (canonicalKeys.includes(key) && !seen.has(key)) {
            seen.add(key);
            result.push({ key, enabled: item.enabled !== false });
        }
    });

    canonicalKeys.forEach((key) => {
        if (!seen.has(key)) {
            result.push({ key, enabled: true });
        }
    });

    return result;
}

function migrateLegacySettings(legacy) {
    const settings = getDefaultAutoPickSettings();
    settings.enabled = legacy.enabled === true || legacy.enabled === 'true';

    // Sources: v1 strictly filtered by a single preferred source, so we mirror
    // that by enabling only the migrated source group; the rest stay available
    // but disabled for the user to opt into.
    const legacySourceMap = {
        realdebrid: ['rd_plus', 'rd_download'],
        debridlink: ['debridlink'],
        alldebrid: ['alldebrid'],
        premiumize: ['premiumize'],
        torrentio: ['torrentio'],
    };

    if (!legacy.source || legacy.source === 'any') {
        settings.sources = SOURCES.map(({ key }) => ({ key, enabled: true }));
    } else {
        const preferred = legacySourceMap[legacy.source] || [];
        const ordered = [...preferred, ...SOURCE_KEYS.filter((key) => !preferred.includes(key))];
        settings.sources = ordered.map((key) => ({ key, enabled: preferred.includes(key) }));
    }

    // Quality was a preference (not a filter) in v1, so keep every bucket
    // enabled and just order preferred + fallback first.
    const preferredQualities = [];
    [legacy.quality, legacy.fallback].forEach((quality) => {
        if (quality && quality !== 'any' && QUALITY_KEYS.includes(quality) && !preferredQualities.includes(quality)) {
            preferredQualities.push(quality);
        }
    });
    const orderedQualities = [...preferredQualities, ...QUALITY_KEYS.filter((key) => !preferredQualities.includes(key))];
    settings.qualities = orderedQualities.map((key) => ({ key, enabled: true }));

    return settings;
}

function normalizeSettings(input) {
    if (!input || typeof input !== 'object') {
        return getDefaultAutoPickSettings();
    }

    if (Array.isArray(input.sources) || Array.isArray(input.qualities)) {
        return {
            enabled: input.enabled === true,
            englishOnly: input.englishOnly !== false,
            sources: normalizeList(input.sources, SOURCE_KEYS),
            qualities: normalizeList(input.qualities, QUALITY_KEYS),
        };
    }

    return migrateLegacySettings(input);
}

// ─── Global settings ───
// One-time reset of the stored global config to the current defaults. No-op
// once the persisted stamp matches CURRENT_DEFAULTS_VERSION, so it runs at most
// once per defaults bump and user edits made afterwards survive.
function ensureGlobalDefaultsMigration() {
    try {
        if (getStorageItem('localStorage', DEFAULTS_VERSION_KEY) === CURRENT_DEFAULTS_VERSION) {
            return;
        }
        const defaults = getDefaultAutoPickSettings();
        setStorageItem('localStorage', CONFIG_KEY, JSON.stringify(defaults));
        setStorageItem('localStorage', LEGACY_KEYS.enabled, String(defaults.enabled));
        setStorageItem('localStorage', DEFAULTS_VERSION_KEY, CURRENT_DEFAULTS_VERSION);
    } catch {
        // Storage unavailable (private mode / tests) — nothing to migrate.
    }
}

function getGlobalAutoPickSettings() {
    ensureGlobalDefaultsMigration();

    const stored = getStorageItem('localStorage', CONFIG_KEY);
    if (stored) {
        return normalizeSettings(parseJson(stored, null));
    }

    // Only migrate from the v1 keys if the user actually has them. A truly
    // fresh install has no legacy keys and should get the tuned defaults
    // (auto-pick on, RD + Torrentio) rather than the v1 migration's off state.
    const hasLegacy = Object.values(LEGACY_KEYS)
        .some((key) => getStorageItem('localStorage', key) !== null);
    if (!hasLegacy) {
        return getDefaultAutoPickSettings();
    }

    return normalizeSettings({
        enabled: getStorageItem('localStorage', LEGACY_KEYS.enabled) === 'true',
        quality: getStorageItem('localStorage', LEGACY_KEYS.quality) || '4k',
        fallback: getStorageItem('localStorage', LEGACY_KEYS.fallback) || '1080p',
        source: getStorageItem('localStorage', LEGACY_KEYS.source) || 'realdebrid',
    });
}

function setGlobalAutoPickSettings(partial) {
    const next = normalizeSettings({
        ...getGlobalAutoPickSettings(),
        ...partial,
    });

    setStorageItem('localStorage', CONFIG_KEY, JSON.stringify(next));
    // Mirror the enabled flag to the legacy key for any external readers.
    setStorageItem('localStorage', LEGACY_KEYS.enabled, String(next.enabled));

    return next;
}

// ─── Per-show overrides ───
function getMetaKey(type, metaId) {
    return typeof type === 'string' && type.length > 0 && typeof metaId === 'string' && metaId.length > 0 ?
        `${type}:${metaId}`
        :
        null;
}

function getAutoPickOverrides() {
    const fromLocal = parseJson(getStorageItem('localStorage', OVERRIDES_KEY), null);
    if (fromLocal && typeof fromLocal === 'object') return fromLocal;
    return parseJson(getStorageItem('sessionStorage', OVERRIDES_KEY), {});
}

function setAutoPickOverrides(overrides) {
    const payload = JSON.stringify(overrides);
    setStorageItem('localStorage', OVERRIDES_KEY, payload);
    // Mirror to sessionStorage — the Stremio shell webview sometimes rejects
    // localStorage writes while sessionStorage still works.
    setStorageItem('sessionStorage', OVERRIDES_KEY, payload);
}

function getAutoPickOverride(type, metaId) {
    const metaKey = getMetaKey(type, metaId);
    if (metaKey === null) return null;

    const override = getAutoPickOverrides()[metaKey];
    return override && typeof override === 'object' ? normalizeSettings(override) : null;
}

function setAutoPickOverride(type, metaId, override) {
    const metaKey = getMetaKey(type, metaId);
    if (metaKey === null) return null;

    const overrides = getAutoPickOverrides();
    if (override === null) {
        delete overrides[metaKey];
    } else {
        overrides[metaKey] = normalizeSettings(override);
    }

    setAutoPickOverrides(overrides);
    return getAutoPickOverride(type, metaId);
}

function getEffectiveAutoPickSettings(type, metaId) {
    const override = getAutoPickOverride(type, metaId);
    return override || getGlobalAutoPickSettings();
}

function getPlayableAutoPickSettings(type, metaId) {
    const settings = getEffectiveAutoPickSettings(type, metaId);
    return settings.enabled ? settings : null;
}

// ─── Stream classification ───
function isHDR(stream) {
    const combined = `${stream?.name || ''} ${stream?.description || ''}`;
    return /hdr|dolby\s*vision|dv(?:\b|[^a-z])/i.test(combined);
}

function detectQuality(stream) {
    const name = (stream?.name || '').toLowerCase();
    const desc = (stream?.description || '').toLowerCase();
    if (name.includes('4k') || name.includes('2160p') || desc.includes('2160p')) {
        return isHDR(stream) ? '4k_hdr' : '4k';
    }
    if (name.includes('1080p') || desc.includes('1080p')) return '1080p';
    if (name.includes('720p') || desc.includes('720p')) return '720p';
    if (name.includes('480p') || desc.includes('480p')) return '480p';
    return 'other';
}

// ─── Web-playable (iOS inline) detection ───
// iOS Safari can only decode a subset of what debrid serves inline — broadly
// H.264 video + AAC audio in an MP4 container. MKV containers, HEVC/HDR video,
// and AC3/EAC3/DTS/TrueHD audio can't play in the browser and must hand off to
// an external app (Infuse/VLC). This is a best-effort classifier over the
// release name/description/filename; codecs aren't always tagged, so it returns
// "unknown" rather than guessing. Used only to *prefer* inline-capable streams
// on iOS — it never excludes a stream.
const NOT_WEB_PLAYABLE_RE = /(x265|h\.?265|hevc|\bmkv\b|\bdts\b|truehd|e-?ac-?3|\beac3\b|\bac-?3\b|dolby\s*vision|\bdovi\b|hdr10|\bhdr\b)/i;
const WEB_PLAYABLE_RE = /(x264|h\.?264|\bavc\b|\bmp4\b|\baac\b)/i;

function streamText(stream) {
    const filename = stream && stream.behaviorHints && stream.behaviorHints.filename;
    return `${stream?.name || ''} ${stream?.description || ''} ${filename || ''}`;
}

// Rank of how likely a stream plays inline in iOS Safari (lower = better):
//   0 → looks web-playable (H.264/AAC/MP4)
//   1 → unknown (no codec/container markers)
//   2 → definitely not web-playable (MKV/HEVC/HDR/AC3/…)
function webPlayableRank(stream) {
    const text = streamText(stream);
    if (NOT_WEB_PLAYABLE_RE.test(text) || isHDR(stream)) return 2;
    if (WEB_PLAYABLE_RE.test(text)) return 0;
    return 1;
}

// ─── Language detection ───
// Regional-indicator flag emoji come in pairs (e.g. 🇮🇹 = U+1F1EE U+1F1F9).
// Flags from English-speaking countries are allowed; any other flag marks a
// foreign-language release.
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const ENGLISH_FLAGS = new Set([
    '\u{1F1EC}\u{1F1E7}', // GB
    '\u{1F1FA}\u{1F1F8}', // US
    '\u{1F1E6}\u{1F1FA}', // AU
    '\u{1F1E8}\u{1F1E6}', // CA
    '\u{1F1F3}\u{1F1FF}', // NZ
    '\u{1F1EE}\u{1F1EA}', // IE
]);
// Whole-word language tags that signal a non-English release.
const FOREIGN_TOKEN_RE = /\b(ita|italian|italiano|french|francais|truefrench|vostfr|vff|spanish|espanol|castellano|latino|german|deutsch|russian|hindi|tamil|telugu|korean|japanese|dublado|dublat|lektor|napisy|nordic|swedish|danish|finnish|norwegian|polish|portugues|portuguese|turkish|greek|arabic|hebrew|thai|vietnamese|mandarin|cantonese)\b/i;
// Explicit English markers. Their presence whitelists the stream even when a
// foreign tag is also present (covers MULTi / dual-audio releases).
const ENGLISH_TOKEN_RE = /\b(eng|english)\b/i;

// True when a stream is tagged for a language other than English. Conservative
// by design: anything without a foreign marker (the common case for English
// scene releases) passes through.
function detectIsForeign(stream) {
    const text = `${stream?.name || ''} ${stream?.description || ''}`;
    const flags = text.match(FLAG_RE) || [];

    if (flags.some((flag) => ENGLISH_FLAGS.has(flag))) return false;
    if (ENGLISH_TOKEN_RE.test(text)) return false;

    if (flags.some((flag) => !ENGLISH_FLAGS.has(flag))) return true;
    return FOREIGN_TOKEN_RE.test(text);
}

function streamSourceKeys(stream) {
    const keys = SOURCES
        .filter((source) => source.key !== 'other' && source.test(stream))
        .map((source) => source.key);
    return keys.length > 0 ? keys : ['other'];
}

function getSeeders(stream) {
    const seedMatch = (stream?.description || '').match(/\uD83D\uDC64\s*(\d+)/);
    return seedMatch ? Math.min(parseInt(seedMatch[1], 10), 999) : 0;
}

function getEffectiveSourceKey(stream, settings) {
    const enabledSources = settings.sources.filter((source) => source.enabled);
    const sKeys = streamSourceKeys(stream);
    const match = enabledSources.find((entry) => entry.key === 'other' || sKeys.includes(entry.key));
    return match ? match.key : (sKeys[0] || 'other');
}

function getTopEnabledSourceKey(settings) {
    const top = settings && settings.sources && settings.sources.find((source) => source.enabled);
    return top ? top.key : null;
}

function hasStreamsForSource(streams, settings, sourceKey) {
    if (!sourceKey || !Array.isArray(streams)) return false;
    return streams.some((stream) => {
        if (!stream?.name || isPurchasable(stream)) return false;
        if (settings.englishOnly && detectIsForeign(stream)) return false;
        return getEffectiveSourceKey(stream, settings) === sourceKey;
    });
}

// Hold auto-pick until every stream addon has finished loading so the full
// candidate list (e.g. all RD download variants) is available before we pick.
function isWaitingForStreamsToLoad(loadingAddonCount) {
    return loadingAddonCount > 0;
}

function formatAutoPickSkipSummary(blockedCount) {
    if (!blockedCount || blockedCount <= 0) return null;
    const noun = blockedCount === 1 ? 'stream' : 'streams';
    return `Skipped ${blockedCount} copyright-blocked ${noun} first`;
}

function describeStream(stream, settings) {
    const qualityKey = detectQuality(stream);
    const sourceKey = settings ? getEffectiveSourceKey(stream, settings) : streamSourceKeys(stream)[0];
    return {
        qualityKey,
        qualityLabel: getQualityLabel(qualityKey),
        sourceKey,
        sourceLabel: getSourceLabel(sourceKey),
    };
}

// Detect pay-to-access streams (rent/buy/subscription). Word boundaries are
// required so the tracker/scene token "Torrent" (which contains "rent") does
// not get mis-flagged as purchasable — that previously excluded every
// TorrentGalaxy-tracked release from auto-pick.
function isPurchasable(stream) {
    return /\b(?:subscription|rent|buy)\b/i.test(stream?.description || '');
}

// Returns the priority rank of a stream under the given settings, or null when
// the stream is excluded (purchasable or not part of any enabled bucket).
// `options.preferWebPlayable` (set on iOS) layers an inline-playability sort key
// on top of the normal ranking without excluding anything.
function rankStream(stream, settings, options = {}) {
    if (!stream?.name || isPurchasable(stream)) return null;
    if (settings.englishOnly && detectIsForeign(stream)) return null;

    const enabledSources = settings.sources.filter((source) => source.enabled);
    const enabledQualities = settings.qualities.filter((quality) => quality.enabled);

    const sKeys = streamSourceKeys(stream);
    const sourceIndex = enabledSources.findIndex((entry) => entry.key === 'other' || sKeys.includes(entry.key));
    if (sourceIndex === -1) return null;

    const qualityKey = detectQuality(stream);
    const qualityIndex = enabledQualities.findIndex((entry) => entry.key === qualityKey);
    if (qualityIndex === -1) return null;

    // Diagonal ranking: balance source priority against quality priority instead
    // of letting source dominate completely. A stream's primary "tier" is the
    // sum of its source and quality indices, so a clearly higher quality from a
    // slightly lower-priority source can outrank a low-quality stream from the
    // top source. This is what stops an SD/`other` cached stream (e.g. RD+ with
    // no resolution tag) from beating an available 1080p download.
    //
    // Tie-breaks within a tier, in order: better quality (lower qualityIndex),
    // then better source (lower sourceIndex), then more seeders. The weights are
    // spaced so each tier dominates the next and seeders (capped at 999) can
    // never flip a quality step.
    const tier = sourceIndex + qualityIndex;
    const baseRank = (tier * 1000000) + (qualityIndex * 1000) + (sourceIndex * 10) - getSeeders(stream);

    // iOS: prefer streams that can play inline in Safari. This is a DOMINANT sort
    // key layered above the normal source/quality ranking (which is < 1e12), so
    // web-playable > unknown > not-web-playable, but ties within a playability
    // class still respect the user's configured priorities. HEVC/HDR 4K releases
    // (which can't play inline) sink below H.264/1080p ones — that's how "prefer
    // 1080p over 2160p on iOS" falls out. A non-web-playable stream is never
    // excluded; it just ranks last and, if picked, uses the external player.
    if (options.preferWebPlayable) {
        return (webPlayableRank(stream) * 1e12) + baseRank;
    }
    return baseRank;
}

function getStreamKey(stream) {
    return [
        stream?.deepLinks?.player || '',
        stream?.addonName || '',
        stream?.name || '',
        stream?.description || '',
    ].join('|');
}

function getStreamAttemptNumber(allStreams, stream) {
    if (!stream || !Array.isArray(allStreams)) return 1;
    const idx = allStreams.findIndex((candidate) => getStreamKey(candidate) === getStreamKey(stream));
    return idx === -1 ? 1 : idx + 1;
}

function getAutoPickCandidates(allStreams, settings, options = {}) {
    if (!settings || !Array.isArray(allStreams) || allStreams.length === 0) {
        return [];
    }

    const failedStreamKeys = new Set(options.failedStreamKeys || []);

    return allStreams
        .map((stream, index) => ({ stream, index, rank: rankStream(stream, settings, options) }))
        .filter(({ stream, rank }) => rank !== null && !failedStreamKeys.has(getStreamKey(stream)))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(({ stream }) => stream);
}

function pickBestStream(allStreams, settings, options = {}) {
    const candidates = getAutoPickCandidates(allStreams, settings, options);
    return candidates.length > 0 ? candidates[0] : null;
}

// ─── Availability detection (per-show) ───
function detectAvailability(allStreams, settings) {
    const sources = {};
    const qualities = {};
    const englishOnly = Boolean(settings && settings.englishOnly);

    (Array.isArray(allStreams) ? allStreams : []).forEach((stream) => {
        if (!stream?.name || isPurchasable(stream)) return;
        if (englishOnly && detectIsForeign(stream)) return;

        streamSourceKeys(stream).forEach((key) => {
            sources[key] = (sources[key] || 0) + 1;
        });

        const qualityKey = detectQuality(stream);
        qualities[qualityKey] = (qualities[qualityKey] || 0) + 1;
    });

    return { sources, qualities };
}

// ─── Session state (auto-picked selection + failures) ───
function getAutoPickSession() {
    return parseJson(getStorageItem('sessionStorage', SESSION_KEY), {
        selections: {},
        failures: {},
        lastEntry: null,
    });
}

function setAutoPickSession(session) {
    setStorageItem('sessionStorage', SESSION_KEY, JSON.stringify({
        selections: session?.selections || {},
        failures: session?.failures || {},
        lastEntry: session?.lastEntry || null,
    }));
}

function getPlaybackKey(type, metaId, videoId) {
    return [type, metaId, videoId]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(':');
}

function storeAutoPickSelection(context) {
    const playbackKey = getPlaybackKey(context?.type, context?.metaId, context?.videoId);
    if (!playbackKey) return null;

    const stream = context.stream;
    const described = describeStream(stream, context.settings);
    const session = getAutoPickSession();
    const selection = {
        type: context.type,
        metaId: context.metaId,
        videoId: context.videoId,
        streamKey: getStreamKey(stream),
        quality: described.qualityKey,
        qualityLabel: described.qualityLabel,
        source: described.sourceKey,
        sourceLabel: described.sourceLabel,
        createdAt: Date.now(),
    };

    session.selections[playbackKey] = selection;
    session.lastEntry = selection;
    setAutoPickSession(session);

    return selection;
}

function getAutoPickSelection(type, metaId, videoId) {
    const playbackKey = getPlaybackKey(type, metaId, videoId);
    if (!playbackKey) return null;

    const session = getAutoPickSession();
    return session.selections[playbackKey] || null;
}

function clearAutoPickSelection(type, metaId, videoId) {
    const playbackKey = getPlaybackKey(type, metaId, videoId);
    if (!playbackKey) return;

    const session = getAutoPickSession();
    delete session.selections[playbackKey];
    setAutoPickSession(session);
}

function recordAutoPickFailure(context, reason) {
    const playbackKey = getPlaybackKey(context?.type, context?.metaId, context?.videoId);
    if (!playbackKey || !context?.streamKey) return null;

    const session = getAutoPickSession();
    const failures = Array.isArray(session.failures[playbackKey]) ? session.failures[playbackKey] : [];
    const nextFailure = {
        streamKey: context.streamKey,
        quality: context.quality || null,
        reason: reason || 'unavailable',
        failedAt: Date.now(),
    };

    session.failures[playbackKey] = failures
        .filter((failure) => failure.streamKey !== nextFailure.streamKey)
        .concat(nextFailure);
    setAutoPickSession(session);

    return nextFailure;
}

function getAutoPickFailures(type, metaId, videoId) {
    const playbackKey = getPlaybackKey(type, metaId, videoId);
    if (!playbackKey) return [];

    const session = getAutoPickSession();
    return Array.isArray(session.failures[playbackKey]) ? session.failures[playbackKey] : [];
}

function clearAutoPickFailures(type, metaId, videoId) {
    const playbackKey = getPlaybackKey(type, metaId, videoId);
    if (!playbackKey) return;

    const session = getAutoPickSession();
    delete session.failures[playbackKey];
    setAutoPickSession(session);
}

function clearAutoPickFailure(type, metaId, videoId, streamKey) {
    const playbackKey = getPlaybackKey(type, metaId, videoId);
    if (!playbackKey || !streamKey) return;

    const session = getAutoPickSession();
    const failures = Array.isArray(session.failures[playbackKey]) ? session.failures[playbackKey] : [];
    const next = failures.filter((failure) => failure.streamKey !== streamKey);
    if (next.length === failures.length) return;

    if (next.length === 0) {
        delete session.failures[playbackKey];
    } else {
        session.failures[playbackKey] = next;
    }
    setAutoPickSession(session);
}

function isRecoverableAutoPickError(error) {
    const message = `${error?.message || ''} ${error?.details || ''} ${error?.error || ''}`;
    return /unavailable|not\s+available|not\s+found|404|removed\s+from\s+debrid\s+service\s+due\s+to\s+copyright|copyright/i.test(message);
}

function buildMetaDetailsStreamsHash(type, metaId, videoId, query = {}) {
    const params = new URLSearchParams();
    Object.keys(query).forEach((key) => {
        if (query[key] !== null && query[key] !== undefined) {
            params.set(key, query[key]);
        }
    });

    const search = params.toString();
    return `#/metadetails/${encodeURIComponent(type)}/${encodeURIComponent(metaId)}/${encodeURIComponent(videoId)}${search ? `?${search}` : ''}`;
}

module.exports = {
    QUALITIES,
    SOURCES,
    SOURCE_BY_KEY,
    getDefaultAutoPickSettings,
    getQualityLabel,
    getSourceLabel,
    normalizeSettings,
    getGlobalAutoPickSettings,
    setGlobalAutoPickSettings,
    getAutoPickOverride,
    setAutoPickOverride,
    getEffectiveAutoPickSettings,
    getPlayableAutoPickSettings,
    detectQuality,
    detectIsForeign,
    webPlayableRank,
    describeStream,
    getTopEnabledSourceKey,
    hasStreamsForSource,
    isWaitingForStreamsToLoad,
    formatAutoPickSkipSummary,
    streamSourceKeys,
    rankStream,
    getAutoPickCandidates,
    pickBestStream,
    detectAvailability,
    getStreamKey,
    getStreamAttemptNumber,
    storeAutoPickSelection,
    getAutoPickSelection,
    clearAutoPickSelection,
    recordAutoPickFailure,
    getAutoPickFailures,
    clearAutoPickFailures,
    clearAutoPickFailure,
    isRecoverableAutoPickError,
    buildMetaDetailsStreamsHash,
};
