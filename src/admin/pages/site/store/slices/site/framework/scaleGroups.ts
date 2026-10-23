/**
 * Generic action factory for the two parallel "fluid scale" families:
 * typography and spacing.
 *
 * The two families have identical store-action shapes — toggle disabled,
 * create/update/duplicate/reset/delete a group, upsert a manual size, replace
 * the class-generator list. The recipes and family lookups live in
 * `@core/siteEdit` (shared with the server-side scale tools); this module only
 * wraps them in `mutateSite`.
 */

import { nanoid } from 'nanoid'
import {
  applyScaleGroupPatch,
  ensureScaleSettings,
  nextOrderValue,
  readScaleGroups,
  readScaleSettings,
  reconcileFrameworkClasses,
  SCALE_FAMILY_FACTORIES,
  setScaleGroup,
  type CommonScaleGroupPatch,
  type ScaleFamily,
  type ScaleFamilyTypes,
  type SetScaleGroupRequest,
  type SetScaleGroupResult,
} from '@core/siteEdit'
import type { SiteSliceHelpers } from '@site/store/slices/site/types'

const SCALE_NOT_SAVED =
  'The scale was not saved: the editor could not reach the collaboration server. Try again in a moment.'

// ---------------------------------------------------------------------------
// Action factory
// ---------------------------------------------------------------------------

interface ScaleGroupActions<F extends ScaleFamily> {
  toggleDisabled: () => void
  /** Create-or-update one group in ONE mutation; see `setScaleGroup`. */
  setGroup: (request: SetScaleGroupRequest<F>) => SetScaleGroupResult
  createGroup: () => ScaleFamilyTypes[F]['Group']
  updateGroup: (groupId: string, patch: ScaleFamilyTypes[F]['Patch']) => void
  duplicateGroup: (groupId: string) => ScaleFamilyTypes[F]['Group'] | null
  resetGroup: (groupId: string) => void
  deleteGroup: (groupId: string) => void
  upsertManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<{ name: string; min: number; max: number }>,
  ) => void
  setClassGenerators: (
    classes: ScaleFamilyTypes[F]['ClassGenerator'][],
  ) => void
}

/**
 * Build the action set for one scale family. The returned object uses generic
 * names (`createGroup`, etc.) that the per-family wrapper in `spacing.ts` /
 * `typography.ts` re-exposes under family-specific names like
 * `createFrameworkSpacingGroup`.
 */
export function createScaleGroupActions<F extends ScaleFamily>(
  helpers: SiteSliceHelpers,
  family: F,
): ScaleGroupActions<F> {
  const { get, mutateSite } = helpers
  const { buildDefault, makeFresh, nextTabValues } = SCALE_FAMILY_FACTORIES[family]

  return {
    toggleDisabled: () => {
      mutateSite((site) => {
        const settings = ensureScaleSettings(site, family)
        settings.isDisabled = !settings.isDisabled
        reconcileFrameworkClasses(site)
        return true
      })
    },

    setGroup: (request) => {
      const outcome: { value: SetScaleGroupResult | null } = { value: null }
      const accepted = mutateSite((site) => {
        outcome.value = setScaleGroup(site, family, request)
        return outcome.value.ok
      })
      // A refusal from the recipe (unknown group) carries its own message; a
      // recipe that succeeded but was not accepted means the collab write
      // gate was closed.
      if (outcome.value && !outcome.value.ok) return outcome.value
      return accepted && outcome.value ? outcome.value : { ok: false, message: SCALE_NOT_SAVED }
    },

    createGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Mutative-frozen) live site — `ensureScaleSettings`
      // mutates and would throw on the frozen object when the family branch is
      // absent. The actual write happens inside `mutateSite` below.
      const groups = readScaleGroups(site, family)
      const { name, varName } = nextTabValues(groups)
      const order = nextOrderValue(groups)
      const group = makeFresh(name, varName, order)

      mutateSite((draftSite) => {
        const draftSettings = ensureScaleSettings(draftSite, family)
        ;(draftSettings.groups as Array<ScaleFamilyTypes[F]['Group']>).push(group)
        reconcileFrameworkClasses(draftSite)
        return true
      })
      return group
    },

    updateGroup: (groupId, patch) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const group = (settings.groups as Array<ScaleFamilyTypes[F]['Group']>).find(
          (g) => g.id === groupId,
        )
        if (!group) return false
        if (!applyScaleGroupPatch(group, patch as CommonScaleGroupPatch)) return false
        reconcileFrameworkClasses(site)
        return true
      })
    },

    duplicateGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view — see note in createGroup.
      const groups = readScaleGroups(site, family)
      const source = groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextTabValues(groups)
      const order = nextOrderValue(groups)
      const now = Date.now()
      const sourceClone = structuredClone(source)
      const copy = {
        ...sourceClone,
        id: nanoid(),
        name,
        namingConvention: varName,
        manualSizes: source.manualSizes?.map((m) => ({
          ...m,
          id: nanoid(),
          name: m.name.replace(source.namingConvention, varName),
        })),
        order,
        createdAt: now,
        updatedAt: now,
      } as ScaleFamilyTypes[F]['Group']

      mutateSite((draftSite) => {
        const draftSettings = ensureScaleSettings(draftSite, family)
        ;(draftSettings.groups as Array<ScaleFamilyTypes[F]['Group']>).push(copy)
        reconcileFrameworkClasses(draftSite)
        return true
      })
      return copy
    },

    resetGroup: (groupId) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const groups = settings.groups as Array<ScaleFamilyTypes[F]['Group']>
        const idx = groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return false
        const order = groups[idx].order
        groups[idx] = { ...buildDefault(order), id: groupId }
        reconcileFrameworkClasses(site)
        return true
      })
    },

    deleteGroup: (groupId) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        if (!settings.groups.some((g: { id: string }) => g.id === groupId)) return false
        settings.groups = settings.groups.filter(
          (g: { id: string }) => g.id !== groupId,
        ) as ScaleFamilyTypes[F]['Settings']['groups']
        settings.classes = (
          settings.classes?.filter((c: { tabId: string }) => c.tabId !== groupId) ?? []
        ) as ScaleFamilyTypes[F]['Settings']['classes']
        reconcileFrameworkClasses(site)
        return true
      })
    },

    upsertManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const group = (settings.groups as Array<ScaleFamilyTypes[F]['Group']>).find(
          (g) => g.id === groupId,
        )
        if (!group) return false
        const manualSizes = group.manualSizes ?? []
        const idx = manualSizes.findIndex((m) => m.id === sizeId)
        if (idx < 0) {
          if (
            typeof patch.name !== 'string' ||
            typeof patch.min !== 'number' ||
            typeof patch.max !== 'number'
          ) {
            return false
          }
          group.manualSizes ??= []
          group.manualSizes.push({
            id: sizeId,
            name: patch.name,
            min: patch.min,
            max: patch.max,
          })
        } else {
          const current = manualSizes[idx]
          const changed = Object.entries(patch).some(
            ([key, value]) => !Object.is(current[key as keyof typeof current], value),
          )
          if (!changed) return false
          group.manualSizes![idx] = { ...current, ...patch }
        }
        group.updatedAt = Date.now()
        reconcileFrameworkClasses(site)
        return true
      })
    },

    setClassGenerators: (classes) => {
      mutateSite((site) => {
        const settings = ensureScaleSettings(site, family)
        settings.classes =
          classes as ScaleFamilyTypes[F]['Settings']['classes']
        reconcileFrameworkClasses(site)
        return true
      })
    },
  }
}
