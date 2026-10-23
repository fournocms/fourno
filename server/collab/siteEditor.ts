/**
 * Server-side site editor — edits the collab Y documents WITHOUT a browser.
 *
 * PRD §8.6 / SECURITY §5.5: an agent must be able to build a page while nobody
 * has the admin open, and an editor that IS open must see those edits live.
 * The Yjs document stays the single source of truth, so this is not a second
 * write path next to the relay — it is one more Yjs peer, running inside the
 * server, that goes through the same three gates a browser peer does:
 *
 *   1. Mutation: a pure recipe (`@core/siteEdit`, the same functions the editor
 *      store uses) runs against a Mutative draft of the projected site.
 *   2. Translation: the recipe's patches become Y operations via
 *      `applySitePatchesToDocs` — the editor's own write translator — on FORKS
 *      of the live documents, yielding one update per touched doc.
 *   3. Guard: every update passes `validateGuardedUpdate` with the caller's
 *      capabilities (the check partial-capability sockets get) BEFORE any live
 *      doc is touched. One forbidden update refuses the whole edit.
 *
 * Only then are the updates applied to the live relay docs, which persists
 * them through the relay's normal debounce and broadcasts them to every open
 * editor. Projecting, mutating, translating and guarding contain no `await`,
 * so a concurrent human edit cannot interleave with a recipe. The one `await`
 * after the guard exists only when a recipe CREATED rows: their relay docs are
 * opened first, then every update is applied in one synchronous pass.
 */
import * as Y from 'yjs'
import { create } from 'mutative'
import type { Patches } from 'mutative'
import type { CoreCapability } from '@core/capabilities'
import {
  applySitePatchesToDocs,
  createCollabDocSet,
  encodeCollabDocId,
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
  siteDocId,
} from '@core/collab'
import { validateSite } from '@core/persistence/validate'
import type { SiteDocument } from '@core/page-tree'
import type { CollabRelay } from './relay'
import { validateGuardedUpdate } from './updateGuard'

/** Transaction origin of every server-originated edit. */
export const SERVER_EDIT_ORIGIN = Symbol('collab-server-edit')

/** Thrown when the caller's capabilities do not allow the edit it produced. */
export class SiteEditForbiddenError extends Error {
  constructor(reason: string) {
    super(`Edit refused: ${reason}`)
    this.name = 'SiteEditForbiddenError'
  }
}

/** Thrown by a recipe to refuse an edit; the draft is discarded. */
export class SiteEditRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiteEditRefusedError'
  }
}

export interface SiteEditRequest {
  branchId: string
  /** The acting identity's capabilities — the guard enforces them per doc. */
  capabilities: readonly CoreCapability[]
}

export interface SiteEditOutcome<T> {
  value: T
  /** False when the recipe produced no change (nothing was written). */
  changed: boolean
  /** Doc ids that received an update. */
  touchedDocIds: string[]
}

export interface SiteEditor {
  /**
   * Run `recipe` against the live site and write its result back as Y
   * updates. The recipe mutates the `site` draft it receives and returns the
   * value handed back to the caller; it refuses by throwing
   * `SiteEditRefusedError`.
   */
  edit<T>(request: SiteEditRequest, recipe: (site: SiteDocument) => T): Promise<SiteEditOutcome<T>>
  /** Read the live site — reflects edits still inside the relay's persist debounce. */
  read<T>(branchId: string, reader: (site: SiteDocument) => T): Promise<T>
  /** Release every warm document hold (tests + shutdown). */
  dispose(): void
}

export interface SiteEditorOptions {
  /**
   * How long documents stay resident after the last call. An agent building a
   * page issues a burst of calls; re-hydrating every doc per call is the cost
   * this amortises. 0 releases right after each call (tests).
   */
  holdMs?: number
}

const DEFAULT_HOLD_MS = 20_000

/** The shell row id — not collaborative, injected at every projection boundary. */
const SHELL_ID = 'default'

interface DocUpdate {
  docId: string
  update: Uint8Array
}

