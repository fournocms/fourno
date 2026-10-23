/**
 * Document-tree addressing for headless edits.
 *
 * The editor mutates "the active document" — a page or a Visual Component
 * tree chosen by `activeDocument`. A headless caller has no active document;
 * it addresses a node by id and the owning tree is looked up. Node ids are
 * nanoids, unique across every page and component tree of a site.
 */

import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { collectSlotOutletNames } from '@core/visualComponents'
import { allTreeNodeMaps, syncAllVCRefSlotInstances } from './slotReconcile'

/** A document tree inside a site, plus the component that owns it (if any). */
export interface DocumentTreeTarget {
  readonly kind: 'page' | 'visualComponent'
  readonly documentId: string
  readonly tree: NodeTree<PageNode>
  /** Set for component trees: edits there must re-sync slot instances. */
  readonly vc: VisualComponent | null
}

/** The document whose tree contains `nodeId`, or null when no tree does. */
export function findNodeDocument(site: SiteDocument, nodeId: string): DocumentTreeTarget | null {
  const page = site.pages.find((candidate) => candidate.nodes[nodeId])
  if (page) return { kind: 'page', documentId: page.id, tree: page, vc: null }
  const vc = site.visualComponents.find((candidate) => candidate.tree.nodes[nodeId])
  if (vc) {
    // VCNode is structurally compatible with PageNode (dynamicBindings is optional).
    return { kind: 'visualComponent', documentId: vc.id, tree: vc.tree as NodeTree<PageNode>, vc }
  }
  return null
}

/** The document tree for a page id or component id, or null. */
export function findDocumentTree(
  site: SiteDocument,
  kind: 'page' | 'visualComponent',
  documentId: string,
): DocumentTreeTarget | null {
  if (kind === 'page') {
    const page = site.pages.find((candidate) => candidate.id === documentId)
    return page ? { kind, documentId, tree: page, vc: null } : null
  }
  const vc = site.visualComponents.find((candidate) => candidate.id === documentId)
  return vc ? { kind, documentId, tree: vc.tree as NodeTree<PageNode>, vc } : null
}

/**
 * Run a tree recipe against `target`. When the target is a component tree and
 * the recipe changed its ordered slot-outlet names, every consumer ref across
 * all pages and component trees is re-synced inside the same recipe — the same
 * contract the editor's `mutateActiveTree` keeps, so slot instances never
 * dangle after a headless edit.
 *
 * Must run inside a Mutative recipe over `site`.
 */
export function editDocumentTree<T>(
  site: SiteDocument,
  target: DocumentTreeTarget,
  recipe: (tree: NodeTree<PageNode>) => T,
): T {
  const { tree, vc } = target
  if (!vc) return recipe(tree)
  const outletNamesBefore = collectSlotOutletNames(vc.tree)
  const result = recipe(tree)
  const outletNamesAfter = collectSlotOutletNames(vc.tree)
  const changed =
    outletNamesBefore.length !== outletNamesAfter.length ||
    outletNamesBefore.some((name, index) => name !== outletNamesAfter[index])
  if (changed) syncAllVCRefSlotInstances(allTreeNodeMaps(site), vc.id, vc)
  return result
}
