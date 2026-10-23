/**
 * Server-side site editing (PRD §8.6 / SECURITY §5.5) — the MCP page-edit
 * tools writing the collab Y documents with NO editor connected.
 *
 * Real relay on a real migrated database. The "open editor" is a plain Y.Doc
 * kept in sync through `relay.subscribeUpdates`, i.e. exactly the broadcast
 * path a socket takes — so "an open editor sees the edit live" is asserted on
 * what that peer projects, not on a mock.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { encodeCollabDocId, projectPageDoc } from '@core/collab'
import type { CoreCapability } from '@core/capabilities'
import { pageFromRow } from '@core/data/pageFromRow'
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import { configureSiteEditor, getSiteEditor } from '../../../server/collab/siteEditor'
import { executeAiTool } from '../../../server/ai/drivers/http/execTool'
import { siteEditMcpTools } from '../../../server/ai/mcp/tools/siteEditTools'
import { siteTokenMcpTools } from '../../../server/ai/mcp/tools/siteTokenTools'
import type { AiBrowserBridge, AiTool, AiToolOutput } from '../../../server/ai/runtime/types'
import { getDataRow } from '../../../server/repositories/data'
import { handleMcpHttp } from '../../../server/ai/mcp'
import { createBearerConnection } from '../../../server/ai/mcp/connectors/store'
import { generatePersonalAccessToken, hashMcpSecret } from '../../../server/ai/mcp/connectors/token'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
// The update guard and the HTML importer classify nodes via the module registry.
import '@modules/base/index'

const FULL_EDITOR: readonly CoreCapability[] = [
  'ai.tools.write',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
]

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

const NO_BRIDGE: AiBrowserBridge = {
  callBrowser: async () => {
    throw new Error('a server-edit tool must never reach for the editor bridge')
  },
}

interface Stack {
  harness: CapabilityTestHarness
  relay: CollabRelay
  homeId: string
  rootNodeId: string
  call(
    name: string,
    input: unknown,
    capabilities?: readonly CoreCapability[],
  ): Promise<AiToolOutput>
  /** A Y.Doc kept in sync with the relay the way a connected editor tab is. */
  openEditorPeer(docId: string): Promise<Y.Doc>
}

async function startStack(): Promise<Stack> {
  const harness = await createCapabilityTestHarness()
  cleanups.push(() => harness.cleanup())
  await harness.setupOwner()
  const { rows: users } = await harness.db<{ id: string }>`select id from users limit 1`
  const ownerUserId = users[0]!.id
  const relay = createCollabRelay(harness.db, { persistDebounceMs: 10 })
  cleanups.push(() => relay.destroy())
  // holdMs 0: every call releases its docs, so each call re-hydrates from the
  // stored blob — the strictest variant of "no editor, nothing warm".
  cleanups.push(configureSiteEditor(relay, { holdMs: 0 }))

  const { rows } = await harness.db<{ id: string }>`select id from data_rows where table_id = ${'pages'}`
  const homeId = rows[0]!.id
  const homeDocId = encodeCollabDocId({ kind: 'page', branchId: MAIN_SCOPE.branchId, rowId: homeId })
  const { doc } = await relay.openDoc(homeDocId)
  const rootNodeId = projectPageDoc(doc, homeId).rootNodeId

  const tools = new Map<string, AiTool>([...siteEditMcpTools, ...siteTokenMcpTools].map((tool) => [tool.name, tool]))
  return {
    harness,
    relay,
    homeId,
    rootNodeId,
    call: (name, input, capabilities = FULL_EDITOR) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`unknown tool ${name}`)
      return executeAiTool(tool, input, NO_BRIDGE, new AbortController().signal, {
        db: harness.db,
        branch: MAIN_SCOPE,
        userId: ownerUserId,
        capabilities,
        scope: 'site',
        conversationId: 'mcp:test-connector',
        snapshot: null,
      })
    },
    openEditorPeer: async (docId) => {
      const { doc: live } = await relay.retain(docId)
      cleanups.push(() => relay.release(docId))
      const peer = new Y.Doc()
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(live))
      const detach = relay.subscribeUpdates((updatedDocId, update) => {
        if (updatedDocId === docId) Y.applyUpdate(peer, update, 'wire')
      })
      cleanups.push(detach)
      return peer
    },
  }
}

function ok(output: AiToolOutput): Record<string, unknown> {
  expect(output.ok, output.error).toBe(true)
  return (output.data ?? {}) as Record<string, unknown>
}

