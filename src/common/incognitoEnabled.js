// Copyright (C) 2017-2023 Smart code 203358507

// Whether the Incognito section is available in this install.
//
// The real state lives in a flag file next to the launcher's install
// (%LOCALAPPDATA%\StremioLauncherFULL\incognito.flag) because it decides
// whether StremioLauncherFULL.exe downloads and starts Prowlarr,
// FlareSolverr and the addon at all. The UI can't read that file, so the
// Settings toggle mirrors it here and the nav reads the mirror.
//
// Off unless explicitly turned on: a fresh install has neither the flag nor
// the key, and the tab shouldn't appear for someone who never asked for it.

const STORAGE_KEY = 'netflix_ui_incognito_enabled';

const isIncognitoEnabled = () => {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        // Private mode / storage disabled — fall back to off.
        return false;
    }
};

const setIncognitoEnabled = (enabled) => {
    try {
        localStorage.setItem(STORAGE_KEY, String(enabled));
        return localStorage.getItem(STORAGE_KEY) === String(enabled);
    } catch {
        return false;
    }
};

module.exports = { STORAGE_KEY, isIncognitoEnabled, setIncognitoEnabled };
