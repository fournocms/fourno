/**
 * Framework colors — store actions. The token recipes live in
 * `@core/siteEdit` (shared with the server-side `site_set_color_tokens` tool).
 */

import type { SiteDocument } from '@core/page-tree'
import {
  applyFrameworkColorTokenPatch,
  cloneFrameworkColorToken,
  createFrameworkColorTokenFromInput,
  ensureFrameworkColors,
  reconcileFrameworkClasses,
  reorderFrameworkColorTokenInGroup,
  upsertFrameworkColorTokens,
  type UpdateFrameworkColorTokenPatch,
  type UpsertedColorToken,
} from '@core/siteEdit'
import type { SiteSlice, SiteSliceHelpers } from '@site/store/slices/site/types'

// ---------------------------------------------------------------------------
// Action factory
// ---------------------------------------------------------------------------

type FrameworkColorActions = Pick<
  SiteSlice,
  | 'createFrameworkColorToken'
  | 'upsertFrameworkColorTokens'
  | 'updateFrameworkColorToken'
  | 'duplicateFrameworkColorToken'
  | 'reorderFrameworkColorToken'
  | 'deleteFrameworkColorToken'
>

export function createFrameworkColorActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkColorActions {
  return {
    createFrameworkColorToken: (input) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Mutative-frozen) live site — `ensureFrameworkColors`
      // mutates and would throw on the frozen object. The actual write happens
      // inside `mutateSite` below where Mutative's draft is mutable.
      const colors = site.settings.framework?.colors ?? { tokens: [] }
      const token = createFrameworkColorTokenFromInput(input, colors)

      mutateSite((draftSite) => {
        const draftColors = ensureFrameworkColors(draftSite)
        draftColors.tokens.push(token)
        reconcileFrameworkClasses(draftSite)
        return true
      })

      return token
    },

    /**
     * Create-or-update a whole token list in ONE site mutation.
     *
     * A loop of single-token actions is not equivalent: each one is its own
     * mutation, and a mutation that ensures a not-yet-bound collab doc
     * registers an unsynced write gate, so every LATER write in the same tick
     * is refused with `syncing`. Callers that install a palette in one go
     * (`site_set_color_tokens`, theme presets) then keep only the prefix that
     * ran before the gate closed — with each individual action still returning
     * a token, so the loss is silent. One mutation means one gate check, and
     * the boolean below reports the outcome honestly.
     */
    upsertFrameworkColorTokens: (inputs) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      let tokens: UpsertedColorToken[] = []
      const accepted = mutateSite((draftSite) => {
        tokens = upsertFrameworkColorTokens(draftSite, inputs)
        return true
      })
      return { tokens, accepted }
    },

    updateFrameworkColorToken: (tokenId, patch) => {
      mutateSite((site) => {
        const colors = site.settings.framework?.colors
        const token = colors?.tokens.find((candidate) => candidate.id === tokenId)
        if (!colors || !token) return false
        if (!applyFrameworkColorTokenPatch(token, patch, colors)) return false
        reconcileFrameworkClasses(site)
        return true
      })
    },

    duplicateFrameworkColorToken: (tokenId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view of the (Mutative-frozen) live site — see note in
      // `createFrameworkColorToken` for why we don't call `ensureFrameworkColors`
      // here. The actual write happens inside `mutateSite` below.
      const colors = site.settings.framework?.colors ?? { tokens: [] }
      const token = colors.tokens.find((candidate) => candidate.id === tokenId)
      if (!token) return null
      const copy = cloneFrameworkColorToken(token, colors)

      mutateSite((draftSite) => {
        const draftColors = ensureFrameworkColors(draftSite)
        draftColors.tokens.push(copy)
        reconcileFrameworkClasses(draftSite)
        return true
      })

      return copy
    },

    reorderFrameworkColorToken: (tokenId, direction) => {
      mutateSite((site) => {
        const colors = site.settings.framework?.colors
        if (!colors) return false
        if (!reorderFrameworkColorTokenInGroup(colors, tokenId, direction)) return false
        reconcileFrameworkClasses(site)
        return true
      })
    },

    deleteFrameworkColorToken: (tokenId) => {
      mutateSite((site) => {
        const colors = site.settings.framework?.colors
        if (!colors) return false
        const nextTokens = colors.tokens.filter((token) => token.id !== tokenId)
        if (nextTokens.length === colors.tokens.length) return false
        colors.tokens = nextTokens
        reconcileFrameworkClasses(site)
        return true
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Preview helper — used by the panel to compute change impact before confirming
// ---------------------------------------------------------------------------

/**
 * Apply a token patch to a draft site for the *preview* path. Mirrors the
 * field-level effect that `applyFrameworkColorTokenPatch` has in the slice
 * for everything that changes class generation (utilities, transparent,
 * shades, tints, slug). Side-effect-free fields (color values, category,
 * darkValue, order) are intentionally omitted — they don't affect which
 * classes the framework will generate, so the preview can skip them.
 */
export function applyColorTokenPatchPreview(
  draft: SiteDocument,
  tokenId: string,
  patch: UpdateFrameworkColorTokenPatch,
): void {
  const token = draft.settings.framework?.colors?.tokens.find(
    (t) => t.id === tokenId,
  )
  if (!token) return
  if (patch.slug !== undefined) token.slug = patch.slug
  if (patch.generateUtilities) {
    token.generateUtilities = {
      ...token.generateUtilities,
      ...patch.generateUtilities,
    }
  }
  if (patch.generateTransparent !== undefined) {
    token.generateTransparent = patch.generateTransparent
  }
  if (patch.generateShades) {
    token.generateShades = { ...token.generateShades, ...patch.generateShades }
  }
  if (patch.generateTints) {
    token.generateTints = { ...token.generateTints, ...patch.generateTints }
  }
}
