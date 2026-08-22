// Copyright (C) 2017-2026 Smart code 203358507

// Per-show Real-Debrid copyright-check history.
//
// `streamPreflight` can probe an auto-pick candidate's real size to catch the
// ~2 MB "File was removed from debrid service due to copyright infringement"
// stub Real-Debrid serves in place of a blocked file. The probe is reliable but
// it costs a round trip before playback can start, and the overwhelming
// majority of shows are never filtered — so paying it everywhere buys nothing.
//
// The check is therefore OFF by default, everywhere. Auto-pick plays the top
// stream immediately and we find out the hard way: when a blocked file
// actually turns up, the player fails with a copyright error, that failure is
// recorded against the show, and every later play of that show is probed
// first. One bad playback buys permanent protection for that title.
//
// Turning it back off again:
//   - CLEAN_RUNS_TO_CLEAR clean probes after the last block, or
//   - BLOCK_MEMORY_MS elapsing since that block
// so a one-off blip stops costing a probe quickly, and a title whose RD status
// has since been fixed is not probed forever.
//
// A manual toggle overrides all of it, except that a fresh block always clears
// the override — you cannot pin a show "off" and then silently keep getting
// broken streams from it.

const HISTORY_KEY = 'netflix_ui_rdcheck_history';

// Clean probes recorded after a block before we trust the show again.
const CLEAN_RUNS_TO_CLEAR = 3;
// How long a single observed block keeps the check switched on for a show.
const BLOCK_MEMORY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
// `runs` is oldest-first; only what happened at and after the last block matters.
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
//   auto            - what the history alone says (the automatic behaviour)
//   manual          - the user's explicit toggle for this show, or null
//   cleanSinceBlock - clean probes recorded after the most recent block
//   lastBlockAt     - when this show last served a copyright-blocked file
//
// Off unless this show has actually misbehaved: a block inside the memory
// window that has not yet been cleared by a run of clean probes.
function computeState(record, now) {
    if (record === null) {
        return {
            enabled: false, auto: false, manual: null,
            cleanSinceBlock: 0, runs: 0, blocks: 0, lastBlockAt: null, known: false,
        };
    }

    let lastBlockIndex = -1;
    for (let i = record.runs.length - 1; i >= 0; i -= 1) {
        if (!record.runs[i].clean) {
            lastBlockIndex = i;
            break;
        }
    }

    const lastBlock = lastBlockIndex >= 0 ? record.runs[lastBlockIndex] : null;
    // Everything recorded after the last block is by definition clean.
    const cleanSinceBlock = lastBlockIndex >= 0 ?
        record.runs.length - 1 - lastBlockIndex
        :
        record.runs.length;

    const blockRemembered = lastBlock !== null && now - lastBlock.at <= BLOCK_MEMORY_MS;
    const auto = blockRemembered && cleanSinceBlock < CLEAN_RUNS_TO_CLEAR;

    return {
        enabled: record.manual === null ? auto : record.manual,
        auto,
        manual: record.manual,
        cleanSinceBlock,
        runs: record.runs.length,
        blocks: record.runs.filter((run) => !run.clean).length,
        lastBlockAt: lastBlock ? lastBlock.at : null,
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
// and must not feed the history in either direction.
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

// The show served a copyright-blocked file. With the check off by default this
// is the primary way a bad title is ever discovered: playback fails, we record
// it here, and every later play of this show is probed first.
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
    CLEAN_RUNS_TO_CLEAR,
    BLOCK_MEMORY_MS,
    HISTORY_LIMIT,
    getCopyrightCheckState,
    shouldCheckCopyright,
    recordCopyrightCheckRun,
    recordCopyrightBlockObserved,
    setCopyrightCheckManual,
    clearCopyrightCheckHistory,
};
