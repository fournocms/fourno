// fallow-ignore-file unused-file
// Loaded at runtime by plugin bundles via the import map in index.html.
// Fallow cannot see this static-asset path; the file is live in production.
/**
 * Plugin-runtime shim for `react-dom`.
 *
 * Mirrors `react.js`: the host's main bundle exposes its react-dom on
 * `globalThis.__fourno.ReactDOM`; this file re-exports the named
 * API for plugin code that needs portals or `flushSync`. Plugins should
 * NOT need `createRoot` — the host already controls the React root.
 */
const G = globalThis.__fourno?.ReactDOM
if (!G) {
  throw new Error(
    "[@fourno/runtime] Host ReactDOM not initialized. Did the host bundle finish loading before the plugin import?",
  )
}

export const createPortal = G.createPortal
export const flushSync = G.flushSync
export const version = G.version
export default G
