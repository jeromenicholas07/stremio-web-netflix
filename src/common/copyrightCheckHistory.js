// Copyright (C) 2017-2026 Smart code 203358507

// Per-show Real-Debrid copyright-check history.
//
// `streamPreflight` probes every auto-pick candidate's real size to catch the
// ~2 MB "File was removed from debrid service due to copyright infringement"
// stub Real-Debrid serves in place of a blocked file. That probe is reliable
// but it costs a round trip before playback can start (on the shell, a
// launcher fetch that may read up to ~4 MB of body).
//
// Most shows are never copyright-filtered: their top-ranked stream plays
// first time, every time, and the probe only ever confirms what we already
// knew. This module remembers - per show - whether the FIRST auto-pick
// candidate came back clean, and once a show has a run of clean first-picks
// it stops asking for the probe. Auto-pick then plays the top stream
// immediately.
//
// Trust is slow to earn and instant to lose:
//   - CLEAN_RUNS_TO_TRUST consecutive clean first-picks turn checking off
//   - ONE observed block turns it back on AND clears any manual override, so
//     a show that starts getting filtered self-corrects on the very next play
//   - trust ages out after TRUST_TTL_MS, because a title's RD status is not
//     permanent - an untouched show re-proves itself every so often
//
// With no history at all the answer is CHECK ON. Skipping the probe is an
// optimisation we only apply to evidence we actually collected.

const HISTORY_KEY = 'netflix_ui_rdcheck_history';

// Consecutive clean first-picks before we stop probing this show.
const CLEAN_RUNS_TO_TRUST = 3;
// A clean run older than this no longer counts toward the streak.
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Cap the per-show run log so storage cannot grow without bound.
const HISTORY_LIMIT = 10;

// --- Storage ---
// Mirrored to sessionStorage for the same reason auto-pick overrides are: the
// Stremio shell webview intermittently rejects localStorage writes while
// sessionStorage keeps working.
function safeGetStorage(storageName) {
    try {
        return typeof window === 'undefined' ? global[storageName] : window[storageName];
    } catch {
        return null;
    }
}

function getStorageItem(storageName, key) {
    try {
        return safeGetStorage(storageName)?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function setStorageItem(storageName, key, value) {
    try {
        safeGetStorage(storageName)?.setItem(key, value);
    } catch {
        // Storage unavailable (private browsing / tests) - history is optional.
    }
}

function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length === 0) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function getMetaKey(type, metaId) {
    return typeof type === 'string' && type.length > 0 && typeof metaId === 'string' && metaId.length > 0 ?
        `${type}:${metaId}`
        :
        null;
}

function getHistory() {
    const fromLocal = parseJson(getStorageItem('localStorage', HISTORY_KEY), null);
    if (fromLocal) return fromLocal;
    return parseJson(getStorageItem('sessionStorage', HISTORY_KEY), {});
}

function setHistory(history) {
    const payload = JSON.stringify(history);
    setStorageItem('localStorage', HISTORY_KEY, payload);
    setStorageItem('sessionStorage', HISTORY_KEY, payload);
}

// --- Record shape ---
// { runs: Array<{ clean: boolean, at: number }>, manual: boolean | null }
// `runs` is oldest-first; only the trailing clean entries matter.
function normalizeRecord(raw) {
    const runs = (Array.isArray(raw?.runs) ? raw.runs : [])
        .filter((run) => run && typeof run.clean === 'boolean' && Number.isFinite(run.at))
        .slice(-HISTORY_LIMIT);
    return {
        runs,
        manual: typeof raw?.manual === 'boolean' ? raw.manual : null,
    };
}

function readRecord(type, metaId) {
    const metaKey = getMetaKey(type, metaId);
    if (metaKey === null) return null;
    return normalizeRecord(getHistory()[metaKey]);
}

function writeRecord(type, metaId, record) {
    const metaKey = getMetaKey(type, metaId);
    if (metaKey === null) return false;
    const history = getHistory();
    history[metaKey] = {
        runs: record.runs.slice(-HISTORY_LIMIT),
        manual: record.manual,
    };
    setHistory(history);
    return true;
}

// --- Decision ---
// `enabled` is the answer auto-pick acts on: true -> probe before playing.
//   auto        - what the history alone says (the automatic behaviour)
//   manual      - the user's explicit toggle for this show, or null
//   cleanStreak - trailing run of clean, non-expired first-picks
function computeState(record, now) {
    if (record === null) {
        return { enabled: true, auto: true, manual: null, cleanStreak: 0, runs: 0, blocks: 0, known: false };
    }

    let cleanStreak = 0;
    for (let i = record.runs.length - 1; i >= 0; i -= 1) {
        const run = record.runs[i];
        // A block, or a clean result old enough to be stale, ends the streak.
        if (!run.clean || now - run.at > TRUST_TTL_MS) break;
        cleanStreak += 1;
    }

    const auto = cleanStreak < CLEAN_RUNS_TO_TRUST;
    return {
        enabled: record.manual === null ? auto : record.manual,
        auto,
        manual: record.manual,
        cleanStreak,
        runs: record.runs.length,
        blocks: record.runs.filter((run) => !run.clean).length,
        known: record.runs.length > 0 || record.manual !== null,
    };
}

function getCopyrightCheckState(type, metaId, now = Date.now()) {
    return computeState(readRecord(type, metaId), now);
}

function shouldCheckCopyright(type, metaId, now = Date.now()) {
    return getCopyrightCheckState(type, metaId, now).enabled;
}

// Record the verdict of a run's FIRST preflighted candidate. Call this only
// with a definite verdict - an inconclusive probe (`skipped`) is not evidence
// and must not feed the streak in either direction.
function recordCopyrightCheckRun(type, metaId, { clean } = {}, now = Date.now()) {
    const record = readRecord(type, metaId);
    if (record === null || typeof clean !== 'boolean') return getCopyrightCheckState(type, metaId, now);

    record.runs = record.runs.concat({ clean, at: now });
    // A block while the user had forced checking off means their override is
    // actively costing them a broken stream - drop it and let auto take over.
    if (!clean) record.manual = null;
    writeRecord(type, metaId, record);
    return getCopyrightCheckState(type, metaId, now);
}

// The safety net: a stream we let through (or probed as clean) turned out to
// be copyright-blocked at playback. Break the streak and clear any manual
// override so the next play probes again.
function recordCopyrightBlockObserved(type, metaId, now = Date.now()) {
    return recordCopyrightCheckRun(type, metaId, { clean: false }, now);
}

// null clears the override and returns the show to automatic behaviour.
function setCopyrightCheckManual(type, metaId, enabled, now = Date.now()) {
    const record = readRecord(type, metaId);
    if (record === null) return getCopyrightCheckState(type, metaId, now);

    record.manual = typeof enabled === 'boolean' ? enabled : null;
    writeRecord(type, metaId, record);
    return getCopyrightCheckState(type, metaId, now);
}

function clearCopyrightCheckHistory(type, metaId) {
    const metaKey = getMetaKey(type, metaId);
    if (metaKey === null) return;
    const history = getHistory();
    delete history[metaKey];
    setHistory(history);
}

module.exports = {
    CLEAN_RUNS_TO_TRUST,
    TRUST_TTL_MS,
    HISTORY_LIMIT,
    getCopyrightCheckState,
    shouldCheckCopyright,
    recordCopyrightCheckRun,
    recordCopyrightBlockObserved,
    setCopyrightCheckManual,
    clearCopyrightCheckHistory,
};
