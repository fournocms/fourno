/**
 * Server-side page-editing tools for MCP — PRD §8.6, SECURITY §5.5.
 *
 * Each tool here shadows a browser-bridged site tool of the same name (the MCP
 * registry lists these first, so they win the name de-dup). The advertised
 * schema, description and capability requirements are INHERITED from the
 * browser tool — only the execution changes: instead of relaying to the
 * connector owner's open Site workspace, the tool edits the collab Y documents
 * directly through the server site editor. No editor needs to be open; one
 * that is open sees the edit live; the Yjs document remains the only truth.
 *
 * Every edit goes through `SiteEditor.edit`, which runs the same pure recipes
 * the editor store uses (`@core/siteEdit`, `@core/page-tree`), translates them
 * with the editor's own Y write path, and checks the connection's capabilities
 * with the update guard partial-capability sockets get. Richtext props are
 * sanitised exactly as in the editor executor.
 *
 * Design tokens live in `siteTokenTools.ts`. Not yet headless (still relayed to an open editor): font
 * tokens (install runs over HTTP), code assets, `site_open_document`, `site_render_snapshot`.
 */
import { aiToolError, aiToolOk, describeAgentDocuments, documentRefEquals, documentRefForPage, renderAgentDocument } from '@core/ai'
import { ApplyCssExecutionInputSchema } from '@core/ai'
import type {
  AgentDocumentRef,
  ApplyCssInput,
  AssignClassInput,
  RemoveClassInput,
  AiToolOutput,
  DeleteNodeInput,
  DeletePageInput,
  DuplicateNodeInput,
  DuplicatePageInput,
  GetNodeHtmlInput,
  InsertHtmlInput,
  MoveNodeInput,
  ReadDocumentInput,
  RenameNodeInput,
  RenamePageInput,
  ReplaceNodeHtmlInput,
  SetPageTemplateInput,
  ClearPageTemplateInput,
  UpdateNodePropsInput,
  AddPageInput,
} from '@core/ai'
import { parseValue } from '@core/utils/typeboxHelpers'
import { registry } from '@core/module-engine'
import { importHtml } from '@core/htmlImport'
import { cssToStyleRules } from '@core/siteImport'
import { isRichtextPropKey, sanitizeRichtext } from '@core/sanitize'
import {
  addPage,
  deleteNode,
  deletePage,
  duplicatePage,
  moveNode,
  reconcileSiteExplorerInPlace,
  renameNode,
  renamePage,
  setBreakpointOverride,
  updateNodeProps,
  type Page,
  type SiteDocument,
} from '@core/page-tree'
import { renderNode, type RenderAccumulators, type RenderConfig } from '@core/publisher'
import {
  applyCssRules,
  deleteCssRules,
  describeCssRefusal,
  duplicateNodeWithScopedClasses,
  editDocumentTree,
  findNodeDocument,
  findNodeInSite,
  insertImportedFragment,
  NO_CSS_RULES_PARSED_MESSAGE,
  removeCssRuleProperties,
  resolveClassId,
  setNodeClassAssigned,
} from '@core/siteEdit'
import { subtreeHasOutlet } from '@core/templates'
import { flattenVCToVirtualPage } from '@core/visualComponents'
import type { AiTool, ToolContext } from '../../runtime/types'
import { editAsCaller, readAsCaller, refuse, serverBacked } from './siteEditPlumbing'

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** A page/component id passed where a node id belongs gets a pointed hint. */
function nodeNotFound(site: SiteDocument, id: string): never {
  const page = site.pages.find((candidate) => candidate.id === id)
  if (page) {
    const ref = documentRefForPage(page)
    refuse(
      `ID ${id} is a ${ref.type} document id, not a node id. Call site_read_document({ document: { type: "${ref.type}", id: "${id}" } }) and use a returned uid.`,
    )
  }
  if (site.visualComponents.some((component) => component.id === id)) {
    refuse(
      `ID ${id} is a visualComponent document id, not a node id. Call site_read_document({ document: { type: "visualComponent", id: "${id}" } }) and use a returned uid.`,
    )
  }
  refuse(`Node not found: ${id}`)
}

function requireNodeDocument(site: SiteDocument, nodeId: string) {
  return findNodeDocument(site, nodeId) ?? nodeNotFound(site, nodeId)
}

