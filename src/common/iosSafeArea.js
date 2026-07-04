// iOS standalone safe-area fallback.
//
// iOS home-screen (standalone) web apps sometimes report env(safe-area-inset-*)
// as 0 even on notched / Dynamic Island iPhones — a long-standing WebKit quirk
// with manifest-based PWAs. When that happens the top nav (search, account)
// renders under the notch and can't be tapped. The app's CSS is correct; iOS
// just isn't reporting the inset.
//
// This detects that exact case (iOS standalone AND env() measures 0) and sets
// the --safe-area-inset-* CSS variables from the screen size instead, so tap
// targets clear the notch and home indicator. It touches ONLY iOS standalone —
// Safari tabs, desktop, and Android keep the real CSS env() values.

// Probe the true env(safe-area-inset-top) the browser reports (independent of
// our --safe-area-inset-top override, since the probe uses env() directly).
function measureEnvInsetTop() {
    try {
        const probe = document.createElement('div');
        probe.style.cssText =
            'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
        document.body.appendChild(probe);
        const px = parseFloat(window.getComputedStyle(probe).paddingTop) || 0;
        probe.remove();
        return px;
    } catch {
        return 0;
    }
}

function apply() {
    const nav = window.navigator;
    // iOS standalone home-screen app only.
    if (!nav || nav.standalone !== true) return;
    // If WebKit reports a real inset, trust the CSS env() values — don't override.
    if (measureEnvInsetTop() > 0) return;

    const root = document.documentElement.style;
    const longEdge = Math.max(window.screen.width || 0, window.screen.height || 0);
    const notched = longEdge >= 812; // iPhone X and later have a notch / Dynamic Island
    const portrait = window.innerHeight >= window.innerWidth;

    if (!notched) {
        // Non-notch iPhones (SE / 8): ~20px status bar, no home indicator.
        root.setProperty('--safe-area-inset-top', portrait ? '20px' : '0px');
        root.setProperty('--safe-area-inset-right', '0px');
        root.setProperty('--safe-area-inset-bottom', '0px');
        root.setProperty('--safe-area-inset-left', '0px');
        return;
    }

    if (portrait) {
        // 59px comfortably clears both the classic notch (~47px) and the
        // Dynamic Island (~59px); 34px is the home-indicator inset.
        root.setProperty('--safe-area-inset-top', '59px');
        root.setProperty('--safe-area-inset-right', '0px');
        root.setProperty('--safe-area-inset-bottom', '34px');
        root.setProperty('--safe-area-inset-left', '0px');
    } else {
        // Landscape: the notch moves to a side; smaller home indicator at bottom.
        root.setProperty('--safe-area-inset-top', '0px');
        root.setProperty('--safe-area-inset-right', '47px');
        root.setProperty('--safe-area-inset-bottom', '21px');
        root.setProperty('--safe-area-inset-left', '47px');
    }
}

function initIOSSafeAreaFallback() {
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
}

module.exports = initIOSSafeAreaFallback;
