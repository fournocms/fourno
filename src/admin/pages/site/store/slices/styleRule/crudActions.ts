/**
 * styleRule slice — create + update of style rules and their per-context
 * style bags: createClass, createAmbientRule, updateClassStyles,
 * setClassContextStyles.
 */

import { nanoid } from 'nanoid'
import type { StyleRule } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import { assertValidCssClassName } from '@core/page-tree'
import {
  applyCssRules as applyCssRulesToSite,
  deleteCssRules as deleteCssRulesFromSite,
  removeCssRuleProperties as removeCssRulePropertiesFromSite,
  type ApplyCssRulesResult,
  type DeleteCssRulesResult,
  type RemoveCssRulePropertiesResult,
} from '@core/siteEdit'
import { isValidCssSelector } from '../../styleRuleRename'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { clearDeletedRuleSelection, nextRuleOrder, hasStylePatchChanges } from './helpers'

type CrudActions = Pick<
  StyleRuleSlice,
  | 'createClass'
  | 'createAmbientRule'
  | 'updateClassStyles'
  | 'setClassContextStyles'
  | 'applyCssRules'
  | 'deleteCssRules'
  | 'removeCssRuleProperties'
>

export function createCrudActions({ get, mutateSite, mutateSiteState }: SiteSliceHelpers): CrudActions {
  return {
    createClass(name, styles = {}) {
      const { site } = get()
      if (!site) throw new Error('[styleRuleSlice] Site document is not initialized')
      assertValidCssClassName(name)

      // Uniqueness check
      const existing = Object.values(site.styleRules).find((c) => c.name === name)
      if (existing) throw new Error(`[styleRuleSlice] A class named "${name}" already exists`)

      const now = Date.now()
      const newClass: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: nextRuleOrder(site.styleRules),
        styles,
        contextStyles: {},
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((site) => {
        site.styleRules[newClass.id] = newClass
        return true
      })

      return newClass
    },

    createAmbientRule(input) {
      const { site } = get()
      if (!site) throw new Error('[styleRuleSlice] Site document is not initialized')

      const selector = input.selector.trim()
      if (selector.length === 0) {
        throw new Error('[styleRuleSlice] Ambient selector cannot be empty')
      }
      if (!isValidCssSelector(selector)) {
        throw new Error(`[styleRuleSlice] Invalid CSS selector: ${selector}`)
      }

      // Default display name to the selector text. Unlike class-kind rules,
      // ambient rule names are not required to be globally unique — multiple
      // rules can share a selector (cascade resolves by `order`).
      const name = (input.name && input.name.trim().length > 0) ? input.name.trim() : selector

      const now = Date.now()
      const newRule: StyleRule = {
        id: nanoid(),
        name,
        kind: 'ambient',
        selector,
        order: nextRuleOrder(site.styleRules),
        styles: input.styles ?? {},
        contextStyles: input.contextStyles ?? {},
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((site) => {
        site.styleRules[newRule.id] = newRule
        return true
      })

      return newRule
    },

    updateClassStyles(classId, patch) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return
      if (!hasStylePatchChanges(cls.styles, patch)) return

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        Object.assign(draftClass.styles, patch)
        // Remove keys explicitly set to undefined/null (allow clearing a property)
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null) {
            delete draftClass.styles[k]
            delete draftClass.stylePriorities?.[k]
          }
        }
        if (draftClass.stylePriorities && Object.keys(draftClass.stylePriorities).length === 0) {
          delete draftClass.stylePriorities
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    setClassContextStyles(classId, contextId, patch) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return
      const currentStyles = cls.contextStyles[contextId] ?? {}
      if (!hasStylePatchChanges(currentStyles, patch)) return

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        if (!draftClass.contextStyles[contextId]) {
          draftClass.contextStyles[contextId] = {}
        }
        Object.assign(draftClass.contextStyles[contextId], patch)
        // Remove keys explicitly set to undefined/null
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null) {
            delete draftClass.contextStyles[contextId][k]
            delete draftClass.contextStylePriorities?.[contextId]?.[k]
          }
        }
        const contextPriorities = draftClass.contextStylePriorities?.[contextId]
        if (contextPriorities && Object.keys(contextPriorities).length === 0) {
          delete draftClass.contextStylePriorities?.[contextId]
        }
        if (
          draftClass.contextStylePriorities
          && Object.keys(draftClass.contextStylePriorities).length === 0
        ) {
          delete draftClass.contextStylePriorities
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    applyCssRules(rules, conditions, mode) {
      let result: ApplyCssRulesResult = { created: 0, updated: 0, blockedSelectors: [], changed: false }
      mutateSite((site) => {
        result = applyCssRulesToSite(site, rules, conditions, mode)
        return result.changed
      })
      return { created: result.created, updated: result.updated, blockedSelectors: result.blockedSelectors }
    },

    deleteCssRules(selectors) {
      let result: DeleteCssRulesResult = {
        deleted: 0,
        deletedRuleIds: new Set(),
        missingSelectors: [...selectors],
        blockedSelectors: [],
      }
      mutateSiteState((state, site) => {
        result = deleteCssRulesFromSite(site, selectors)
        if (result.deletedRuleIds.size === 0) return false
        clearDeletedRuleSelection(state, result.deletedRuleIds)
        return true
      })
      return {
        deleted: result.deleted,
        missingSelectors: result.missingSelectors,
        blockedSelectors: result.blockedSelectors,
      }
    },

    removeCssRuleProperties(selectors, properties) {
      let result: RemoveCssRulePropertiesResult = {
        updated: 0,
        removed: 0,
        missingSelectors: [...selectors],
        missingProperties: [...properties],
        blockedSelectors: [],
      }
      mutateSite((site) => {
        result = removeCssRulePropertiesFromSite(site, selectors, properties)
        return result.updated > 0
      })
      return result
    },
  }
}