const PAGE_NOT_FOUND = (pageId: string): string => `Page not found: ${pageId}`

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function insertHtml(input: InsertHtmlInput, ctx: ToolContext): Promise<AiToolOutput> {
  const { nodes, rootIds, styleCss, stripped, warnings } = importHtml(input.html)
  return editAsCaller(
    'site_insert_html',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.parentId)
      const { rules, conditions } = styleCss.trim()
        ? cssToStyleRules(styleCss, {
            breakpoints: site.breakpoints.map(({ id, width, mediaQuery }) => ({ id, width, mediaQuery })),
          })
        : { rules: [], conditions: [] }
      if (rootIds.length === 0) return refuseEmptyImport(stripped, rules.length + conditions.length)

      const insertedRootIds = editDocumentTree(site, target, (tree) =>
        insertImportedFragment(tree, site, input.parentId, { nodes, rootIds }, {
          index: input.index,
          styleRules: rules,
          conditions,
        }),
      )
      if (!insertedRootIds) refuse(`Parent node not found or does not accept children: ${input.parentId}`)
      return { insertedRootIds, created: describeCreated(site, target.tree.nodes, insertedRootIds), warnings }
    },
    ({ insertedRootIds, created, warnings: importWarnings }) => ({
      nodeIds: insertedRootIds,
      created,
      ...(importWarnings.length > 0 ? { warnings: importWarnings.map((w) => w.message) } : {}),
    }),
  )
}

function replaceNodeHtml(input: ReplaceNodeHtmlInput, ctx: ToolContext): Promise<AiToolOutput> {
  // Parse + validate BEFORE mutating, so an empty payload never wipes the
  // node's children first and then errors out.
  const { nodes, rootIds, styleCss, stripped, warnings } = importHtml(input.html)
  return editAsCaller(
    'site_replace_node_html',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      const { rules, conditions } = styleCss.trim()
        ? cssToStyleRules(styleCss, {
            breakpoints: site.breakpoints.map(({ id, width, mediaQuery }) => ({ id, width, mediaQuery })),
          })
        : { rules: [], conditions: [] }
      if (rootIds.length === 0) return refuseEmptyImport(stripped, rules.length + conditions.length)

      const insertedRootIds = editDocumentTree(site, target, (tree) => {
        const targetNode = tree.nodes[input.nodeId]!
        for (const childId of [...targetNode.children]) deleteNode(tree, childId)
        return insertImportedFragment(tree, site, input.nodeId, { nodes, rootIds }, {
          styleRules: rules,
          conditions,
        })
      })
      if (!insertedRootIds) refuse(`Node does not accept children: ${input.nodeId}`)
      return { insertedRootIds, warnings }
    },
    ({ insertedRootIds, warnings: importWarnings }) => ({
      nodeIds: insertedRootIds,
      ...(importWarnings.length > 0 ? { warnings: importWarnings.map((w) => w.message) } : {}),
    }),
  )
}

/** Headless CSS authoring is not available yet, so a payload with no elements has nothing to do. */
function refuseEmptyImport(stripped: { scripts: number; inlineHandlers: number }, cssRuleCount: number): never {
  if (cssRuleCount > 0) {
    refuse(
      'HTML contained only <style> rules. Authoring CSS without elements is not available without an open editor yet — include the elements the rules style.',
    )
  }
  const scriptHint = stripped.scripts > 0 || stripped.inlineHandlers > 0
    ? ' Scripts and inline event handlers are stripped from HTML imports; create runtime behavior with site_write_code_asset({ type:"script", ... }) instead.'
    : ''
  refuse(`HTML contained no importable elements or style rules.${scriptHint}`)
}

function describeCreated(
  site: SiteDocument,
  nodes: Record<string, { moduleId: string; classIds?: string[]; children: string[] }>,
  rootIds: readonly string[],
): Array<{ id: string; moduleId: string; classes: string[] }> {
  const created: Array<{ id: string; moduleId: string; classes: string[] }> = []
  const visit = (id: string): void => {
    const node = nodes[id]
    if (!node) return
    created.push({
      id,
      moduleId: node.moduleId,
      classes: (node.classIds ?? []).map((classId) => site.styleRules[classId]?.name ?? classId),
    })
    for (const childId of node.children) visit(childId)
  }
  for (const rootId of rootIds) visit(rootId)
  return created
}

