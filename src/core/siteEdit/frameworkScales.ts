/**
 * Framework scale-group recipes — the two parallel "fluid scale" families
 * (typography and spacing) as pure mutations over a SiteDocument draft.
 *
 * The editor store's scale actions and the server-side `site_set_type_scale` /
 * `site_set_spacing_scale` tools both run these. Family differences (group
 * type, default group, tab naming) are looked up from `SCALE_FAMILY_FACTORIES`
 * by a `'typography' | 'spacing'` discriminator.
 */

import type { SiteDocument } from '@core/page-tree'
import type {
  FrameworkScaleManualSize,
  FrameworkScaleMode,
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
  FrameworkSpacingSettings,
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import {
  buildDefaultSpacingGroup,
  buildDefaultTypographyGroup,
  makeFreshSpacingGroup,
  makeFreshTypographyGroup,
  nextSpacingTabValues,
  nextTypographyTabValues,
} from '@core/framework'
import { reconcileFrameworkClasses } from './frameworkReconcile'
import { nextOrderValue } from './order'

export type UpdateFrameworkTypographyGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  /** Patch into the `min` breakpoint config — fields are merged, untouched fields preserved. */
  min: Partial<FrameworkTypographyGroup['min']>
  max: Partial<FrameworkTypographyGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type UpdateFrameworkSpacingGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  min: Partial<FrameworkSpacingGroup['min']>
  max: Partial<FrameworkSpacingGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type ScaleFamily = 'typography' | 'spacing'

/**
 * Map a family discriminator to the generic parameters that change per family:
 * the group type, the patch type, the settings branch type, and the
 * class-generator list type.
 */
export interface ScaleFamilyTypes {
  typography: {
    Group: FrameworkTypographyGroup
    Patch: UpdateFrameworkTypographyGroupPatch
    Settings: FrameworkTypographySettings
    ClassGenerator: FrameworkTypographyClassGenerator
  }
  spacing: {
    Group: FrameworkSpacingGroup
    Patch: UpdateFrameworkSpacingGroupPatch
    Settings: FrameworkSpacingSettings
    ClassGenerator: FrameworkSpacingClassGenerator
  }
}

interface ScaleFamilyFactories<F extends ScaleFamily> {
  buildDefault: (order: number) => ScaleFamilyTypes[F]['Group']
  makeFresh: (name: string, varName: string, order: number) => ScaleFamilyTypes[F]['Group']
  nextTabValues: (groups: Array<ScaleFamilyTypes[F]['Group']>) => { name: string; varName: string }
}

export const SCALE_FAMILY_FACTORIES: { [F in ScaleFamily]: ScaleFamilyFactories<F> } = {
  typography: {
    buildDefault: buildDefaultTypographyGroup,
    makeFresh: makeFreshTypographyGroup,
    nextTabValues: nextTypographyTabValues,
  },
  spacing: {
    buildDefault: buildDefaultSpacingGroup,
    makeFresh: makeFreshSpacingGroup,
    nextTabValues: nextSpacingTabValues,
  },
}

/**
 * Lazily materialise `site.settings.framework[family]` and its `groups` /
 * `classes` arrays. The two family branches have structurally identical
 * shapes, so a single helper covers both. Mutates: pass a draft.
 */
export function ensureScaleSettings<F extends ScaleFamily>(
  site: SiteDocument,
  family: F,
): ScaleFamilyTypes[F]['Settings'] {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  const framework = site.settings.framework
  if (family === 'typography') {
    if (!framework.typography) framework.typography = { groups: [], classes: [] }
    framework.typography.groups ??= []
    framework.typography.classes ??= []
    return framework.typography as ScaleFamilyTypes[F]['Settings']
  }
  if (!framework.spacing) framework.spacing = { groups: [], classes: [] }
  framework.spacing.groups ??= []
  framework.spacing.classes ??= []
  return framework.spacing as ScaleFamilyTypes[F]['Settings']
}

/** Read the family branch off a (possibly frozen) site without mutating. */
export function readScaleSettings<F extends ScaleFamily>(
  site: SiteDocument,
  family: F,
): ScaleFamilyTypes[F]['Settings'] | null {
  const branch =
    family === 'typography'
      ? site.settings.framework?.typography
      : site.settings.framework?.spacing
  return (branch ?? null) as ScaleFamilyTypes[F]['Settings'] | null
}

/** Read the family's groups off a (possibly frozen) site without mutating. */
export function readScaleGroups<F extends ScaleFamily>(
  site: SiteDocument,
  family: F,
): Array<ScaleFamilyTypes[F]['Group']> {
  const branch = readScaleSettings(site, family)
  return (branch?.groups ?? []) as Array<ScaleFamilyTypes[F]['Group']>
}

/**
 * Subset of `Update*GroupPatch` that the generic patch applier touches. Both
 * family patches structurally extend this shape (with their own `min`/`max`
 * config types narrowed at the call site).
 */
export type CommonScaleGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkTypographyGroup['mode']
  isDisabled: boolean
  min: Record<string, unknown>
  max: Record<string, unknown>
  manualSizes: FrameworkScaleManualSize[]
}>

/**
 * Merge a partial patch into a scale group. Both family Group types share the
 * exact set of fields touched here; the call site casts the patch down to the
 * common shape because TypeScript can't unify the two structural patch types
 * automatically.
 */