describe('server-side site editing', () => {
  it('inserts HTML into a page without any editor connected, and persists it', async () => {
    const stack = await startStack()

    const inserted = ok(
      await stack.call('site_insert_html', {
        parentId: stack.rootNodeId,
        html: '<section class="hero"><h1>Hello agent</h1></section><style>.hero { color: red }</style>',
      }),
    )
    expect((inserted.nodeIds as string[]).length).toBe(1)

    // Readable immediately, through the live docs — before any persist.
    const read = ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } }))
    expect(read.html).toContain('Hello agent')
    expect(String(read.css)).toContain('.hero')

    // …and durable: the relay persists the derived row JSON the publisher reads.
    await stack.relay.flushAll()
    const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
    const page = pageFromRow(row!)
    expect(JSON.stringify(page.nodes)).toContain('Hello agent')
  })

  it('an open editor sees the edit live', async () => {
    const stack = await startStack()
    const docId = encodeCollabDocId({ kind: 'page', branchId: MAIN_SCOPE.branchId, rowId: stack.homeId })
    const peer = await stack.openEditorPeer(docId)
    const before = Object.keys(projectPageDoc(peer, stack.homeId).nodes).length

    ok(await stack.call('site_insert_html', { parentId: stack.rootNodeId, html: '<p>Live paragraph</p>' }))

    const projected = projectPageDoc(peer, stack.homeId)
    expect(Object.keys(projected.nodes).length).toBeGreaterThan(before)
    expect(JSON.stringify(projected.nodes)).toContain('Live paragraph')
  })

  it('edits, moves, renames, duplicates and deletes nodes', async () => {
    const stack = await startStack()
    const { nodeIds } = ok(
      await stack.call('site_insert_html', {
        parentId: stack.rootNodeId,
        html: '<div><p>one</p><p>two</p></div>',
      }),
    ) as { nodeIds: string[] }
    const wrapper = nodeIds[0]!
    const html = ok(await stack.call('site_get_node_html', { nodeId: wrapper })).html as string
    expect(html).toContain('one')

    const nodes = async () =>
      getSiteEditor().read(MAIN_SCOPE.branchId, (site) => site.pages.find((p) => p.id === stack.homeId)!.nodes)
    const [first, second] = (await nodes())[wrapper]!.children as [string, string]

    ok(await stack.call('site_rename_node', { nodeId: wrapper, label: 'Card' }))
    expect((await nodes())[wrapper]!.label).toBe('Card')

    ok(await stack.call('site_move_node', { nodeId: second, newParentId: wrapper, newIndex: 0 }))
    expect((await nodes())[wrapper]!.children).toEqual([second, first])

    const duplicated = ok(await stack.call('site_duplicate_node', { nodeId: first, count: 2 })) as {
      nodeIds: string[]
    }
    expect(duplicated.nodeIds).toHaveLength(2)
    expect((await nodes())[wrapper]!.children).toHaveLength(4)

    ok(await stack.call('site_delete_node', { nodeId: duplicated.nodeIds[0] }))
    expect((await nodes())[wrapper]!.children).toHaveLength(3)
    expect((await nodes())[duplicated.nodeIds[0]!]).toBeUndefined()
  })

  it('creates a page and fills it, end to end', async () => {
    const stack = await startStack()
    const page = ok(await stack.call('site_add_page', { title: 'About', slug: 'about' })) as {
      pageId: string
      rootNodeId: string
    }

    ok(await stack.call('site_insert_html', { parentId: page.rootNodeId, html: '<h1>About us</h1>' }))
    const read = ok(await stack.call('site_read_document', { document: { type: 'page', id: page.pageId } }))
    expect(read.html).toContain('About us')

    await stack.relay.flushAll()
    const row = await getDataRow(stack.harness.db, MAIN_SCOPE, page.pageId)
    expect(row).not.toBeNull()
    expect(pageFromRow(row!).slug).toBe('about')
    expect(JSON.stringify(pageFromRow(row!).nodes)).toContain('About us')

    ok(await stack.call('site_delete_page', { pageId: page.pageId }))
    const listed = await getSiteEditor().read(MAIN_SCOPE.branchId, (site) => site.pages.map((p) => p.id))
    expect(listed).toEqual([stack.homeId])
  })

  it('hides structure tools from a caller without the structure capability (selection-time gate)', async () => {
    const stack = await startStack()
    const refused = await stack.call(
      'site_insert_html',
      { parentId: stack.rootNodeId, html: '<p>sneaky</p>' },
      ['ai.tools.write', 'site.read', 'site.content.edit'],
    )
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/not permitted/)
  })

  it('keeps a human edit that lands between two agent calls (warm documents, no clobbering)', async () => {
    const stack = await startStack()
    cleanups.push(configureSiteEditor(stack.relay, { holdMs: 5_000 }))
    const docId = encodeCollabDocId({ kind: 'page', branchId: MAIN_SCOPE.branchId, rowId: stack.homeId })

    ok(await stack.call('site_insert_html', { parentId: stack.rootNodeId, html: '<p>agent one</p>' }))

    // A human types in the open editor: a plain Y edit tagged with a foreign origin.
    const { doc } = await stack.relay.openDoc(docId)
    const humanNodeId = Object.keys(projectPageDoc(doc, stack.homeId).nodes).find(
      (id) => JSON.stringify(projectPageDoc(doc, stack.homeId).nodes[id]).includes('agent one'),
    )!
    doc.transact(() => {
      const nodes = doc.getMap<unknown>('tree').get('nodes') as Y.Map<Y.Map<unknown>>
      const props = nodes.get(humanNodeId)!.get('props') as Y.Map<unknown>
      props.set('human', 'edited-by-human')
    }, 'human')

    ok(await stack.call('site_insert_html', { parentId: stack.rootNodeId, html: '<p>agent two</p>' }))

    const nodes = JSON.stringify(projectPageDoc(doc, stack.homeId).nodes)
    expect(nodes).toContain('agent one')
    expect(nodes).toContain('edited-by-human')
    expect(nodes).toContain('agent two')
  })

  it('the update guard refuses structure edits from a partial-capability caller', async () => {
    const stack = await startStack()
    const tool = siteEditMcpTools.find((candidate) => candidate.name === 'site_insert_html')!
    // Skip selection-time gating on purpose: the guard is the second, independent line.
    const output = await tool.handler!(
      { parentId: stack.rootNodeId, html: '<p>sneaky</p>' },
      {
        db: stack.harness.db,
        branch: MAIN_SCOPE,
        userId: 'agent',
        capabilities: ['ai.tools.write', 'site.read', 'site.content.edit'],
        scope: 'site',
        conversationId: 'mcp:test-connector',
        snapshot: null,
        signal: new AbortController().signal,
      },
    )
    expect((output as AiToolOutput).ok).toBe(false)
    expect((output as AiToolOutput).error).toMatch(/Edit refused/)

    const read = ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } }))
    expect(read.html).not.toContain('sneaky')
  })

  it('records every server-side edit in the audit log', async () => {
    const stack = await startStack()
    ok(await stack.call('site_insert_html', { parentId: stack.rootNodeId, html: '<p>audited</p>' }))
    const { rows } = await stack.harness.db<{ action: string; metadata_json: Record<string, unknown> }>`
      select action, metadata_json from audit_events where action = ${'site.edit'}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata_json).toMatchObject({
      tool: 'site_insert_html',
      source: 'mcp',
      connectorId: 'test-connector',
    })
  })

  it('applies, updates, trims and deletes CSS rules with no editor connected', async () => {
    const stack = await startStack()
    const readCss = async () =>
      String(ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } })).css)

    const created = ok(
      await stack.call('site_apply_css', {
        operation: 'merge',
        css: '.card { padding: 8px; color: red } nav a:hover { text-decoration: underline }',
      }),
    )
    expect(created).toMatchObject({ cssRulesCreated: 2, cssRulesUpdated: 0 })

    // Merge touches only the declarations it names; replace swaps the whole rule.
    ok(await stack.call('site_apply_css', { operation: 'merge', css: '.card { color: blue }' }))
    ok(await stack.call('site_assign_class', { nodeId: stack.rootNodeId, classId: 'card' }))
    const merged = await readCss()
    expect(merged).toContain('padding')
    expect(merged).toContain('blue')
    ok(await stack.call('site_apply_css', { operation: 'replace', css: '.card { margin: 4px }' }))
    expect(await readCss()).not.toContain('padding')

    const trimmed = ok(
      await stack.call('site_apply_css', { operation: 'remove-properties', selectors: ['.card'], properties: ['margin'] }),
    )
    // `margin` is stored as its side longhands, so one property removes several keys.
    expect(trimmed.cssRulesUpdated).toBe(1)
    expect(trimmed.cssPropertiesRemoved).toBeGreaterThan(0)
    expect(await readCss()).not.toContain('margin')

    const deleted = ok(await stack.call('site_apply_css', { operation: 'delete', selectors: ['.card'] }))
    expect(deleted).toMatchObject({ cssRulesDeleted: 1 })
    // Deleting a class also detaches it from every node that carried it.
    const read = ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } }))
    expect(String(read.html)).not.toContain('card')
  })

  it('refuses CSS calls it cannot apply and leaves the site untouched', async () => {
    const stack = await startStack()
    const missing = await stack.call('site_apply_css', { operation: 'delete', selectors: ['.nope'] })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('CSS selectors not found: .nope')

    const empty = await stack.call('site_apply_css', { operation: 'merge', css: '/* nothing */' })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('No CSS rules parsed')

    const missingProperty = await stack.call('site_apply_css', { operation: 'merge', css: '.box { color: red }' })
    expect(missingProperty.ok).toBe(true)
    const unset = await stack.call('site_apply_css', {
      operation: 'remove-properties',
      selectors: ['.box'],
      properties: ['margin'],
    })
    expect(unset.ok).toBe(false)
    expect(unset.error).toContain('CSS properties are not set')
  })

  it('assigns and removes classes by name, and refuses ambient rules and unknown targets', async () => {
    const stack = await startStack()
    ok(await stack.call('site_apply_css', { operation: 'merge', css: '.badge { color: green } h2 { margin: 0 }' }))
    const inserted = ok(
      await stack.call('site_insert_html', { parentId: stack.rootNodeId, html: '<p>tagged</p>' }),
    )
    const nodeId = (inserted.nodeIds as string[])[0]!
    const html = async () =>
      String(ok(await stack.call('site_get_node_html', { nodeId })).html)

    ok(await stack.call('site_assign_class', { nodeId, classId: 'badge' }))
    expect(await html()).toContain('badge')
    // Assigning twice is a no-op, not an error.
    ok(await stack.call('site_assign_class', { nodeId, classId: 'badge' }))
    ok(await stack.call('site_remove_class', { nodeId, classId: 'badge' }))
    expect(await html()).not.toContain('badge')

    const ambient = await stack.call('site_assign_class', { nodeId, classId: 'h2' })
    expect(ambient.ok).toBe(false)
    expect(ambient.error).toContain('ambient rule')
    const unknownClass = await stack.call('site_assign_class', { nodeId, classId: 'no-such-class' })
    expect(unknownClass.error).toContain('Class not found')
    const unknownNode = await stack.call('site_assign_class', { nodeId: 'ghost', classId: 'badge' })
    expect(unknownNode.error).toContain('Node not found')
  })

  it('installs and updates a color palette with no editor connected', async () => {
    const stack = await startStack()
    const frameworkOf = () => getSiteEditor().read(MAIN_SCOPE.branchId, (site) => site.settings.framework)

    const created = ok(
      await stack.call('site_set_color_tokens', {
        tokens: [
          { slug: 'primary', lightValue: '#3b82f6' },
          { slug: 'ink', lightValue: '#0a0a0a', category: 'Neutrals' },
        ],
      }),
    ) as { tokens: Array<{ slug: string; action: string; ref: string }> }
    expect(created.tokens.map((token) => token.action)).toEqual(['created', 'created'])
    expect(created.tokens[0]!.ref).toBe('var(--primary)')

    // Re-running patches in place, even for a slug repeated inside one batch.
    const updated = ok(
      await stack.call('site_set_color_tokens', {
        tokens: [
          { slug: 'primary', lightValue: '#2563eb' },
          { slug: 'primary', lightValue: '#1d4ed8' },
          { slug: 'accent', lightValue: '#f59e0b' },
        ],
      }),
    ) as { tokens: Array<{ slug: string; action: string }> }
    expect(updated.tokens.map((token) => token.action)).toEqual(['updated', 'updated', 'created'])

    const framework = await frameworkOf()
    const tokens = framework!.colors.tokens
    expect(tokens.map((token) => token.slug).sort()).toEqual(['accent', 'ink', 'primary'])
    expect(tokens.find((token) => token.slug === 'primary')!.lightValue).toBe('#1d4ed8')
    expect(tokens.find((token) => token.slug === 'ink')!.category).toBe('Neutrals')
    // The generated utility classes follow the palette (reconcile ran in the same edit).
    const classNames = await getSiteEditor().read(MAIN_SCOPE.branchId, (site) =>
      Object.values(site.styleRules).map((rule) => rule.name),
    )
    expect(classNames).toContain('text-primary')
    expect(classNames).toContain('bg-accent')
  })

  it('configures the type and spacing scales, creating a group when none matches', async () => {
    const stack = await startStack()
    const groupsOf = (family: 'typography' | 'spacing') =>
      getSiteEditor().read(
        MAIN_SCOPE.branchId,
        (site) => site.settings.framework?.[family]?.groups.map((group) => ({ ...group })) ?? [],
      )

    const type = ok(
      await stack.call('site_set_type_scale', {
        groupId: 'root',
        namingConvention: 'text',
        steps: 'xs,s,m',
        min: { fontSize: 14 },
        max: { fontSize: 18 },
      }),
    ) as { groupId: string; action: string; namingConvention: string; generatedVars: string[] }
    expect(type.action).toBe('created')
    expect(type.generatedVars).toEqual(['--text-xs', '--text-s', '--text-m'])
    const [typeGroup] = await groupsOf('typography')
    expect(typeGroup).toMatchObject({ id: type.groupId, steps: 'xs,s,m' })
    expect(typeGroup!.min).toMatchObject({ fontSize: 14 })

    // Same group by id: patched, not duplicated.
    const retyped = ok(await stack.call('site_set_type_scale', { groupId: type.groupId, steps: 'xs,s,m,l' }))
    expect(retyped).toMatchObject({ groupId: type.groupId, action: 'updated' })
    expect(await groupsOf('typography')).toHaveLength(1)

    const spacing = ok(
      await stack.call('site_set_spacing_scale', { namingConvention: 'space', steps: '2xs,xs,s' }),
    ) as { action: string; generatedVars: string[] }
    expect(spacing.generatedVars).toEqual(['--space-2xs', '--space-xs', '--space-s'])
    expect(await groupsOf('spacing')).toHaveLength(1)
  })

  it('refuses an unknown scale group and leaves the site untouched', async () => {
    const stack = await startStack()
    const before = await getSiteEditor().read(MAIN_SCOPE.branchId, (site) => site.settings.framework)
    const refused = await stack.call('site_set_type_scale', { groupId: 'no-such-group', steps: 'a,b' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('Typography group not found: no-such-group')
    const refusedSpacing = await stack.call('site_set_spacing_scale', { groupId: 'no-such-group' })
    expect(refusedSpacing.error).toContain('Spacing group not found: no-such-group')
    expect(await getSiteEditor().read(MAIN_SCOPE.branchId, (site) => site.settings.framework)).toEqual(before)
  })

  it('hides style tools from a caller without the style capability', async () => {
    const stack = await startStack()
    const refused = await stack.call(
      'site_apply_css',
      { operation: 'merge', css: '.x { color: red }' },
      ['ai.tools.write', 'site.read', 'site.structure.edit', 'site.content.edit'],
    )
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/not permitted/)
    const refusedTokens = await stack.call(
      'site_set_color_tokens',
      { tokens: [{ slug: 'primary', lightValue: '#3b82f6' }] },
      ['ai.tools.write', 'site.read', 'site.structure.edit', 'site.content.edit'],
    )
    expect(refusedTokens.error).toMatch(/not permitted/)
  })

  it('reports a missing node as a recoverable tool error', async () => {
    const stack = await startStack()
    const output = await stack.call('site_delete_node', { nodeId: 'does-not-exist' })
    expect(output.ok).toBe(false)
    expect(output.error).toContain('Node not found')
  })

  it('applies simultaneous agent calls one after another without losing any', async () => {
    const stack = await startStack()
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((label) =>
        stack.call('site_insert_html', { parentId: stack.rootNodeId, html: `<p>parallel ${label}</p>` }),
      ),
    )
    results.forEach((result) => ok(result))
    const html = ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } })).html
    for (const label of ['a', 'b', 'c', 'd', 'e']) expect(html).toContain(`parallel ${label}`)
  })

  it('is reachable over the real MCP endpoint with no editor bridge connected', async () => {
    const stack = await startStack()
    const { rows } = await stack.harness.db<{ id: string }>`select id from users limit 1`
    const token = generatePersonalAccessToken()
    await createBearerConnection(stack.harness.db, {
      userId: rows[0]!.id,
      label: 'Claude',
      capabilities: [...FULL_EDITOR],
      tokenHash: await hashMcpSecret(token),
    })

    const response = await handleMcpHttp(
      new Request('http://localhost/_fourno/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'site_insert_html',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'site_insert_html',
            arguments: { parentId: stack.rootNodeId, html: '<h2>Built over MCP</h2>' },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'claude.ai', version: '0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
      stack.harness.db,
    )
    const body = JSON.parse(await response!.text()) as { result?: { isError?: boolean; content?: unknown } }
    expect(body.result?.isError, JSON.stringify(body)).toBeFalsy()

    const read = ok(await stack.call('site_read_document', { document: { type: 'page', id: stack.homeId } }))
    expect(read.html).toContain('Built over MCP')
  })
})