export function createSiteEditor(relay: CollabRelay, options: SiteEditorOptions = {}): SiteEditor {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS
  const held = new Set<string>()
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  // Calls run one at a time: they share the held-doc set, and a recipe that
  // creates rows awaits between projecting and applying, which a second call
  // must not observe half-way.
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation)
    queue = run.catch(() => undefined)
    return run
  }

  function releaseHeld(): void {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
    for (const docId of held) relay.release(docId)
    held.clear()
  }

  function armHold(): void {
    if (holdMs === 0) return
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = setTimeout(releaseHeld, holdMs)
    // A warm hold must never keep the process alive on its own.
    holdTimer.unref()
  }

  async function holdDoc(docId: string): Promise<Y.Doc> {
    if (held.has(docId)) return (await relay.openDoc(docId)).doc
    const { doc } = await relay.retain(docId)
    held.add(docId)
    return doc
  }

  function rosterDocIds(branchId: string, siteDoc: Y.Doc): string[] {
    const { rosters } = projectSiteDoc(siteDoc)
    return [
      ...rosters.pages.map((rowId) => encodeCollabDocId({ kind: 'page', branchId, rowId })),
      ...rosters.components.map((rowId) => encodeCollabDocId({ kind: 'component', branchId, rowId })),
      ...rosters.layouts.map((rowId) => encodeCollabDocId({ kind: 'layout', branchId, rowId })),
    ]
  }

  /**
   * Hold the shell doc and every rostered row doc of a branch. Loops until the
   * roster is stable: a concurrent edit may add a row while the earlier ones
   * were still opening.
   */
  async function loadDocs(branchId: string): Promise<Map<string, Y.Doc>> {
    const shellId = siteDocId(branchId)
    const docs = new Map<string, Y.Doc>([[shellId, await holdDoc(shellId)]])
    for (;;) {
      const missing = rosterDocIds(branchId, docs.get(shellId)!).filter((docId) => !docs.has(docId))
      if (missing.length === 0) return docs
      const opened = await Promise.all(missing.map((docId) => holdDoc(docId)))
      missing.forEach((docId, index) => docs.set(docId, opened[index]!))
    }
  }

  /** Assemble the full SiteDocument from the live docs. Synchronous. */
  function projectSite(branchId: string, docs: ReadonlyMap<string, Y.Doc>): SiteDocument {
    const docOf = (docId: string): Y.Doc => {
      const doc = docs.get(docId)
      if (!doc) throw new Error(`[siteEditor] document ${docId} is not loaded`)
      return doc
    }
    const projected = projectSiteDoc(docOf(siteDocId(branchId)))
    if (Object.keys(projected.shell).length === 0) throw new Error('No site found.')
    // Same validation boundary the relay's persist path and the editor's
    // projection use: one corrupt style rule must not poison the whole edit.
    const shell = validateSite({
      ...projected.shell,
      id: SHELL_ID,
      updatedAt: typeof projected.shell.updatedAt === 'number' ? projected.shell.updatedAt : Date.now(),
    })
    const rowDocId = (kind: 'page' | 'component' | 'layout', rowId: string): string =>
      encodeCollabDocId({ kind, branchId, rowId })

    const pages = projected.rosters.pages
      .map((rowId) => projectPageDoc(docOf(rowDocId('page', rowId)), rowId))
      .filter((page) => page.rootNodeId)
    const visualComponents = projected.rosters.components
      .map((rowId) => projectComponentDoc(docOf(rowDocId('component', rowId)), rowId))
      .filter((component) => component.tree.rootNodeId)
    const layouts = projected.rosters.layouts
      .map((rowId) => projectLayoutDoc(docOf(rowDocId('layout', rowId)), rowId))
      .filter((layout) => layout.rootNodeId)

    const site: SiteDocument = { ...shell, pages, visualComponents, layouts }
    if (projected.shell.conditions === undefined) delete site.conditions
    return site
  }

  /**
   * Replay `patches` onto forks of the live docs and collect one update per
   * touched doc. Row docs come before the shell so a roster never names a row
   * that has no content yet.
   */
  function translateToUpdates(
    branchId: string,
    docs: ReadonlyMap<string, Y.Doc>,
    before: SiteDocument,
    after: SiteDocument,
    patches: Patches,
  ): DocUpdate[] {
    const forks = createCollabDocSet()
    const baselines = new Map<string, Uint8Array>()
    for (const [docId, liveDoc] of docs) {
      const fork = new Y.Doc()
      Y.applyUpdate(fork, Y.encodeStateAsUpdate(liveDoc))
      forks.set(docId, fork)
      baselines.set(docId, Y.encodeStateVector(liveDoc))
    }
    const touched = applySitePatchesToDocs(patches, before, after, forks, SERVER_EDIT_ORIGIN, branchId)
    const shellId = siteDocId(branchId)
    const ordered = [...touched.filter((id) => id !== shellId), ...touched.filter((id) => id === shellId)]
    return ordered.flatMap((docId) => {
      const fork = forks.get(docId)
      if (!fork) return []
      const baseline = baselines.get(docId)
      return [{ docId, update: baseline ? Y.encodeStateAsUpdate(fork, baseline) : Y.encodeStateAsUpdate(fork) }]
    })
  }

  function read<T>(branchId: string, reader: (site: SiteDocument) => T): Promise<T> {
    return serialized(() => readNow(branchId, reader))
  }

  async function readNow<T>(branchId: string, reader: (site: SiteDocument) => T): Promise<T> {
    try {
      const docs = await loadDocs(branchId)
      armHold()
      return reader(projectSite(branchId, docs))
    } finally {
      if (holdMs === 0) releaseHeld()
    }
  }

  function edit<T>(
    request: SiteEditRequest,
    recipe: (site: SiteDocument) => T,
  ): Promise<SiteEditOutcome<T>> {
    return serialized(() => editNow(request, recipe))
  }

  async function editNow<T>(
    request: SiteEditRequest,
    recipe: (site: SiteDocument) => T,
  ): Promise<SiteEditOutcome<T>> {
    const { branchId, capabilities } = request
    try {
      const docs = await loadDocs(branchId)
      armHold()

      // ── Synchronous from here to the guard: no peer can interleave. ───────
      const before = projectSite(branchId, docs)
      let value!: T
      const [after, allPatches] = create(
        before,
        (draft) => {
          value = recipe(draft as SiteDocument)
          draft.updatedAt = Date.now()
        },
        { enablePatches: true },
      )
      // `updatedAt` is not collaborative; a recipe that changed nothing else
      // leaves only that patch behind.
      const patches = allPatches.filter((patch) => patch.path[0] !== 'updatedAt')
      if (patches.length === 0) return { value, changed: false, touchedDocIds: [] }

      const updates = translateToUpdates(branchId, docs, before, after, patches)
      for (const { docId, update } of updates) {
        // A brand-new row has no live doc: its previous state is empty, which
        // the guard classifies as a structural creation.
        const verdict = validateGuardedUpdate(docId, docs.get(docId) ?? new Y.Doc(), update, capabilities)
        if (!verdict.ok) throw new SiteEditForbiddenError(verdict.reason)
      }

      // Rows the recipe created have no relay doc yet; opening one is async.
      const created = updates.filter(({ docId }) => !docs.has(docId))
      if (created.length > 0) {
        const opened = await Promise.all(created.map(({ docId }) => holdDoc(docId)))
        created.forEach(({ docId }, index) => docs.set(docId, opened[index]!))
      }
      for (const { docId, update } of updates) Y.applyUpdate(docs.get(docId)!, update, SERVER_EDIT_ORIGIN)
      return { value, changed: true, touchedDocIds: updates.map((entry) => entry.docId) }
    } finally {
      if (holdMs === 0) releaseHeld()
    }
  }

  return { edit, read, dispose: releaseHeld }
}

// ---------------------------------------------------------------------------
// Process-wide editor — the relay is created once at boot (server/index.ts),
// tools reach it through this seam like publish reaches the relay flush.
// ---------------------------------------------------------------------------

let active: SiteEditor | null = null

/** Install the process-wide editor over `relay`. Returns an uninstall function. */
export function configureSiteEditor(relay: CollabRelay, options?: SiteEditorOptions): () => void {
  const editor = createSiteEditor(relay, options)
  active = editor
  return () => {
    editor.dispose()
    if (active === editor) active = null
  }
}

export function getSiteEditor(): SiteEditor {
  if (!active) throw new Error('[siteEditor] not configured — the collab relay has not started')
  return active
}
