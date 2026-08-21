// Copyright (C) 2017-2026 Smart code 203358507

// Minimal promise-wrapped IndexedDB key/value store.
//
// Anything cached for the UI belongs here rather than in localStorage. The
// ~5 MB localStorage quota is shared with stremio-core's own writes (`library`,
// `library_recent`, `streaming_server_urls`) and small settings blobs; a
// multi-hundred-KB UI cache in there has already broken core's writes once.
// IndexedDB has a quota in the hundreds of MB and stores structured clones, so
// there is no JSON round-trip either.
//
// Every call fails soft: private-browsing, disabled storage or a blocked
// upgrade resolves to `undefined` / no-op rather than rejecting, so callers can
// treat the cache as a pure optimisation.

const DB_VERSION = 1;

function available() {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
        return false;
    }
}

function open(dbName, storeName) {
    return new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(dbName, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('indexeddb blocked'));
        } catch (error) {
            reject(error);
        }
    });
}

async function get(dbName, storeName, key) {
    if (!available()) return undefined;
    let db = null;
    try {
        db = await open(dbName, storeName);
        return await new Promise((resolve, reject) => {
            const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch {
        return undefined;
    } finally {
        if (db) {
            try { db.close(); } catch { /* already closed */ }
        }
    }
}

async function set(dbName, storeName, key, value) {
    if (!available()) return false;
    let db = null;
    try {
        db = await open(dbName, storeName);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        return true;
    } catch {
        // Quota exceeded, storage disabled, structured-clone failure — the
        // caller only loses a cache entry.
        return false;
    } finally {
        if (db) {
            try { db.close(); } catch { /* already closed */ }
        }
    }
}

async function del(dbName, storeName, key) {
    if (!available()) return false;
    let db = null;
    try {
        db = await open(dbName, storeName);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        return true;
    } catch {
        return false;
    } finally {
        if (db) {
            try { db.close(); } catch { /* already closed */ }
        }
    }
}

module.exports = { available, get, set, del };
