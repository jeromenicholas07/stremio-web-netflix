// Plain-CommonJS iOS detection, safe to require from non-React modules that are
// unit-tested under Jest's Node environment (where it simply returns false).
//
// The app-wide source of truth is src/common/Platform/device.ts (`name`), but
// that file is ESM/TypeScript and cannot be required by the CJS modules that
// Jest loads without a Babel transform. This mirrors its iOS heuristic:
//   - classic iOS devices expose 'iPhone'/'iPad'/'iPod' in navigator.platform
//   - iPadOS 13+ reports a Mac UA but has touch ('ontouchend' in document)
// visionOS (Mac UA + touch, no touch events but WebXR) is intentionally treated
// like iOS here since the same Safari web constraints apply.
function isIOS() {
    try {
        const nav =
            (typeof navigator !== 'undefined' && navigator) ||
            (typeof globalThis !== 'undefined' && globalThis.navigator) ||
            null;
        if (!nav) return false;

        const ua = nav.userAgent || '';
        const platform = nav.platform || '';
        const APPLE_MOBILE = ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'];
        const macWithTouch = /Mac/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document;

        return APPLE_MOBILE.includes(platform) || macWithTouch;
    } catch {
        return false;
    }
}

module.exports = isIOS;
