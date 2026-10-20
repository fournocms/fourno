/**
 * Shared plumbing for the server-backed site tools: run one edit as the calling
 * identity (audited), read the live site, and re-home a browser tool onto the
 * server while keeping its schema, description and capabilities.
 */
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiToolOutput } from '@core/ai'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { SiteDocument } from '@core/page-tree'
import type { AiTool, ToolContext } from '../../runtime/types'
import { siteTools } from '../../tools/site'
import {
  getSiteEditor,
  SiteEditForbiddenError,
  SiteEditRefusedError,
} from '../../../collab/siteEditor'
import { createAuditEvent } from '../../../repositories/audit'

/** MCP tool contexts carry the connector in `conversationId` (`mcp:<id>`). */
function connectorIdOf(ctx: ToolContext): string | null {
  return ctx.conversationId.startsWith('mcp:') ? ctx.conversationId.slice('mcp:'.length) : null
}

/**
 * Run one edit as the calling identity and audit it. Refusals — a recipe that
 * cannot apply, or a capability the update guard denies — are ordinary tool
 * errors the model can recover from.
 */
export async function editAsCaller<T>(
  toolName: string,
  ctx: ToolContext,
  recipe: (site: SiteDocument) => T,
  describe: (value: T) => Record<string, unknown>,
): Promise<AiToolOutput> {
  try {
    const outcome = await getSiteEditor().edit(
      { branchId: ctx.branch.branchId, capabilities: ctx.capabilities },
      recipe,
    )
    if (outcome.changed) {
      await createAuditEvent(ctx.db, {
        actorUserId: ctx.userId,
        action: 'site.edit',
        targetType: 'site',
        targetId: 'default',
        metadata: {
          tool: toolName,
          source: 'mcp',
          connectorId: connectorIdOf(ctx),
          documents: outcome.touchedDocIds,
        },
      })
    }
    return aiToolOk(describe(outcome.value))
  } catch (err) {
    if (err instanceof SiteEditRefusedError || err instanceof SiteEditForbiddenError) {
      return aiToolError(err.message)
    }
    throw err
  }
}

export async function readAsCaller<T>(ctx: ToolContext, reader: (site: SiteDocument) => T): Promise<T> {
  return getSiteEditor().read(ctx.branch.branchId, reader)
}

export function refuse(message: string): never {
  throw new SiteEditRefusedError(message)
}

/**
 * Re-home a browser tool onto the server: schema, description and capability
 * requirements stay the browser tool's, so the two can never drift apart.
 */
export function serverBacked<TInput>(
  name: string,
  handler: (input: TInput, ctx: ToolContext) => Promise<AiToolOutput>,
): AiTool {
  const browserTool = siteTools.find((tool) => tool.name === name)
  if (!browserTool) throw new Error(`[mcp] site tool "${name}" is not defined`)
  return {
    ...browserTool,
    execution: 'server',
    handler: (rawInput, ctx) => handler(parseValue(browserTool.inputSchema, rawInput) as TInput, ctx),
  }
}
