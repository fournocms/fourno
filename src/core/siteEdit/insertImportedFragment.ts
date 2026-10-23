/**
 * Insert an imported HTML fragment into a document tree — the single
 * implementation behind the editor store's `insertImportedNodes` AND the
 * server-side agent edit path.
 *
 * Pure recipe: it mutates the `tree` and `site` drafts it is handed and knows
 * nothing about stores, history or transports. Callers own the mutation
 * envelope (Mutative `create`, patch capture, collab translation).
 */

import { registry } from '@core/module-engine'
import { reindexNodeParents } from '@core/page-tree'
import type { ConditionDef, NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { NewStyleRule } from '@core/siteImport'
import {
  createStyleRuleOrderAllocator,
  indexStyleRulesByName,
  linkImportedClassNames,
  mergeImportedStyleRules,
} from './importLinking'

export interface InsertImportedFragmentOptions {
  /** Child position under the parent; appended when omitted. */
  index?: number
  /** Rules parsed from the fragment's `<style>` blocks. */
  styleRules?: readonly NewStyleRule[]
  /** Reusable conditions the style rules reference via `contextStyles` keys. */
  conditions?: readonly ConditionDef[]
}

/**
 * Graft `fragment` under `parentId`. Returns the inserted root ids, or `null`
 * when the parent is missing or does not accept children (nothing mutated).
 */
export function insertImportedFragment(
  tree: NodeTree<PageNode>,
  site: SiteDocument,
  parentId: string,
  fragment: ImportFragment,
  opts?: InsertImportedFragmentOptions,
): string[] | null {
  const parent = tree.nodes[parentId]
  if (!parent) return null
  const isRoot = tree.rootNodeId === parentId
  const definition = registry.get(parent.moduleId)
  const acceptsChildren = isRoot || definition?.canHaveChildren === true
  if (!acceptsChildren) return null

  // The HTML importer stamps class *names* onto each fragment node's
  // classIds (`walkAndMap` copies el.classList verbatim). The engine
  // keys classes by id and resolves styles by id, so link every imported
  // name to a real registry class — reusing an existing same-named class
  // or auto-creating a bare one — as the nodes enter the live tree.
  // Without this step the names never resolve and styles never apply.
  //
  // Nodes already carry fresh nanoid IDs from createNode — no collision
  // risk on the node map.
  const classesByName = indexStyleRulesByName(site.styleRules)
  const allocateStyleRuleOrder = createStyleRuleOrderAllocator(site.styleRules)

  // Commit rules parsed from <style> blocks BEFORE linking class names so
  // a node's `class="foo"` token binds to the just-added `.foo {}` rule
  // (rather than auto-creating a bare class). These show in the Selectors
  // panel like any other rule.
  if (opts?.styleRules?.length) {
    mergeImportedStyleRules(opts.styleRules, site.styleRules, classesByName, allocateStyleRuleOrder)
  }
  // Register any reusable conditions (custom @media / @container /
  // @supports) the <style> rules reference via contextStyles keys.
  if (opts?.conditions?.length) {
    if (!site.conditions) site.conditions = []
    const existing = new Set(site.conditions.map((c) => c.id))
    for (const def of opts.conditions) {
      if (existing.has(def.id)) continue
      existing.add(def.id)
      site.conditions.push(def)
    }
  }

  for (const [id, node] of Object.entries(fragment.nodes)) {
    // `node.inlineStyles` (imported inline `style="…"`) rides along on
    // the `...node` spread — it is a first-class node field.
    tree.nodes[id] = {
      ...node,
      classIds: linkImportedClassNames(
        node.classIds,
        site.styleRules,
        classesByName,
        allocateStyleRuleOrder,
      ),
    }
  }

  // Wire the imported root nodes as children of the target parent.
  const insertAt = opts?.index ?? parent.children.length
  parent.children.splice(insertAt, 0, ...fragment.rootIds)
  // The fragment was bulk-merged into tree.nodes (not via insertNode), so
  // derive the parentId index across the active tree to keep the inserted
  // subtree's pointers consistent. Deliberately O(active-tree), not a
  // targeted O(fragment) update: import is an infrequent path, and a full
  // reindex is the simplest bulletproof way to stay consistent.
  reindexNodeParents(tree.nodes)
  return [...fragment.rootIds]
}