function deleteNodeTool(input: DeleteNodeInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_delete_node',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      editDocumentTree(site, target, (tree) => {
        if (input.nodeId === tree.rootNodeId) refuse('The document root cannot be deleted.')
        deleteNode(tree, input.nodeId)
      })
      return {}
    },
    () => ({}),
  )
}

function updateNodePropsTool(input: UpdateNodePropsInput, ctx: ToolContext): Promise<AiToolOutput> {
  const sanitizedPatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.patch)) {
    sanitizedPatch[key] = isRichtextPropKey(key) && typeof value === 'string' ? sanitizeRichtext(value) : value
  }
  return editAsCaller(
    'site_update_node_props',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      const { breakpointId } = input
      if (breakpointId) {
        if (!site.breakpoints.some((breakpoint) => breakpoint.id === breakpointId)) {
          refuse(`Breakpoint not found: ${breakpointId}`)
        }
        // Per-breakpoint writes are restricted to props the module schema marks
        // `breakpointOverridable: true`; content props are single-value across
        // breakpoints because the published page is one HTML document.
        const node = target.tree.nodes[input.nodeId]!
        const definition = registry.get(node.moduleId)
        if (!definition) refuse(`Unknown module on node: ${node.moduleId}`)
        const nonOverridable = Object.keys(sanitizedPatch).filter(
          (key) => definition.schema[key]?.breakpointOverridable !== true,
        )
        if (nonOverridable.length > 0) {
          refuse(
            `Cannot store breakpoint overrides for non-responsive prop(s) on ${node.moduleId}: ` +
              `${nonOverridable.join(', ')}. ` +
              `Module props are content (single value across breakpoints) unless the schema marks them ` +
              `\`breakpointOverridable: true\`. For per-breakpoint *visual* variation use site_apply_css with an ` +
              `\`@media\` query instead.`,
          )
        }
      }
      editDocumentTree(site, target, (tree) => {
        if (breakpointId) setBreakpointOverride(tree, input.nodeId, breakpointId, sanitizedPatch)
        else updateNodeProps(tree, input.nodeId, sanitizedPatch)
      })
      return {}
    },
    () => ({}),
  )
}

function moveNodeTool(input: MoveNodeInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_move_node',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      editDocumentTree(site, target, (tree) => {
        if (!tree.nodes[input.newParentId]) {
          refuse(`Parent ${input.newParentId} is not in the same document as ${input.nodeId}.`)
        }
        moveNode(tree, input.nodeId, input.newParentId, input.newIndex)
      })
      return {}
    },
    () => ({}),
  )
}

function renameNodeTool(input: RenameNodeInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_rename_node',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      editDocumentTree(site, target, (tree) => renameNode(tree, input.nodeId, input.label))
      return {}
    },
    () => ({}),
  )
}

function duplicateNodeTool(input: DuplicateNodeInput, ctx: ToolContext): Promise<AiToolOutput> {
  const count = input.count ?? 1
  return editAsCaller(
    'site_duplicate_node',
    ctx,
    (site) => {
      const target = requireNodeDocument(site, input.nodeId)
      const newIds: string[] = []
      editDocumentTree(site, target, (tree) => {
        if (input.nodeId === tree.rootNodeId) refuse('The document root cannot be duplicated.')
        // One-outlet-per-document invariant: the source subtree holds the outlet.
        if (subtreeHasOutlet(tree.nodes, input.nodeId)) {
          refuse('Duplicating this would create a second content outlet — a document can hold just one.')
        }
        // Chain — clone the latest, not the source — so the resulting order is
        // [source, clone1, clone2, …, cloneN] rather than reverse-stacked.
        let lastId = input.nodeId
        for (let i = 0; i < count; i++) {
          const newId = duplicateNodeWithScopedClasses(tree, site, lastId)
          if (!newId) refuse(`Could not duplicate node: ${input.nodeId}`)
          newIds.push(newId)
          lastId = newId
        }
      })
      return newIds
    },
    (newIds) => ({ nodeId: newIds[0], nodeIds: newIds }),
  )
}

function addPageTool(input: AddPageInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_add_page',
    ctx,
    (site) => {
      const page: Page = addPage(site, input.title, input.slug ?? input.title)
      reconcileSiteExplorerInPlace(site)
      // The page's rootNodeId is the parent to pass to site_insert_html — a pageId is NOT a node id.
      return { pageId: page.id, rootNodeId: page.rootNodeId }
    },
    (created) => created,
  )
}

