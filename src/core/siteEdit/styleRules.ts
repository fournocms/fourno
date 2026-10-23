/**
 * Style-rule recipes — exact-selector CSS edits and class assignment.
 *
 * Pure functions over a `SiteDocument` draft, shared by the editor store
 * (`styleRule` slice) and the server-side agent editor. Each one checks its
 * preconditions against the draft BEFORE touching it, so a refused call leaves
 * the document byte-for-byte unchanged.
 */
import { nanoid } from 'nanoid'
import type { BaseNode, ConditionDef, SiteDocument, StyleRule } from '@core/page-tree'
import { isGeneratedClassLocked, styleRuleSelector } from '@core/page-tree'
import { cssPropertyNameToStorageKey } from '@core/css-substitution'
import type { NewStyleRule } from '@core/siteImport'

type PriorityBag = Record<string, 'important'>

interface RulePayload {
  styles: Record<string, unknown>
  contextStyles: Record<string, Record<string, unknown>>
  stylePriorities?: PriorityBag
  contextStylePriorities?: Record<string, PriorityBag>
  rawCss?: string
}

function clonePriorityBag(priorities: PriorityBag | undefined): PriorityBag | undefined {
  if (!priorities || Object.keys(priorities).length === 0) return undefined
  return { ...priorities }
}

function cloneContextStyles(
  contexts: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(contexts ?? {}).map(([contextId, styles]) => [contextId, { ...styles }]),
  )
}

function cloneContextPriorities(
  contexts: Record<string, PriorityBag> | undefined,
): Record<string, PriorityBag> | undefined {
  if (!contexts) return undefined
  const cloned = Object.fromEntries(
    Object.entries(contexts)
      .filter(([, priorities]) => Object.keys(priorities).length > 0)
      .map(([contextId, priorities]) => [contextId, { ...priorities }]),
  )
  return Object.keys(cloned).length > 0 ? cloned : undefined
}

function payloadFromRule(rule: StyleRule | NewStyleRule): RulePayload {
  return {
    styles: { ...rule.styles },
    contextStyles: cloneContextStyles(rule.contextStyles),
    stylePriorities: clonePriorityBag(rule.stylePriorities),
    contextStylePriorities: cloneContextPriorities(rule.contextStylePriorities),
    ...(rule.rawCss !== undefined ? { rawCss: rule.rawCss } : {}),
  }
}

function orderedBagEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index]
    return rightEntry?.[0] === key && Object.is(rightEntry[1], value)
  })
}

function priorityBagEqual(left: PriorityBag | undefined, right: PriorityBag | undefined): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value]) => right?.[key] === value)
}

function contextStylesEqual(
  left: Record<string, Record<string, unknown>>,
  right: Record<string, Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => {
    const rightBag = right[contextId]
    return rightBag !== undefined && orderedBagEqual(left[contextId], rightBag)
  })
}

function contextPrioritiesEqual(
  left: Record<string, PriorityBag> | undefined,
  right: Record<string, PriorityBag> | undefined,
): boolean {
  const leftContexts = left ?? {}
  const rightContexts = right ?? {}
  const leftKeys = Object.keys(leftContexts)
  const rightKeys = Object.keys(rightContexts)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => priorityBagEqual(leftContexts[contextId], rightContexts[contextId]))
}

function payloadEqual(left: RulePayload, right: RulePayload): boolean {
  return orderedBagEqual(left.styles, right.styles)
    && contextStylesEqual(left.contextStyles, right.contextStyles)
    && priorityBagEqual(left.stylePriorities, right.stylePriorities)
    && contextPrioritiesEqual(left.contextStylePriorities, right.contextStylePriorities)
    && Object.is(left.rawCss, right.rawCss)
}

/**
 * Merge one declaration layer while moving every touched declaration to the
 * end in the incoming authored order. Object.assign keeps an existing key in
 * its old position, which can leave a longhand before a later shorthand and
 * make an apparently successful CSS repair lose in the emitted rule.
 */
