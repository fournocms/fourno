/**
 * Browser runtime for `base.loop` infinite loading.
 *
 * Self-contained ES module — no dependencies, no framework. The publisher
 * injects a `<script type="module" src="/_fourno/assets/loop-runtime.js">` tag
 * into pages that contain at least one `pagination='infinite'` loop.
 *
 * On load, the runtime:
 *   1. Finds every `[data-fourno-loop][data-fourno-loop-mode="infinite"]` element.
 *   2. If `data-fourno-loop-has-more="true"`, attaches a "Load more" button.
 *   3. On click, fetches `<endpoint>/<loopId>?page=N` and appends the
 *      returned HTML to the wrapper, then increments the page counter.
 *   4. When `hasMore=false`, removes the button.
 *
 * Endpoint URL is read from `data-fourno-loop-endpoint` on the script tag —
 * defaults to `/_fourno/loop/`. Each loop sends its own pageId (the published
 * page) via a header attached at server-render time below.
 *
 * The runtime is intentionally tiny (< 2 KB minified) to keep the
 * "no JS by default" promise honest — it ships only when at least one
 * infinite-mode loop exists on the page.
 */

function runFournoLoopRuntime(): void {
  // Located by attribute rather than `document.currentScript`, which the HTML
  // spec leaves null inside a module script — and the publisher injects this
  // as `type="module"`. Reading currentScript therefore always fell through to
  // the default below, so the endpoint attribute was never honoured. The
  // runtime is deferred by virtue of being a module, so the tag is parsed and
  // queryable by the time this runs.
  const scriptEl = document.querySelector('script[data-fourno-loop-endpoint]')
  const endpointBase =
    (scriptEl && scriptEl.getAttribute('data-fourno-loop-endpoint')) || '/_fourno/loop/'
  const pagePath = location.pathname

  function attach(loopEl: Element): void {
    let pageNumber = parseInt(loopEl.getAttribute('data-fourno-loop-page') || '1', 10)
    let hasMore = loopEl.getAttribute('data-fourno-loop-has-more') === 'true'
    if (!hasMore) return

    const loopId = loopEl.getAttribute('data-fourno-loop')
    if (!loopId) return

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fourno-loop-load-more'
    button.textContent = 'Load more'
    button.setAttribute('data-fourno-loop-load-more', loopId)

    let busy = false
    button.addEventListener('click', async () => {
      if (busy || !hasMore) return
      busy = true
      button.disabled = true
      const prev = button.textContent
      button.textContent = 'Loading…'
      try {
        const params = new URLSearchParams({
          page: String(pageNumber + 1),
          pagePath: pagePath,
        })
        const res = await fetch(endpointBase + encodeURIComponent(loopId) + '?' + params.toString(), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) throw new Error('Loop fetch failed: ' + res.status)
        const body = await res.json()
        if (typeof body.html === 'string' && body.html.length > 0) {
          // Insert before the button so the button stays at the end.
          button.insertAdjacentHTML('beforebegin', body.html)
        }
        pageNumber += 1
        hasMore = body.hasMore === true
        loopEl.setAttribute('data-fourno-loop-page', String(pageNumber))
        loopEl.setAttribute('data-fourno-loop-has-more', hasMore ? 'true' : 'false')
        if (!hasMore) {
          button.remove()
        }
      } catch (err) {
        console.error('[fourno-loop]', err)
        button.textContent = 'Try again'
      } finally {
        busy = false
        button.disabled = false
        if (button.textContent === 'Loading…') button.textContent = prev
      }
    })

    loopEl.appendChild(button)
  }

  function init(): void {
    document.querySelectorAll('[data-fourno-loop][data-fourno-loop-mode="infinite"]').forEach(attach)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
}

export const LOOP_RUNTIME_JS = `(${runFournoLoopRuntime.toString()})();`
