// Copyright (C) 2017-2023 Smart code 203358507

if (typeof process.env.SENTRY_DSN === 'string') {
    const Sentry = require('@sentry/browser');
    Sentry.init({ dsn: process.env.SENTRY_DSN });
}

// The Stremio shell (stremio-shell-ng.exe) injects a script that calls initShellComm()
// on page load to establish communication with the Qt WebChannel transport.
// Define it early so it's available when the shell's load handler fires.
// The actual Shell service initialization happens later in React (App.js → shell.start()),
// but this prevents the ReferenceError from the shell's injected script.
window.initShellComm = function() {
    // Shell transport is initialized by Shell.start() in App.js.
    // This stub satisfies the shell's load-time check.
};

// Prune localStorage at startup: drop superseded legacy keys (deprecated
// watchlist/ratings keys, old Incognito/TMDB cache versions) and budget-evict
// the largest rebuildable caches so they can't fill the shared ~5 MB quota and
// break stremio-core's writes or small settings (auto-pick, debug).
try {
    require('stremio/common/pruneStorage').pruneStorage();
} catch { /* */ }

const Bowser = require('bowser');
const browser = Bowser.parse(window.navigator?.userAgent || '');
if (browser?.platform?.type === 'desktop') {
    document.querySelector('meta[name="viewport"]')?.setAttribute('content', '');
}

// iOS standalone PWAs can report env(safe-area-inset-*) as 0 on notched devices,
// hiding the top nav under the notch. Apply a screen-size-based fallback before
// the UI paints. No-op on every non-iOS-standalone context.
try {
    require('stremio/common/iosSafeArea')();
} catch { /* */ }

const React = require('react');
const ReactDOM = require('react-dom/client');
const i18n = require('i18next');
const { initReactI18next } = require('react-i18next');
const stremioTranslations = require('stremio-translations');
const App = require('./App');

const translations = Object.fromEntries(Object.entries(stremioTranslations()).map(([key, value]) => [key, {
    translation: value
}]));

i18n
    .use(initReactI18next)
    .init({
        resources: translations,
        lng: 'en-US',
        fallbackLng: 'en-US',
        interpolation: {
            escapeValue: false
        }
    });

const root = ReactDOM.createRoot(document.getElementById('app'));

// The shell's localStorage lives inside the Stremio install directory, so a
// repair install or a cleared profile signs the user out of Trakt. The launcher
// keeps an encrypted copy of the session elsewhere; restore from it before the
// first render, because the home screen decides whether to sync on mount and
// won't reconsider afterwards.
//
// Capped and swallowed: with no launcher listening the loopback fetch is
// refused immediately, and any failure here must still leave us rendering.
const restoreTraktSession = () => {
    try {
        const traktBridge = require('stremio/services/TraktBridge');
        return Promise.race([
            traktBridge.restoreSessionFromLauncher(),
            new Promise((resolve) => setTimeout(resolve, 1500)),
        ]).catch(() => undefined);
    } catch {
        return Promise.resolve();
    }
};

restoreTraktSession().then(() => root.render(<App />));

if (process.env.NODE_ENV === 'production' && process.env.SERVICE_WORKER_DISABLED !== 'true' && process.env.SERVICE_WORKER_DISABLED !== true && 'serviceWorker' in navigator) {
    // When a freshly-deployed service worker activates and takes control
    // (skipWaiting + clientsClaim), reload once so the page re-fetches the
    // now-current index.html (network-first) and runs the latest bundle. This
    // makes a deploy take effect on the FIRST relaunch of the Stremio shell
    // instead of leaving the user on stale code until they restart twice.
    //
    // Guarded against reload loops, and skipped on the very first install
    // (no prior controller) where there is no stale page to replace.
    let reloadingForSwUpdate = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadingForSwUpdate || !hadController) return;
        reloadingForSwUpdate = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js')
            .catch((registrationError) => {
                console.error('SW registration failed: ', registrationError);
            });
    });
}
