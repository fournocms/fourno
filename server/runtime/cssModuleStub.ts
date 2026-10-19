/**
 * Server-side stub for stylesheet imports.
 *
 * The module registry (`@modules/base`) pairs every block definition with its
 * React editor component, and those components import `*.module.css`. The
 * server needs the registry (inline-text props, publish rendering) but never
 * renders an editor, so the class names are irrelevant here. Bun accepted CSS
 * imports at runtime; Node rejects the extension (ERR_UNKNOWN_FILE_EXTENSION),
 * so this hook answers every `.css` load with a class-name proxy instead.
 *
 * Import this module before anything that can reach `src/`; it registers on
 * evaluation. Vitest and Vite handle CSS themselves and never load it.
 */
import { registerHooks } from 'node:module'

const CLASS_NAME_PROXY_SOURCE =
  'export default new Proxy({}, { get: (_target, name) => (typeof name === "string" ? name : undefined) })'

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.css')) return nextLoad(url, context)
    return { format: 'module', source: CLASS_NAME_PROXY_SOURCE, shortCircuit: true }
  },
})