function mergeLayer(
  current: Record<string, unknown>,
  currentPriorities: PriorityBag | undefined,
  patch: Record<string, unknown>,
  patchPriorities: PriorityBag | undefined,
  respectExistingImportant: boolean,
): { styles: Record<string, unknown>; priorities?: PriorityBag } {
  const acceptedPatchKeys = new Set<string>()
  for (const key of Object.keys(patch)) {
    if (
      respectExistingImportant
      && currentPriorities?.[key] === 'important'
      && patchPriorities?.[key] !== 'important'
    ) {
      continue
    }
    acceptedPatchKeys.add(key)
  }

  const styles: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(current)) {
    if (!acceptedPatchKeys.has(key)) styles[key] = value
  }
  for (const [key, value] of Object.entries(patch)) {
    if (acceptedPatchKeys.has(key)) styles[key] = value
  }

  const priorities: PriorityBag = {}
  for (const [key, priority] of Object.entries(currentPriorities ?? {})) {
    if (!acceptedPatchKeys.has(key)) priorities[key] = priority
  }
  for (const key of acceptedPatchKeys) {
    if (patchPriorities?.[key] === 'important') priorities[key] = 'important'
  }

  return {
    styles,
    ...(Object.keys(priorities).length > 0 ? { priorities } : {}),
  }
}

function mergePayload(
  current: RulePayload,
  patch: RulePayload,
  respectExistingImportant: boolean,
): RulePayload {
  const base = mergeLayer(
    current.styles,
    current.stylePriorities,
    patch.styles,
    patch.stylePriorities,
    respectExistingImportant,
  )
  const contextStyles = cloneContextStyles(current.contextStyles)
  const contextStylePriorities = cloneContextPriorities(current.contextStylePriorities) ?? {}

  for (const [contextId, patchStyles] of Object.entries(patch.contextStyles)) {
    const merged = mergeLayer(
      contextStyles[contextId] ?? {},
      contextStylePriorities[contextId],
      patchStyles,
      patch.contextStylePriorities?.[contextId],
      respectExistingImportant,
    )
    contextStyles[contextId] = merged.styles
    if (merged.priorities) contextStylePriorities[contextId] = merged.priorities
    else delete contextStylePriorities[contextId]
  }

  return {
    styles: base.styles,
    contextStyles,
    ...(base.priorities ? { stylePriorities: base.priorities } : {}),
    ...(Object.keys(contextStylePriorities).length > 0 ? { contextStylePriorities } : {}),
    ...(patch.rawCss !== undefined
      ? { rawCss: patch.rawCss }
      : current.rawCss !== undefined
        ? { rawCss: current.rawCss }
        : {}),
  }
}

function writePayload(target: StyleRule, payload: RulePayload): void {
  target.styles = payload.styles
  target.contextStyles = payload.contextStyles
  if (payload.stylePriorities) target.stylePriorities = payload.stylePriorities
  else delete target.stylePriorities
  if (payload.contextStylePriorities) {
    target.contextStylePriorities = payload.contextStylePriorities
  } else {
    delete target.contextStylePriorities
  }
  if (payload.rawCss !== undefined) target.rawCss = payload.rawCss
  else delete target.rawCss
}

interface ConsolidatedRule {
  selector: string
  source: NewStyleRule
  payload: RulePayload
}

function consolidateIncomingRules(rules: NewStyleRule[]): ConsolidatedRule[] {
  const bySelector = new Map<string, ConsolidatedRule>()
  for (const rule of rules) {
    const selector = styleRuleSelector(rule)
    const existing = bySelector.get(selector)
    if (!existing) {
      const item = { selector, source: rule, payload: payloadFromRule(rule) }
      bySelector.set(selector, item)
      continue
    }
    // Multiple authored blocks with the same selector collapse exactly as the
    // CSS cascade would: a prior important value beats a later normal one;
    // otherwise the later declaration wins and moves to the end.
    existing.payload = mergePayload(existing.payload, payloadFromRule(rule), true)
  }
  return [...bySelector.values()]
}

