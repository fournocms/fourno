/**
 * Parse an HTML string into a DOM Document.
 *
 * Browser-side this is the global `DOMParser`. This module MUST NOT statically
 * import happy-dom, jsdom or any other DOM library: `src/core/` is bundled into
 * the browser and a static import would bloat the bundle.
 *
 * The server has no ambient DOM, so it installs one with `configureHtmlParser`
 * (see `server/richtextSanitizer.ts`, which already owns the server's jsdom
 * window). In `pnpm test` the test setup (`src/__tests__/setup.ts`) polyfills
 * `globalThis.DOMParser` via happy-dom, so tests need no configuration.
 */

export type HtmlParser = (source: string) => Document

let installedParser: HtmlParser | null = null

/** Install the parser used where no global `DOMParser` exists (the server). */
export function configureHtmlParser(parser: HtmlParser | null): void {
  installedParser = parser
}

export function parseHtml(source: string): Document {
  if (installedParser) return installedParser(source)
  return new DOMParser().parseFromString(source, 'text/html')
}
