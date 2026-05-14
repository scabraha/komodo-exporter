/**
 * Browser polyfills for `komodo_client` / `mogh_auth_client`.
 *
 * `mogh_auth_client/dist/tokens.js` reads `localStorage.getItem(...)` at
 * module init, which crashes Node.js. The exporter never logs in via JWT
 * (we use API key + secret), so the contents of the store don't matter —
 * we just need the calls to be no-ops.
 *
 * This file MUST be imported as the very first side-effect of any module
 * that ultimately pulls in `komodo_client`.
 */

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

declare global {
   
  var localStorage: MinimalStorage | undefined;
   
  var sessionStorage: MinimalStorage | undefined;
}

function makeStorage(): MinimalStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

function isWorkingStorage(value: unknown): value is MinimalStorage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { getItem?: unknown };
  if (typeof candidate.getItem !== "function") return false;
  try {
    (candidate.getItem as (k: string) => unknown)("__komodo_exporter_probe__");
    return true;
  } catch {
    // Node 22+ ships an experimental localStorage that throws unless
    // `--experimental-webstorage` is enabled. Treat that as "missing".
    return false;
  }
}

if (!isWorkingStorage(globalThis.localStorage)) {
  globalThis.localStorage = makeStorage();
}
if (!isWorkingStorage(globalThis.sessionStorage)) {
  globalThis.sessionStorage = makeStorage();
}

export {};
