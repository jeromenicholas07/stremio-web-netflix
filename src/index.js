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

// Clean up deprecated localStorage keys — Trakt is now the single source of truth
try {
    localStorage.removeItem('stremio_watchlist');
    localStorage.removeItem('stremio_not_interested');
    localStorage.removeItem('stremio_ratings');
    localStorage.removeItem('stremio_dismissed_names');
} catch { /* */ }

const Bowser = require('bowser');
const browser = Bowser.parse(window.navigator?.userAgent || '');
if (browser?.platform?.type === 'desktop') {
    document.querySelector('meta[name="viewport"]')?.setAttribute('content', '');
}

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
root.render(<App />);

if (process.env.NODE_ENV === 'production' && process.env.SERVICE_WORKER_DISABLED !== 'true' && process.env.SERVICE_WORKER_DISABLED !== true && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js')
            .catch((registrationError) => {
                console.error('SW registration failed: ', registrationError);
            });
    });
}
