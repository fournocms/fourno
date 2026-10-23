/**
 * Server-side design-token tools for MCP (PRD §8.6): colour tokens and the
 * type/spacing scales, edited in the collab Y documents with no editor open.
 * Schema, description and capabilities are inherited from the browser tools of
 * the same name; the recipes are the ones the editor store runs (`@core/siteEdit`).
 *
 * Font tokens are not here yet: installing a Google font runs over HTTP.
 */
import type { AiToolOutput, SetColorTokensInput, SetSpacingScaleInput, SetTypeScaleInput } from '@core/ai'
import {
  generatedScaleVars,
  scalePatchFromToolInput,
  setScaleGroup,
  upsertFrameworkColorTokens,
  type ScaleFamily,
} from '@core/siteEdit'
import type { AiTool, ToolContext } from '../../runtime/types'
import { editAsCaller, refuse, serverBacked } from './siteEditPlumbing'

function setColorTokensTool(input: SetColorTokensInput, ctx: ToolContext): Promise<AiToolOutput> {
  return editAsCaller(
    'site_set_color_tokens',
    ctx,
    (site) =>
      upsertFrameworkColorTokens(
        site,
        input.tokens.map((token) => ({
          slug: token.slug,
          lightValue: token.lightValue,
          ...(token.category !== undefined ? { category: token.category } : {}),
          ...(token.darkValue !== undefined ? { darkValue: token.darkValue } : {}),
          ...(token.darkModeEnabled !== undefined ? { darkModeEnabled: token.darkModeEnabled } : {}),
        })),
      ),
    (tokens) => ({ tokens: tokens.map((token) => ({ ...token, ref: `var(--${token.slug})` })) }),
  )
}

/** One handler for both scale tools: they differ only in the family the group lives in. */
function setScale(
  toolName: string,
  family: ScaleFamily,
  input: SetTypeScaleInput | SetSpacingScaleInput,
  ctx: ToolContext,
): Promise<AiToolOutput> {
  return editAsCaller(
    toolName,
    ctx,
    (site) => {
      const result =
        family === 'typography'
          ? setScaleGroup(site, 'typography', {
              ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
              patch: scalePatchFromToolInput<'typography'>(input),
            })
          : setScaleGroup(site, 'spacing', {
              ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
              patch: scalePatchFromToolInput<'spacing'>(input),
            })
      if (!result.ok) refuse(result.message)
      return result
    },
    (result) => ({
      groupId: result.groupId,
      action: result.action,
      namingConvention: result.namingConvention,
      generatedVars: generatedScaleVars(result.namingConvention, result.steps),
    }),
  )
}

export const siteTokenMcpTools: AiTool[] = [
  serverBacked('site_set_color_tokens', setColorTokensTool),
  serverBacked<SetTypeScaleInput>('site_set_type_scale', (input, ctx) =>
    setScale('site_set_type_scale', 'typography', input, ctx),
  ),
  serverBacked<SetSpacingScaleInput>('site_set_spacing_scale', (input, ctx) =>
    setScale('site_set_spacing_scale', 'spacing', input, ctx),
  ),
]
