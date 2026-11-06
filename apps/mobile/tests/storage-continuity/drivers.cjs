'use strict';

/**
 * PR C (SDK 58) — storage drivers for the data-continuity harness.
 *
 * A "driver" is any object implementing the subset of the AsyncStorage
 * interface the app actually uses, plus the harness oracle:
 *   getItem(key) -> Promise<string|null>
 *   setItem(key, value) -> Promise<void>
 *   removeItem(key) -> Promise<void>
 *   getAllKeys() -> Promise<string[]>   (harness-only; no app call sites)
 *   clear() -> Promise<void>            (harness setup only)
 *
 * Two drivers exist:
 *
 *   - file: a JSON-file-backed store. It persists across processes, which
 *     makes it the Node-side stand-in for "the same on-device store, read
 *     again after the library underneath changed": capture in one process,
 *     swap the environment, verify in a fresh process.
 *
 *   - library: the installed @react-native-async-storage/async-storage
 *     package's own Jest mock (subpath export `./jest`). This runs the
 *     dataset through the JS surface of whichever library version is
 *     installed, so the same harness can run in CI against 3.1.1 (capture
 *     baseline) and against 2.2.0 (post-downgrade) and catch JS-surface
 *     differences. The mock is in-memory, so library-driver capture/verify
 *     is a same-process proof only — the cross-boundary (native) proof is
 *     the on-device Ticket 4 gate in PRC-CONTINUITY-PROOF-PLAN.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createFileDriver(filePath) {
  function load() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }
  function persist(map) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, filePath);
  }
  return {
    description: `file:${filePath}`,
    async getItem(key) {
      const map = load();
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },
    async setItem(key, value) {
      const map = load();
      map[key] = value;
      persist(map);
    },
    async removeItem(key) {
      const map = load();
      delete map[key];
      persist(map);
    },
    async getAllKeys() {
      return Object.keys(load());
    },
    async clear() {
      persist({});
    },
  };
}

/**
 * Resolve the installed library's Jest mock. Resolution order:
 *   1. ME_ASYNC_STORAGE_MOCK_PATH env var (absolute file path, or a module
 *      specifier) — used for out-of-tree probes where apps/mobile has no
 *      node_modules installed.
 *   2. The `@react-native-async-storage/async-storage/jest` subpath export,
 *      resolved from apps/mobile (works after `npm ci` in CI).
 *
 * Both shipped mocks are handled: 3.x exposes an ES module whose default
 * export is the "legacy" (v2-proxy) default storage instance; 2.x exposes
 * a CommonJS mock object directly. Throws with the underlying resolution
 * error when the package is not installed, so callers can skip honestly.
 */
async function loadLibraryDriver() {
  const override = process.env.ME_ASYNC_STORAGE_MOCK_PATH;
  let moduleUrl;
  let description;
  if (override) {
    moduleUrl = path.isAbsolute(override)
      ? pathToFileURL(override).href
      : override;
    description = `library-mock:${override}`;
  } else {
    const mobileRoot = path.resolve(__dirname, '..', '..');
    const resolved = require.resolve(
      '@react-native-async-storage/async-storage/jest',
      { paths: [mobileRoot] },
    );
    moduleUrl = pathToFileURL(resolved).href;
    description = `library-mock:${resolved}`;
  }
  const mod = await import(moduleUrl);
  let storage = null;
  if (mod.default && typeof mod.default.getItem === 'function') {
    storage = mod.default;
  } else if (typeof mod.createAsyncStorage === 'function') {
    storage = mod.createAsyncStorage('legacy');
  } else if (typeof mod.getItem === 'function') {
    storage = mod;
  }
  if (!storage) {
    throw new Error(
      `AsyncStorage mock at ${description} exposes no usable storage object`,
    );
  }
  return {
    description,
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    getAllKeys: () => storage.getAllKeys(),
    clear: async () => {
      if (typeof mod.clearAllMockStorages === 'function') {
        mod.clearAllMockStorages();
      }
      if (typeof storage.clear === 'function') {
        await storage.clear();
      }
    },
  };
}

module.exports = { createFileDriver, loadLibraryDriver };
