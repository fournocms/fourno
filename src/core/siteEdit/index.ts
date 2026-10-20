/**
 * @core/siteEdit — pure site-mutation recipes shared by the editor store and
 * the server-side agent edit path.
 *
 * A recipe mutates the Mutative drafts it is handed (`tree`, `site`) and
 * nothing else: no store, no history, no transport. The editor wraps recipes
 * in its undoable mutation envelope; the server wraps them in a collab write
 * (`server/collab/siteEditor.ts`). One implementation, two envelopes — an
 * edit never means something different depending on who made it.
 */
export { insertImportedFragment, type InsertImportedFragmentOptions } from './insertImportedFragment'
export {
  createStyleRuleOrderAllocator,
  findReimportedStyleRule,
  indexStyleRulesByName,
  indexStyleRulesByOrigin,
  linkImportedClassNames,
  mergeImportedStyleRules,
  registerStyleRuleOrigin,
  type StyleRuleOrderAllocator,
} from './importLinking'
export { duplicateNodeWithScopedClasses } from './duplicateNode'
export {
  editDocumentTree,
  findDocumentTree,
  findNodeDocument,
  type DocumentTreeTarget,
} from './documentTree'
export { allTreeNodeMaps, syncAllVCRefSlotInstances } from './slotReconcile'
export {
  applyCssRules,
  deleteCssRules,
  deleteStyleRules,
  describeCssRefusal,
  NO_CSS_RULES_PARSED_MESSAGE,
  findNodeInSite,
  removeCssRuleProperties,
  resolveClassId,
  setNodeClassAssigned,
  type ApplyCssRulesResult,
  type DeleteCssRulesResult,
  type RemoveCssRulePropertiesResult,
} from './styleRules'
export { reconcileFrameworkClasses } from './frameworkReconcile'
export {
  upsertFrameworkColorTokens,
  applyFrameworkColorTokenPatch,
  cloneFrameworkColorToken,
  createFrameworkColorTokenFromInput,
  ensureFrameworkColors,
  reorderFrameworkColorTokenInGroup,
  type ColorVariantOptions,
  type CreateFrameworkColorTokenInput,
  type UpdateFrameworkColorTokenPatch,
  type UpsertedColorToken,
} from './frameworkColors'
export {
  applyScaleGroupPatch,
  ensureScaleSettings,
  generatedScaleVars,
  readScaleGroups,
  readScaleSettings,
  SCALE_FAMILY_FACTORIES,
  scalePatchFromToolInput,
  setScaleGroup,
  type CommonScaleGroupPatch,
  type ScaleFamily,
  type ScaleFamilyTypes,
  type SetScaleGroupRequest,
  type SetScaleGroupResult,
  type UpdateFrameworkSpacingGroupPatch,
  type UpdateFrameworkTypographyGroupPatch,
} from './frameworkScales'
export { nextOrderValue } from './order'
