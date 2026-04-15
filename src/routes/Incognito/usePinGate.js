const React = require('react');

const PIN_HASH_KEY = 'incognito_pin_hash';
const SESSION_KEY = 'incognito_unlocked';
const SALT = 'stremio_incognito_v1_';

async function hashPin(pin) {
    const data = new TextEncoder().encode(SALT + pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hook for managing the PIN gate state.
 *
 * Returns: { state, createPin, verifyPin, resetPin, lock }
 *   state: 'no_pin' | 'locked' | 'unlocked'
 */
const usePinGate = () => {
    const [state, setState] = React.useState(() => {
        const hasPin = !!localStorage.getItem(PIN_HASH_KEY);
        if (!hasPin) return 'no_pin';
        const unlocked = sessionStorage.getItem(SESSION_KEY) === 'true';
        return unlocked ? 'unlocked' : 'locked';
    });

    const createPin = React.useCallback(async (pin) => {
        const hash = await hashPin(pin);
        localStorage.setItem(PIN_HASH_KEY, hash);
        sessionStorage.setItem(SESSION_KEY, 'true');
        setState('unlocked');
    }, []);

    const verifyPin = React.useCallback(async (pin) => {
        const storedHash = localStorage.getItem(PIN_HASH_KEY);
        const hash = await hashPin(pin);
        if (hash === storedHash) {
            sessionStorage.setItem(SESSION_KEY, 'true');
            setState('unlocked');
            return true;
        }
        return false;
    }, []);

    const resetPin = React.useCallback(() => {
        localStorage.removeItem(PIN_HASH_KEY);
        sessionStorage.removeItem(SESSION_KEY);
        setState('no_pin');
    }, []);

    const lock = React.useCallback(() => {
        sessionStorage.removeItem(SESSION_KEY);
        setState('locked');
    }, []);

    return { state, createPin, verifyPin, resetPin, lock };
};

module.exports = usePinGate;
