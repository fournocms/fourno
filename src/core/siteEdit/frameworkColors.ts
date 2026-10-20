/**
 * Framework color-token recipes — pure mutations over a SiteDocument draft.
 *
 * The editor store's color actions and the server-side `site_set_color_tokens`
 * tool both run these, so a palette means the same thing whoever installed it.
 */

import { nanoid } from 'nanoid'
import type { FrameworkColorToken, FrameworkColorUtilityType } from '@core/framework-schema'
import type { SiteDocument, SiteSettings } from '@core/page-tree'
import { generateDefaultDarkColor, normalizeFrameworkColorSlug } from '@core/framework'
import { reconcileFrameworkClasses } from './frameworkReconcile'
import { nextOrderValue } from './order'

export type ColorVariantOptions = { enabled: boolean; count: number }

export interface CreateFrameworkColorTokenInput {
  category?: string
  slug: string
  lightValue: string
  darkValue?: string
  darkModeEnabled?: boolean
  generateUtilities?: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent?: boolean
  generateShades?: Partial<ColorVariantOptions>
  generateTints?: Partial<ColorVariantOptions>
}

export type UpdateFrameworkColorTokenPatch = Partial<{
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent: boolean
  generateShades: Partial<ColorVariantOptions>
  generateTints: Partial<ColorVariantOptions>
  order: number
}>

type FrameworkColorsSettings = NonNullable<SiteSettings['framework']>['colors']

const DEFAULT_COLOR_UTILITIES = {
  text: true,
  background: true,
  border: true,
  fill: false,
} as const

const DEFAULT_COLOR_VARIANTS: ColorVariantOptions = { enabled: true, count: 4 }

/** Materialise `settings.framework.colors.tokens` on a draft. */
export function ensureFrameworkColors(site: SiteDocument): FrameworkColorsSettings {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.colors) {
    site.settings.framework.colors = { tokens: [] }
  }
  site.settings.framework.colors.tokens ??= []
  return site.settings.framework.colors
}

function normalizeCategoryLabel(input: string | undefined | null): string {
  return typeof input === 'string' ? input.trim() : ''
}

/**
 * Match a new category label against existing tokens case-insensitively.
 * If any other token already uses a category with the same letters (regardless
 * of case), the canonical casing of that existing label wins — this prevents
 * "Brand" and "brand" from drifting into separate categories when the user
 * forgets the original capitalization.
 */
function canonicalizeCategoryLabel(
  input: string | undefined | null,
  tokens: FrameworkColorToken[],
  excludeTokenId?: string,
): string {
  const trimmed = normalizeCategoryLabel(input)
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  for (const token of tokens) {
    if (token.id === excludeTokenId) continue
    const existing = token.category.trim()
    if (existing && existing.toLowerCase() === lower) return existing
  }
  return trimmed
}

