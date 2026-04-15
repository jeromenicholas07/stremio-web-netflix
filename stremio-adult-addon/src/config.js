const fs = require('fs');
const path = require('path');

// Everything is bundled and runs on loopback, so URLs and ports are deterministic.
// The Prowlarr API key is auto-discovered from Prowlarr's own config.xml on disk —
// no user-facing configuration required.

const STATIC = {
    prowlarrUrl: 'http://127.0.0.1:9696',
    addonPort: 7000,
    // 6000 = XXX parent + standard XXX subcategories
    adultCategories: [6000, 6010, 6020, 6030, 6040, 6050, 6060, 6070],
    pageSize: 50,
    dedupThreshold: 0.8,
    cacheTtl: 15 * 60 * 1000,
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

function getProwlarrApiKey() {
    // Env var always wins (useful for dev / non-bundled deployments)
    if (process.env.PROWLARR_API_KEY) return process.env.PROWLARR_API_KEY;

    // Cache once we've successfully read it from disk
    if (_apiKey) return _apiKey;

    const fromDisk = readApiKeyFromDisk();
    if (fromDisk) {
        _apiKey = fromDisk;
        console.log('[config] Discovered Prowlarr API key from config.xml');
    }
    return _apiKey || '';
}

function getConfig() {
    return {
        ...STATIC,
        prowlarrApiKey: getProwlarrApiKey(),
    };
}

module.exports = { getConfig, STATIC };
