const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything is bundled and runs on loopback, so URLs and ports are deterministic.
// The Prowlarr API key is auto-discovered from Prowlarr's own config.xml on disk —
// no user-facing configuration required.

const STATIC = {
    prowlarrUrl: 'http://127.0.0.1:9696',
    addonPort: 7000,
    // 6000 = XXX parent + standard XXX subcategories
    adultCategories: [6000, 6010, 6020, 6030, 6040, 6050, 6060, 6070],
    pageSize: 100,
    dedupThreshold: 0.8,
    cacheTtl: 3 * 60 * 60 * 1000,
};

// Cached API key. Resolution is lazy so that the addon can boot before Prowlarr
// has finished writing its config.xml on first run.
let _apiKey = null;

function resolveProwlarrConfigPath() {
    // Explicit override (used by StremioLauncherFULL to point at the bundled data dir)
    if (process.env.PROWLARR_CONFIG) return process.env.PROWLARR_CONFIG;

    if (process.env.PROWLARR_DATA_DIR) {
        return path.join(process.env.PROWLARR_DATA_DIR, 'config.xml');
    }

    // Common Prowlarr install locations (Windows + Linux), checked in order
    const candidates = [];
    if (process.platform === 'win32' && process.env.ProgramData) {
        candidates.push(path.join(process.env.ProgramData, 'Prowlarr', 'config.xml'));
    }
    if (process.env.HOME) {
        candidates.push(path.join(process.env.HOME, '.config', 'Prowlarr', 'config.xml'));
    }
    return candidates.find((p) => {
        try { return fs.existsSync(p); } catch { return false; }
    }) || null;
}

function readApiKeyFromDisk() {
    const configPath = resolveProwlarrConfigPath();
    if (!configPath) return '';
    try {
        if (!fs.existsSync(configPath)) return '';
        const xml = fs.readFileSync(configPath, 'utf8');
        const match = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/);
        return match ? match[1].trim() : '';
    } catch (err) {
        console.error('[config] Failed to read Prowlarr API key:', err.message);
        return '';
    }
}

function getProwlarrApiKey({ forceReload = false } = {}) {
    // Env var always wins (useful for dev / non-bundled deployments)
    if (process.env.PROWLARR_API_KEY) return process.env.PROWLARR_API_KEY;

    // Cache once we've successfully read it from disk (unless forced)
    if (!forceReload && _apiKey) return _apiKey;

    const fromDisk = readApiKeyFromDisk();
    if (fromDisk) {
        if (fromDisk !== _apiKey) {
            console.log('[config] Discovered Prowlarr API key from config.xml');
        }
        _apiKey = fromDisk;
    }
    return _apiKey || '';
}

function invalidateApiKeyCache() {
    _apiKey = null;
}

// Persistent data dir for the addon's own caches (infoHashes, etc.). We
// co-locate with Prowlarr's data dir when the launcher tells us where that
// is — the launcher already guarantees `shared/` survives upgrades. Falls
// back to a platform-appropriate cache dir, then finally cwd.
function resolveCacheDir() {
    if (process.env.INCOGNITO_CACHE_DIR) return process.env.INCOGNITO_CACHE_DIR;

    if (process.env.PROWLARR_DATA_DIR) {
        return path.join(path.dirname(process.env.PROWLARR_DATA_DIR), 'incognito-addon-cache');
    }

    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        return path.join(process.env.LOCALAPPDATA, 'IncognitoAddon', 'cache');
    }

    if (process.env.HOME) {
        return path.join(process.env.HOME, '.cache', 'incognito-addon');
    }

    return path.join(os.tmpdir(), 'incognito-addon-cache');
}

let _cacheDir = null;
function getCacheDir() {
    if (_cacheDir) return _cacheDir;
    const dir = resolveCacheDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
        _cacheDir = dir;
    } catch (err) {
        console.warn('[config] cache dir create failed, caches will be in-memory only:', err.message);
        _cacheDir = null;
    }
    return _cacheDir;
}

function getConfig() {
    return {
        ...STATIC,
        // ADDON_PORT env override — used for local testing alongside a
        // production instance already bound to the default 7000.
        addonPort: process.env.ADDON_PORT
            ? parseInt(process.env.ADDON_PORT, 10) || STATIC.addonPort
            : STATIC.addonPort,
        prowlarrApiKey: getProwlarrApiKey(),
    };
}

module.exports = { getConfig, STATIC, invalidateApiKeyCache, getCacheDir };