function deletePageTool(input: DeletePageInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_delete_page',
    ctx,
    (site) => {
      if (!site.pages.some((page) => page.id === input.pageId)) refuse(PAGE_NOT_FOUND(input.pageId))
      if (site.pages.length <= 1) refuse('Cannot delete the last page in a site.')
      deletePage(site, input.pageId)
      reconcileSiteExplorerInPlace(site)
      return {}
    },
    () => ({}),
  )
}

function renamePageTool(input: RenamePageInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_rename_page',
    ctx,
    (site) => {
      if (!site.pages.some((page) => page.id === input.pageId)) refuse(PAGE_NOT_FOUND(input.pageId))
      renamePage(site, input.pageId, input.title, input.slug)
      return {}
    },
    () => ({}),
  )
}

function duplicatePageTool(input: DuplicatePageInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_duplicate_page',
    ctx,
    (site) => {
      if (!site.pages.some((page) => page.id === input.pageId)) refuse(PAGE_NOT_FOUND(input.pageId))
      const copy = duplicatePage(site, input.pageId, input.title, input.slug)
      reconcileSiteExplorerInPlace(site)
      return { pageId: copy.id }
    },
    (created) => created,
  )
}

function setPageTemplateTool(input: SetPageTemplateInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_set_page_template',
    ctx,
    (site) => {
      const page = site.pages.find((candidate) => candidate.id === input.pageId)
      if (!page) refuse(PAGE_NOT_FOUND(input.pageId))
      page.template = { enabled: true, target: input.target, priority: input.priority ?? 100 }
      reconcileSiteExplorerInPlace(site)
      return {}
    },
    () => ({}),
  )
}

function clearPageTemplateTool(input: ClearPageTemplateInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_clear_page_template',
    ctx,
    (site) => {
      const page = site.pages.find((candidate) => candidate.id === input.pageId)
      if (!page) refuse(PAGE_NOT_FOUND(input.pageId))
      if (!page.template) refuse(`Page is not a template: ${input.pageId}`)
      delete page.template
      for (const node of Object.values(page.nodes)) delete node.dynamicBindings
      reconcileSiteExplorerInPlace(site)
      return {}
    },
    () => ({}),
  )
}

async function readDocument(input: ReadDocumentInput, ctx: ToolContext): Promise<AiToolOutput> {
  if (!input.document) {
    return aiToolError('Pass a document ref from site_list_documents: there is no current document without an open editor.')
  }
  const requested: AgentDocumentRef = input.document
  return readAsCaller(ctx, (site) => {
    const descriptors = describeAgentDocuments(site, null, null)
    const page =
      requested.type === 'visualComponent'
        ? (() => {
            const component = site.visualComponents.find((candidate) => candidate.id === requested.id)
            return component ? flattenVCToVirtualPage(component) : null
          })()
        : site.pages.find((candidate) => candidate.id === requested.id) ?? null
    if (!page) {
      return aiToolError('Document not found. Call site_list_documents and pass one of its document refs.')
    }
    const actualRef: AgentDocumentRef =
      requested.type === 'visualComponent' ? requested : documentRefForPage(page)
    const descriptor = descriptors.find((item) => documentRefEquals(item.document, actualRef))
    if (!descriptor) {
      return aiToolError('Document not found. Call site_list_documents and pass one of its document refs.')
    }
    const rendered = renderAgentDocument(page, site, registry, { part: input.part })
    return aiToolOk({
      document: descriptor.document,
      title: descriptor.title,
      html: rendered.html,
      css: rendered.css,
      pageInfo: rendered.pageInfo,
    })
  })
}

async function getNodeHtml(input: GetNodeHtmlInput, ctx: ToolContext): Promise<AiToolOutput> {
  return readAsCaller(ctx, (site) => {
    const owner = findNodeDocument(site, input.nodeId)
    if (!owner) return aiToolError(`Node not found: ${input.nodeId}`)
    // Visual components are materialized as virtual pages so this tool and
    // site_read_document share publisher semantics.
    const page = owner.vc ? flattenVCToVirtualPage(owner.vc) : site.pages.find((p) => p.id === owner.documentId)!
    const config: RenderConfig = {
      page,
      site,
      registry,
      breakpointId: undefined,
      annotateNodeIds: true,
    }
    const acc: RenderAccumulators = {
      cssMap: new Map(),
      jsMap: new Map(),
      infiniteLoopIds: new Set(),
      holeNodeIds: new Set(),
      cspSources: new Map(),
    }
    return aiToolOk({ html: renderNode(input.nodeId, config, acc) })
  })
}

