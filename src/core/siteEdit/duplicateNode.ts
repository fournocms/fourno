/**
 * Duplicate a node subtree together with the per-node scoped classes it owns.
 *
 * Shared by the editor store's `duplicateNode(s)` and the server edit path.
 */

import { nanoid } from 'nanoid'
import { cloneScopedClassesForNodeMap, duplicateNode } from '@core/page-tree'
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'

/**
 * Build the oldId → newId map for the entire subtree rooted at `nodeId`.
 * Pre-computed so callers can clone scoped classes (which key on
 * `scope.nodeId`) against the same id remap that the duplicate mutation will
 * apply to the nodes themselves.
 */
function buildSubtreeIdMap(tree: NodeTree<PageNode>, nodeId: string): Map<string, string> {
  const idMap = new Map<string, string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (idMap.has(id)) continue
    const node = tree.nodes[id]
    if (!node) continue
    idMap.set(id, nanoid())
    stack.push(...node.children)
  }
  return idMap
}

/**
 * Duplicate a node subtree AND clone every per-node scoped class owned by the
 * subtree. Mirrors the contract used by `clipboardSlice.pasteNode` and
 * `visualComponentsSlice.clonePageSubtreeToFlatNodes` so the publisher can
 * never end up with two nodes pointing at the same scoped class — see F-0005.
 *
 * Must run inside a Mutative recipe (mutates `tree` and `site` directly).
 * Returns the new root id, or '' when `nodeId` is not in the tree.
 */
export function duplicateNodeWithScopedClasses(
  tree: NodeTree<PageNode>,
  site: SiteDocument,
  nodeId: string,
): string {
  const nodeIdMap = buildSubtreeIdMap(tree, nodeId)
  if (nodeIdMap.size === 0) return ''

  const { added, classIdRemap } = cloneScopedClassesForNodeMap(nodeIdMap, site.styleRules)
  for (const cls of added) site.styleRules[cls.id] = cls

  return duplicateNode(tree, nodeId, { nodeIdMap, classIdRemap })
}
