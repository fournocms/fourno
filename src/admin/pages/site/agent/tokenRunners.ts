/**
 * Browser-side runners for the design-system token write tools:
 * set_color_tokens, set_font_tokens, set_type_scale, set_spacing_scale.
 *
 * Split out of `executor.ts` so each file keeps one responsibility: the
 * executor owns HTML/node/class/page mutations + dispatch; this module owns the
 * framework-token + font-token surface. Each runner validates its raw input
 * with TypeBox (Constraint #272), then dispatches to the editor-store framework
 * / font actions. All four are create-or-update — keyed by color slug, font
 * variable, or scale group — so re-running patches in place.
 *
 * `set_font_tokens` can install a brand-new Google web font: it POSTs to
 * `/admin/api/cms/fonts/install` (downloads the woff2 files server-side, gated
 * by `site.style.edit` via the session cookie), merges the returned `FontEntry`
 * into the library, then binds the token to it.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  SetColorTokensInputSchema,
  SetFontTokensInputSchema,
  SetTypeScaleInputSchema,
  SetSpacingScaleInputSchema,
} from '@core/ai'
import { apiRequest } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { generatedScaleVars, scalePatchFromToolInput } from '@core/siteEdit'
import { FontEntrySchema, normalizeFontTokenVariable } from '@core/fonts'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

// The token tool input schemas are the single source of truth in `@core/ai`
// (`src/core/ai/toolSchemas.ts`) — the SAME schemas the server advertises in
// `server/ai/tools/site/writeTools.ts`. Imported above; validated with
// `parseValue` below.

/** Validates the `/admin/api/cms/fonts/install` 201 body. */
const FontInstallResponseSchema = Type.Object({ font: FontEntrySchema })

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export function runSetColorTokens(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetColorTokensInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  // One mutation for the whole palette, not one per token. Create-or-update is
  // keyed by normalized slug inside the batch, so re-runs patch the existing
  // token instead of minting `primary-2`. Batching is a correctness
  // requirement, not an optimization: a per-token loop lets the collab write
  // gate close midway and silently drop every remaining token.
  const { tokens, accepted } = store.upsertFrameworkColorTokens(
    input.tokens.map((t) => ({
      slug: t.slug,
      lightValue: t.lightValue,
      ...(t.category !== undefined ? { category: t.category } : {}),
      ...(t.darkValue !== undefined ? { darkValue: t.darkValue } : {}),
      ...(t.darkModeEnabled !== undefined ? { darkModeEnabled: t.darkModeEnabled } : {}),
    })),
  )
  if (!accepted) {
    return aiToolError(
      'Color tokens were not saved: the editor could not reach the collaboration server. Try again in a moment.',
    )
  }
  return aiToolOk({
    tokens: tokens.map((t) => ({ ...t, ref: `var(--${t.slug})` })),
  })
}

export async function runSetFontTokens(rawInput: unknown): Promise<AiToolOutput> {
  const input = parseValue(SetFontTokensInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')
  const results: Array<{
    name: string
    variable: string
    ref: string
    installed?: string
    action: 'created' | 'updated'
  }> = []

  for (const t of input.tokens) {
    // Be lenient with model-authored args: the tool description asks for
    // googleFamily XOR familyId, but models sometimes send both after reading
    // existing site state. Installing the named Google family is the clearer
    // intent, so prefer it and ignore the stale/preexisting id.
    let familyId = t.googleFamily ? undefined : t.familyId
    let installed: string | undefined
    if (t.googleFamily) {
      try {
        const { font } = await apiRequest('/admin/api/cms/fonts/install', {
          method: 'POST',
          body: {
            family: t.googleFamily,
            variants: t.variants ?? ['400', '700'],
            subsets: t.subsets ?? ['latin'],
          },
          schema: FontInstallResponseSchema,
          fallbackMessage: 'Font install failed',
        })
        const committed = store.addFont(font)
        familyId = committed.id
        installed = committed.family
      } catch (err) {
        return aiToolError(
          `Failed to install font "${t.googleFamily}": ${getErrorMessage(err, 'install failed')}`,
        )
      }
    }

    // Create-or-update by normalized variable (defaults from the name).
    const desiredVar = normalizeFontTokenVariable(t.variable ?? t.name)
    const existing = getStoreState().site?.settings.fonts?.tokens ?? []
    const match = desiredVar ? existing.find((e) => e.variable === desiredVar) : undefined
    if (match) {
      store.updateFontToken(match.id, {
        name: t.name,
        ...(t.fallback !== undefined ? { fallback: t.fallback } : {}),
        ...(familyId !== undefined ? { familyId } : {}),
      })
      results.push({
        name: t.name,
        variable: match.variable,
        ref: `var(--${match.variable})`,
        ...(installed ? { installed } : {}),
        action: 'updated',
      })
    } else {
      const created = store.createFontToken({
        name: t.name,
        ...(t.variable !== undefined ? { variable: t.variable } : {}),
        ...(t.fallback !== undefined ? { fallback: t.fallback } : {}),
        ...(familyId != null ? { familyId } : {}),
      })
      results.push({
        name: created.name,
        variable: created.variable,
        ref: `var(--${created.variable})`,
        ...(installed ? { installed } : {}),
        action: 'created',
      })
    }
  }

  // Read back rather than trusting the writes: a refused mutation leaves the
  // token absent while the loop above still recorded it as created, which is
  // how a site ends up referencing `var(--font-x)` that was never installed.
  const saved = new Set(
    (getStoreState().site?.settings.fonts?.tokens ?? []).map((token) => token.variable),
  )
  const lost = results.filter((r) => !saved.has(r.variable)).map((r) => r.variable)
  if (lost.length > 0) {
    return aiToolError(
      `Font tokens were not saved (${lost.join(', ')}): the editor could not reach the collaboration server. Try again in a moment.`,
    )
  }
  return aiToolOk({ tokens: results })
}

export function runSetTypeScale(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetTypeScaleInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  const result = store.setFrameworkTypographyScale({
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    patch: scalePatchFromToolInput<'typography'>(input),
  })
  if (!result.ok) return aiToolError(result.message)
  return aiToolOk({
    groupId: result.groupId,
    action: result.action,
    namingConvention: result.namingConvention,
    generatedVars: generatedScaleVars(result.namingConvention, result.steps),
  })
}

export function runSetSpacingScale(rawInput: unknown): AiToolOutput {
  const input = parseValue(SetSpacingScaleInputSchema, rawInput)
  const store = getStoreState()
  if (!store.site) return aiToolError('No active site.')

  const result = store.setFrameworkSpacingScale({
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    patch: scalePatchFromToolInput<'spacing'>(input),
  })
  if (!result.ok) return aiToolError(result.message)
  return aiToolOk({
    groupId: result.groupId,
    action: result.action,
    namingConvention: result.namingConvention,
    generatedVars: generatedScaleVars(result.namingConvention, result.steps),
  })
}