function rulesBySelector(rules: Record<string, StyleRule>): Map<string, StyleRule[]> {
  const index = new Map<string, StyleRule[]>()
  for (const rule of Object.values(rules)) {
    const selector = styleRuleSelector(rule)
    const matches = index.get(selector)
    if (matches) matches.push(rule)
    else index.set(selector, [rule])
  }
  return index
}

const SIDE_STORAGE_KEYS: Record<string, string[]> = {
  padding: ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
}

function storageKeysForProperty(property: string): string[] {
  const storageKey = cssPropertyNameToStorageKey(property)
  return SIDE_STORAGE_KEYS[storageKey] ?? [storageKey]
}

function ruleHasAnyProperty(rule: StyleRule, keys: readonly string[]): boolean {
  if (keys.some((key) => key in rule.styles)) return true
  return Object.values(rule.contextStyles).some((styles) => keys.some((key) => key in styles))
}

function deletePriorityKeys(priorities: PriorityBag | undefined, keys: readonly string[]): void {
  if (!priorities) return
  for (const key of keys) delete priorities[key]
}

export interface ApplyCssRulesResult {
  created: number
  updated: number
  /** Framework-generated selectors the call tried to overwrite; nothing was written. */
  blockedSelectors: string[]
  /** True when the document changed — a new reusable condition counts even with no rule change. */
  changed: boolean
}

/**
 * Merge or replace parsed CSS rules into the registry by exact selector.
 * Selectors that already exist are updated in place (every rule sharing the
 * selector); new ones are appended at the end of the cascade.
 */