export function applyScaleGroupPatch(
  group: FrameworkTypographyGroup | FrameworkSpacingGroup,
  patch: CommonScaleGroupPatch,
): boolean {
  let changed = false
  function assign<K extends keyof typeof group>(key: K, value: (typeof group)[K]): void {
    if (Object.is(group[key], value)) return
    group[key] = value
    changed = true
  }

  if (patch.name !== undefined) assign('name', patch.name)
  if (patch.namingConvention !== undefined) assign('namingConvention', patch.namingConvention)
  if (patch.steps !== undefined) assign('steps', patch.steps)
  if (patch.baseScaleIndex !== undefined) assign('baseScaleIndex', patch.baseScaleIndex)
  if (patch.mode !== undefined) assign('mode', patch.mode)
  if (patch.isDisabled !== undefined) assign('isDisabled', patch.isDisabled)
  if (patch.min) {
    const min = group.min as Record<string, unknown>
    if (Object.entries(patch.min).some(([key, value]) => !Object.is(min[key], value))) {
      Object.assign(min, patch.min)
      changed = true
    }
  }
  if (patch.max) {
    const max = group.max as Record<string, unknown>
    if (Object.entries(patch.max).some(([key, value]) => !Object.is(max[key], value))) {
      Object.assign(max, patch.max)
      changed = true
    }
  }
  if (patch.manualSizes !== undefined) {
    assign('manualSizes', patch.manualSizes)
  }
  if (changed) group.updatedAt = Date.now()
  return changed
}

// ---------------------------------------------------------------------------
// Create-or-update one group (the `set_type_scale` / `set_spacing_scale` verb)
// ---------------------------------------------------------------------------

const SCALE_FAMILY_LABEL: Record<ScaleFamily, string> = {
  typography: 'Typography',
  spacing: 'Spacing',
}

/** Default `namingConvention` — the CSS variable prefix — a family creates its first group with. */
const SCALE_FAMILY_PREFIX: Record<ScaleFamily, string> = {
  typography: 'text',
  spacing: 'space',
}

/** Words agents use for "the default group" that are not a real group id or prefix. */
function scaleGroupAlias(groupId: string, family: ScaleFamily): string | null {
  const normalized = groupId.trim().toLowerCase()
  const prefix = SCALE_FAMILY_PREFIX[family]
  if (normalized === 'root' || normalized === prefix || normalized === SCALE_FAMILY_LABEL[family].toLowerCase()) {
    return prefix
  }
  return null
}

export interface SetScaleGroupRequest<F extends ScaleFamily> {
  /** A group id or `namingConvention`; omitted means the first group. */
  groupId?: string
  patch: ScaleFamilyTypes[F]['Patch']
}

export type SetScaleGroupResult =
  | {
      ok: true
      groupId: string
      action: 'created' | 'updated'
      namingConvention: string
      steps: string
    }
  | { ok: false; message: string }

/**
 * Create-or-update one scale group in a single site mutation. Without a
 * `groupId` the first group is patched; with an id/prefix that matches no
 * group, the family aliases (`root`, `typography`, `spacing`, the default
 * prefix) create the default group, anything else is refused.
 */
export function setScaleGroup<F extends ScaleFamily>(
  site: SiteDocument,
  family: F,
  request: SetScaleGroupRequest<F>,
): SetScaleGroupResult {
  const factories: ScaleFamilyFactories<F> = SCALE_FAMILY_FACTORIES[family]
  const existingGroups = readScaleGroups(site, family)
  const requestedId = request.groupId
  const alias = requestedId ? scaleGroupAlias(requestedId, family) : null
  const matched = requestedId
    ? existingGroups.find((group) => group.id === requestedId) ??
      existingGroups.find((group) => group.namingConvention === requestedId)
    : existingGroups[0]
  if (requestedId && !matched && !alias) {
    return { ok: false, message: `${SCALE_FAMILY_LABEL[family]} group not found: ${requestedId}` }
  }

  const settings = ensureScaleSettings(site, family)
  const groups = settings.groups as Array<ScaleFamilyTypes[F]['Group']>
  let groupId = matched?.id
  let action: 'created' | 'updated' = 'updated'
  if (!groupId) {
    const { name, varName } = factories.nextTabValues(groups)
    const fresh = factories.makeFresh(name, varName, nextOrderValue(groups))
    groups.push(fresh)
    groupId = fresh.id
    action = 'created'
  }
  // Re-read through the draft: the pushed object is wrapped, the original is not.
  const group = groups.find((candidate) => candidate.id === groupId)!

  const patch: CommonScaleGroupPatch = { ...(request.patch as CommonScaleGroupPatch) }
  if (patch.namingConvention === undefined && action === 'created' && alias) {
    patch.namingConvention = alias
  }
  applyScaleGroupPatch(group, patch)
  reconcileFrameworkClasses(site)

  return {
    ok: true,
    groupId,
    action,
    namingConvention: group.namingConvention,
    steps: group.steps,
  }
}

type ScaleToolPatchFields<F extends ScaleFamily> = Pick<
  ScaleFamilyTypes[F]['Patch'],
  'namingConvention' | 'steps' | 'baseScaleIndex' | 'min' | 'max'
>

/**
 * The patch a `set_type_scale` / `set_spacing_scale` call asks for: only the
 * fields the model actually sent (`min`/`max` are ignored when empty).
 */
export function scalePatchFromToolInput<F extends ScaleFamily>(
  input: ScaleToolPatchFields<F>,
): ScaleFamilyTypes[F]['Patch'] {
  return {
    ...(input.namingConvention !== undefined ? { namingConvention: input.namingConvention } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.baseScaleIndex !== undefined ? { baseScaleIndex: input.baseScaleIndex } : {}),
    ...(input.min ? { min: input.min } : {}),
    ...(input.max ? { max: input.max } : {}),
  }
}

/** The `--<prefix>-<step>` variable list a scale group generates. */
export function generatedScaleVars(namingConvention: string, steps: string): string[] {
  return steps
    .split(',')
    .map((step) => step.trim())
    .filter(Boolean)
    .map((step) => `--${namingConvention}-${step}`)
}
