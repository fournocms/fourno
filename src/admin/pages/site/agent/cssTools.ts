import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type ApplyCssExecutionInput,
} from '@core/ai'
import type { ConditionDef } from '@core/page-tree'
import { describeCssRefusal, NO_CSS_RULES_PARSED_MESSAGE } from '@core/siteEdit'
import { cssToStyleRules, type NewStyleRule } from '@core/siteImport'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into `editor-store/store.ts`.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * Parse CSS harvested from agent-supplied HTML into registry rules. The live
 * site's viewport contexts let matching `@media` rules fold into the
 * corresponding context; unmatched conditions remain reusable site rules.
 */
export function parseImportedStyleCss(styleCss: string): {
  rules: NewStyleRule[]
  conditions: ConditionDef[]
} {
  if (!styleCss.trim()) return { rules: [], conditions: [] }
  const site = getStoreState().site
  const breakpoints = site
    ? site.breakpoints.map((breakpoint) => ({
        id: breakpoint.id,
        width: breakpoint.width,
        mediaQuery: breakpoint.mediaQuery,
      }))
    : []
  const { rules, conditions } = cssToStyleRules(styleCss, { breakpoints })
  return { rules, conditions }
}

/** Apply an exact-selector CSS mutation to the live site's style registry. */
export function runApplyCss(input: ApplyCssExecutionInput): AiToolOutput {
  if (input.operation === 'delete') {
    const result = getStoreState().deleteCssRules(input.selectors)
    const refusal = describeCssRefusal(result)
    return refusal ? aiToolError(refusal) : aiToolOk({ cssRulesDeleted: result.deleted })
  }

  if (input.operation === 'remove-properties') {
    const result = getStoreState().removeCssRuleProperties(input.selectors, input.properties)
    const refusal = describeCssRefusal(result)
    return refusal
      ? aiToolError(refusal)
      : aiToolOk({ cssRulesUpdated: result.updated, cssPropertiesRemoved: result.removed })
  }

  const { rules, conditions } = parseImportedStyleCss(input.css)
  if (rules.length === 0) return aiToolError(NO_CSS_RULES_PARSED_MESSAGE)
  const result = getStoreState().applyCssRules(rules, conditions, input.operation)
  const refusal = describeCssRefusal(result)
  if (refusal) return aiToolError(refusal)
  return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
}