export function applyCssRules(
  site: SiteDocument,
  rules: NewStyleRule[],
  conditions: ConditionDef[],
  mode: 'merge' | 'replace',
): ApplyCssRulesResult {
  const incoming = consolidateIncomingRules(rules)
  const targetBySelector = rulesBySelector(site.styleRules)
  const blockedSelectors = incoming
    .filter(({ selector }) => (targetBySelector.get(selector) ?? []).some(isGeneratedClassLocked))
    .map(({ selector }) => selector)
  if (blockedSelectors.length > 0) return { created: 0, updated: 0, blockedSelectors, changed: false }

  let changed = false
  // Register referenced reusable conditions before their context bags.
  if (conditions.length > 0) {
    if (!site.conditions) site.conditions = []
    const known = new Set(site.conditions.map((condition) => condition.id))
    for (const definition of conditions) {
      if (known.has(definition.id)) continue
      known.add(definition.id)
      site.conditions.push(definition)
      changed = true
    }
  }

  let maxOrder = -1
  for (const rule of Object.values(site.styleRules)) {
    if (typeof rule.order === 'number' && rule.order > maxOrder) maxOrder = rule.order
  }

  let created = 0
  let updated = 0
  const now = Date.now()
  for (const item of incoming) {
    const targets = targetBySelector.get(item.selector) ?? []
    if (targets.length > 0) {
      for (const target of targets) {
        const current = payloadFromRule(target)
        const next = mode === 'replace' ? item.payload : mergePayload(current, item.payload, false)
        if (payloadEqual(current, next)) continue
        writePayload(target, next)
        target.updatedAt = now
        updated++
        changed = true
      }
      continue
    }

    const id = nanoid()
    const newRule: StyleRule = {
      ...item.source,
      ...item.payload,
      id,
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    site.styleRules[id] = newRule
    targetBySelector.set(item.selector, [newRule])
    created++
    changed = true
  }

  return { created, updated, blockedSelectors: [], changed }
}

/**
 * Remove style rules from the registry and every node that referenced them —
 * pages AND Visual Component trees, because class ids are global and a
 * dangling reference would survive in whichever surface was skipped.
 * Missing and framework-locked ids are ignored. Returns the ids deleted.
 */
export function deleteStyleRules(site: SiteDocument, ruleIds: readonly string[]): Set<string> {
  const targets = new Set(
    ruleIds.filter((id) => {
      const rule = site.styleRules[id]
      return rule && !isGeneratedClassLocked(rule)
    }),
  )
  if (targets.size === 0) return targets

  const trees = [
    ...site.pages.map((page) => page.nodes),
    ...site.visualComponents.map((component) => component.tree.nodes),
  ]
  for (const ruleId of targets) {
    delete site.styleRules[ruleId]
    for (const nodes of trees) {
      for (const node of Object.values(nodes)) {
        if (node.classIds?.includes(ruleId)) {
          node.classIds = node.classIds.filter((id) => id !== ruleId)
        }
      }
    }
  }
  return targets
}

export interface DeleteCssRulesResult {
  deleted: number
  /** Ids of the rules that were removed (empty when the call was refused). */
  deletedRuleIds: ReadonlySet<string>
  missingSelectors: string[]
  blockedSelectors: string[]
}

/** Delete every rule matching each exact selector; refuses wholesale on any miss or lock. */
export function deleteCssRules(site: SiteDocument, selectors: readonly string[]): DeleteCssRulesResult {
  const requested = [...new Set(selectors.map((selector) => selector.trim()))]
  const existingBySelector = rulesBySelector(site.styleRules)
  const missingSelectors = requested.filter(
    (selector) => (existingBySelector.get(selector) ?? []).length === 0,
  )
  const blockedSelectors = requested.filter((selector) =>
    (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked),
  )
  if (missingSelectors.length > 0 || blockedSelectors.length > 0) {
    return { deleted: 0, deletedRuleIds: new Set(), missingSelectors, blockedSelectors }
  }

  const ids = requested.flatMap((selector) =>
    (existingBySelector.get(selector) ?? []).map((rule) => rule.id),
  )
  const deletedRuleIds = deleteStyleRules(site, ids)
  return { deleted: ids.length, deletedRuleIds, missingSelectors: [], blockedSelectors: [] }
}

export interface RemoveCssRulePropertiesResult {
  updated: number
  removed: number
  missingSelectors: string[]
  missingProperties: string[]
  blockedSelectors: string[]
}

/** Strip the named properties from every rule matching each exact selector. */
export function removeCssRuleProperties(
  site: SiteDocument,
  selectors: readonly string[],
  properties: readonly string[],
): RemoveCssRulePropertiesResult {
  const requestedSelectors = [...new Set(selectors.map((selector) => selector.trim()))]
  const requestedProperties = [...new Set(properties.map((property) => property.trim()))]
  const existingBySelector = rulesBySelector(site.styleRules)
  const missingSelectors = requestedSelectors.filter(
    (selector) => (existingBySelector.get(selector) ?? []).length === 0,
  )
  const blockedSelectors = requestedSelectors.filter((selector) =>
    (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked),
  )
  const targets = requestedSelectors.flatMap((selector) => existingBySelector.get(selector) ?? [])
  const propertyKeys = new Map(
    requestedProperties.map((property) => [property, storageKeysForProperty(property)]),
  )
  const missingProperties = requestedProperties.filter(
    (property) => !targets.some((rule) => ruleHasAnyProperty(rule, propertyKeys.get(property) ?? [])),
  )

  if (missingSelectors.length > 0 || blockedSelectors.length > 0 || missingProperties.length > 0) {
    return { updated: 0, removed: 0, missingSelectors, missingProperties, blockedSelectors }
  }

  const keys = [...new Set([...propertyKeys.values()].flat())]
  let updated = 0
  let removed = 0
  const now = Date.now()
  for (const rule of targets) {
    let ruleChanged = false
    for (const key of keys) {
      if (key in rule.styles) {
        delete rule.styles[key]
        removed++
        ruleChanged = true
      }
      for (const contextStyles of Object.values(rule.contextStyles)) {
        if (key in contextStyles) {
          delete contextStyles[key]
          removed++
          ruleChanged = true
        }
      }
    }
    deletePriorityKeys(rule.stylePriorities, keys)
    if (rule.stylePriorities && Object.keys(rule.stylePriorities).length === 0) {
      delete rule.stylePriorities
    }
    for (const priorities of Object.values(rule.contextStylePriorities ?? {})) {
      deletePriorityKeys(priorities, keys)
    }
    if (rule.contextStylePriorities) {
      for (const [contextId, priorities] of Object.entries(rule.contextStylePriorities)) {
        if (Object.keys(priorities).length === 0) delete rule.contextStylePriorities[contextId]
      }
      if (Object.keys(rule.contextStylePriorities).length === 0) delete rule.contextStylePriorities
    }
    if (!ruleChanged) continue
    rule.updatedAt = now
    updated++
  }

  return { updated, removed, missingSelectors: [], missingProperties: [], blockedSelectors: [] }
}

/**
 * Resolve a rule reference that is either a real id (checked first) or a class
 * name. An ambiguous name resolves to null; uniqueness is enforced when a class
 * is created, so this is defence in depth.
 */
export function resolveClassId(site: SiteDocument, classIdOrName: string): string | null {
  if (site.styleRules[classIdOrName]) return classIdOrName
  const matches = Object.values(site.styleRules).filter((rule) => rule.name === classIdOrName)
  if (matches.length > 1) return null
  return matches[0]?.id ?? null
}

/** Find a node by id in any page or Visual Component tree. */
export function findNodeInSite(site: SiteDocument, nodeId: string): BaseNode | null {
  for (const page of site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }
  for (const component of site.visualComponents) {
    const node = component.tree.nodes[nodeId]
    if (node) return node
  }
  return null
}

/**
 * Add or remove one class on a node's `classIds`. `node.classIds` only ever
 * holds class-kind rule ids — ambient rules attach by selector matching, so
 * assigning one would leak a never-matching token into `class=`. Returns
 * whether the document changed.
 */
export function setNodeClassAssigned(
  site: SiteDocument,
  nodeId: string,
  classId: string,
  assigned: boolean,
): boolean {
  const rule = site.styleRules[classId]
  if (assigned && rule && rule.kind && rule.kind !== 'class') {
    console.error('[siteEdit] class assignment refused: classId references an ambient rule', {
      nodeId,
      classId,
      selector: rule.selector,
    })
    return false
  }
  const node = findNodeInSite(site, nodeId)
  if (!node) return false
  if (assigned) {
    if (node.classIds?.includes(classId)) return false
    if (!node.classIds) node.classIds = []
    node.classIds.push(classId)
    return true
  }
  const index = node.classIds?.indexOf(classId) ?? -1
  if (!node.classIds || index === -1) return false
  node.classIds.splice(index, 1)
  return true
}

/**
 * The refusal sentence for a selector-addressed CSS call that could not apply,
 * or null when the call went through. Shared by the editor tool executor and
 * the server-side tools so an agent reads the same words either way.
 */
export function describeCssRefusal(result: {
  missingSelectors?: readonly string[]
  blockedSelectors?: readonly string[]
  missingProperties?: readonly string[]
}): string | null {
  if (result.missingSelectors?.length) {
    return `CSS selectors not found: ${result.missingSelectors.join(', ')}`
  }
  if (result.blockedSelectors?.length) {
    return `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`
  }
  if (result.missingProperties?.length) {
    return `CSS properties are not set on the requested selectors: ${result.missingProperties.join(', ')}`
  }
  return null
}

/** Shown when an `apply` call carried CSS that yielded no rules. */
export const NO_CSS_RULES_PARSED_MESSAGE =
  'No CSS rules parsed. Provide CSS like ".hero { color: var(--primary) }" or ' +
  '"nav a:hover { text-decoration: underline }".'
