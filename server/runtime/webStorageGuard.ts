/**
 * Keeps Node's experimental Web Storage getter from firing at server boot.
 *
 * Node 25+ ships a global `localStorage` accessor that prints
 * `ExperimentalWarning: localStorage is not available because
 * --localstorage-file was not provided` the first time anything reads it.
 * `lib0` (a dependency of Yjs, so of the collab relay) probes
 * `typeof localStorage` while it is imported and falls back to an in-memory map
 * when the global is undefined, which is exactly what the server wants. A
 * server has no use for browser storage, so shadow the accessor with
 * `undefined` before that import runs.
 *
 * Import this module before anything that can reach Yjs; it applies on
 * evaluation. Node versions without the accessor (22, 24) are left untouched.
 */
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

if (storageDescriptor?.get) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}