function uniqueColorSlug(
  tokens: FrameworkColorToken[],
  desiredSlug: string,
  excludeTokenId?: string,
): string {
  const base = normalizeFrameworkColorSlug(desiredSlug)
  const existing = new Set(
    tokens
      .filter((token) => token.id !== excludeTokenId)
      .map((token) => normalizeFrameworkColorSlug(token.slug)),
  )
  if (!existing.has(base)) return base

  let suffix = 2
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

export function createFrameworkColorTokenFromInput(
  input: CreateFrameworkColorTokenInput,
  colors: FrameworkColorsSettings,
): FrameworkColorToken {
  const now = Date.now()
  const lightValue = input.lightValue.trim()
  return {
    id: nanoid(),
    category: canonicalizeCategoryLabel(input.category, colors.tokens),
    slug: uniqueColorSlug(colors.tokens, input.slug),
    lightValue,
    darkValue: input.darkValue?.trim() || generateDefaultDarkColor(lightValue),
    darkModeEnabled: input.darkModeEnabled ?? false,
    generateUtilities: {
      ...DEFAULT_COLOR_UTILITIES,
      ...(input.generateUtilities ?? {}),
    },
    generateTransparent: input.generateTransparent ?? true,
    generateShades: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateShades ?? {}),
    },
    generateTints: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateTints ?? {}),
    },
    order: nextOrderValue(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

export function applyFrameworkColorTokenPatch(
  token: FrameworkColorToken,
  patch: UpdateFrameworkColorTokenPatch,
  colors: FrameworkColorsSettings,
): boolean {
  let changed = false
  function assign<K extends keyof FrameworkColorToken>(key: K, value: FrameworkColorToken[K]): void {
    if (Object.is(token[key], value)) return
    token[key] = value
    changed = true
  }

  if (patch.category !== undefined) {
    assign('category', canonicalizeCategoryLabel(patch.category, colors.tokens, token.id))
  }
  if (patch.slug !== undefined) {
    assign('slug', uniqueColorSlug(colors.tokens, patch.slug, token.id))
  }
  if (patch.lightValue !== undefined) assign('lightValue', patch.lightValue.trim())
  if (patch.darkValue !== undefined) assign('darkValue', patch.darkValue.trim())
  if (patch.darkModeEnabled !== undefined) {
    assign('darkModeEnabled', patch.darkModeEnabled)
    if (patch.darkModeEnabled && !patch.darkValue && !token.darkValue) {
      assign('darkValue', generateDefaultDarkColor(token.lightValue))
    }
  }
  if (patch.generateUtilities) {
    const next = {
      ...token.generateUtilities,
      ...patch.generateUtilities,
    }
    if (
      Object.entries(next).some(
        ([key, value]) => token.generateUtilities[key as keyof typeof next] !== value,
      )
    ) {
      token.generateUtilities = next
      changed = true
    }
  }
  if (patch.generateTransparent !== undefined) {
    assign('generateTransparent', patch.generateTransparent)
  }
  if (patch.generateShades) {
    const next = { ...token.generateShades, ...patch.generateShades }
    if (
      next.enabled !== token.generateShades.enabled ||
      next.count !== token.generateShades.count
    ) {
      token.generateShades = next
      changed = true
    }
  }
  if (patch.generateTints) {
    const next = { ...token.generateTints, ...patch.generateTints }
    if (
      next.enabled !== token.generateTints.enabled ||
      next.count !== token.generateTints.count
    ) {
      token.generateTints = next
      changed = true
    }
  }
  if (patch.order !== undefined) assign('order', patch.order)
  if (changed) token.updatedAt = Date.now()
  return changed
}

export function cloneFrameworkColorToken(
  token: FrameworkColorToken,
  colors: FrameworkColorsSettings,
): FrameworkColorToken {
  const now = Date.now()
  return {
    ...structuredClone(token),
    id: nanoid(),
    slug: uniqueColorSlug(colors.tokens, `${token.slug}-copy`),
    order: nextOrderValue(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

export function reorderFrameworkColorTokenInGroup(
  colors: FrameworkColorsSettings,
  tokenId: string,
  direction: 'up' | 'down',
): boolean {
  const token = colors.tokens.find((candidate) => candidate.id === tokenId)
  if (!token) return false

  const group = colors.tokens
    .filter((candidate) => candidate.category === token.category)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
  const currentIndex = group.findIndex((candidate) => candidate.id === tokenId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= group.length) return false

  const orderValues = group.map((candidate) => candidate.order).sort((a, b) => a - b)
  const reordered = [...group]
  const [moved] = reordered.splice(currentIndex, 1)
  reordered.splice(targetIndex, 0, moved)

  for (let index = 0; index < reordered.length; index += 1) {
    reordered[index].order = orderValues[index] ?? index
    reordered[index].updatedAt = Date.now()
  }
  return true
}

export interface UpsertedColorToken {
  slug: string
  action: 'created' | 'updated'
}

/**
 * Create-or-update a whole token list in ONE site mutation, keyed by normalized
 * slug, then reconcile the generated utility classes. Entries are applied in
 * order against the growing token list, so slug uniqueness and category
 * canonicalization see what earlier entries of the same batch added — the view
 * a sequence of single-token calls would have had.
 */
export function upsertFrameworkColorTokens(
  site: SiteDocument,
  inputs: readonly CreateFrameworkColorTokenInput[],
): UpsertedColorToken[] {
  const colors = ensureFrameworkColors(site)
  const results: UpsertedColorToken[] = []
  for (const input of inputs) {
    const normalizedSlug = normalizeFrameworkColorSlug(input.slug)
    const match = colors.tokens.find(
      (token) => normalizeFrameworkColorSlug(token.slug) === normalizedSlug,
    )
    if (match) {
      applyFrameworkColorTokenPatch(match, input, colors)
      results.push({ slug: match.slug, action: 'updated' })
      continue
    }
    const token = createFrameworkColorTokenFromInput(input, colors)
    colors.tokens.push(token)
    results.push({ slug: token.slug, action: 'created' })
  }
  reconcileFrameworkClasses(site)
  return results
}