function applyCssTool(providerInput: ApplyCssInput, ctx: ToolContext): Promise<AiToolOutput> {
  const input = parseValue(ApplyCssExecutionInputSchema, providerInput)
  // Parse before editing so malformed CSS never opens a write.
  const parsed =
    input.operation === 'delete' || input.operation === 'remove-properties' ? null : input.css
  return editAsCaller(
    'site_apply_css',
    ctx,
    (site) => {
      if (input.operation === 'delete') {
        const result = deleteCssRules(site, input.selectors)
        const refusal = describeCssRefusal(result)
        if (refusal) refuse(refusal)
        return { cssRulesDeleted: result.deleted }
      }
      if (input.operation === 'remove-properties') {
        const result = removeCssRuleProperties(site, input.selectors, input.properties)
        const refusal = describeCssRefusal(result)
        if (refusal) refuse(refusal)
        return { cssRulesUpdated: result.updated, cssPropertiesRemoved: result.removed }
      }
      const { rules, conditions } = parsed?.trim()
        ? cssToStyleRules(parsed, {
            breakpoints: site.breakpoints.map(({ id, width, mediaQuery }) => ({ id, width, mediaQuery })),
          })
        : { rules: [], conditions: [] }
      if (rules.length === 0) refuse(NO_CSS_RULES_PARSED_MESSAGE)
      const result = applyCssRules(site, rules, conditions, input.operation)
      const refusal = describeCssRefusal(result)
      if (refusal) refuse(refusal)
      return { cssRulesCreated: result.created, cssRulesUpdated: result.updated }
    },
    (counts) => counts,
  )
}

function assignClassTool(input: AssignClassInput, ctx: ToolContext): Promise<AiToolOutput> {
  return setClassAssignment('site_assign_class', input, true, ctx)
}

function removeClassTool(input: RemoveClassInput, ctx: ToolContext): Promise<AiToolOutput> {
  return setClassAssignment('site_remove_class', input, false, ctx)
}

function setClassAssignment(
  toolName: string,
  input: AssignClassInput | RemoveClassInput,
  assigned: boolean,
  ctx: ToolContext,
): Promise<AiToolOutput> {
  return editAsCaller(
    toolName,
    ctx,
    (site) => {
      const classId = resolveClassId(site, input.classId)
      if (!classId) refuse(`Class not found: ${input.classId}`)
      if (!findNodeInSite(site, input.nodeId)) nodeNotFound(site, input.nodeId)
      const rule = site.styleRules[classId]
      if (assigned && rule.kind && rule.kind !== 'class') {
        refuse(
          `"${rule.name}" is an ambient rule (${rule.selector}) and attaches by selector. ` +
            'Only classes can be assigned to a node.',
        )
      }
      setNodeClassAssigned(site, input.nodeId, classId, assigned)
      return {}
    },
    () => ({}),
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const siteEditMcpTools: AiTool[] = [
  serverBacked('site_read_document', readDocument),
  serverBacked('site_get_node_html', getNodeHtml),
  serverBacked('site_insert_html', insertHtml),
  serverBacked('site_replace_node_html', replaceNodeHtml),
  serverBacked('site_delete_node', deleteNodeTool),
  serverBacked('site_update_node_props', updateNodePropsTool),
  serverBacked('site_move_node', moveNodeTool),
  serverBacked('site_rename_node', renameNodeTool),
  serverBacked('site_duplicate_node', duplicateNodeTool),
  serverBacked('site_add_page', addPageTool),
  serverBacked('site_delete_page', deletePageTool),
  serverBacked('site_rename_page', renamePageTool),
  serverBacked('site_duplicate_page', duplicatePageTool),
  serverBacked('site_set_page_template', setPageTemplateTool),
  serverBacked('site_clear_page_template', clearPageTemplateTool),
  serverBacked('site_apply_css', applyCssTool),
  serverBacked('site_assign_class', assignClassTool),
  serverBacked('site_remove_class', removeClassTool),
]
