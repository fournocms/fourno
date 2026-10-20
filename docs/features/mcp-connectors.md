# MCP connections

MCP connections let external AI clients operate an Fourno instance through the [Model Context Protocol](https://modelcontextprotocol.io). Fourno is the MCP server: clients list its capability-filtered tools, run headless reads, relay editing tools to the connection owner's open workspace, and explicitly publish completed drafts.

This is the inverse of the **Providers** tab. Providers let Fourno call model APIs; MCP connections let outside clients call Fourno.

The wire server uses the stable split `@modelcontextprotocol/server` v2 package. That dependency remains allowed only under `server/ai/mcp/`; provider drivers continue to use their direct REST implementations.

## Connection modes

The UI exposes two credential lifecycles instead of a cosmetic local/remote switch:

| Mode | Intended client | Authentication | Lifecycle |
|---|---|---|---|
| Hosted OAuth | Claude custom connectors and other remote MCP clients | OAuth authorization code with S256 PKCE | The client discovers the authorization server, dynamically registers, and sends the user to Fourno for consent. Access tokens last up to one hour; refresh tokens rotate; the grant expires after 90 days. |
| Personal access token | Claude Code, Codex, Cursor, local bridges, and clients that accept an explicit header | `Authorization: Bearer imcp_pat_…` | Created after step-up authentication, shown once, scoped to selected capabilities, configurable expiry, independently revocable. |

Both modes resolve to the same persistent connection grant and the same `toolAllowedForCapabilities` gate. OAuth does not create a wider tool path.

The MCP endpoint is always:

```text
https://<your-host>/_fourno/mcp
```

Hosted clients run in their provider's infrastructure. They cannot reach `localhost`, a private LAN address, or an HTTP-only deployment. The MCP tab detects this and warns until Fourno's canonical public origin is HTTPS.

## Wire protocol

The endpoint uses the official v2 `createMcpHandler` Web-standard entry and serves stable MCP `2026-07-28`. That revision is stateless at the protocol layer:

- clients probe capabilities with `server/discover`; there is no modern `initialize` / `notifications/initialized` handshake;
- every request carries `MCP-Protocol-Version: 2026-07-28`, the required `Mcp-Method` routing header, and `Mcp-Name` when the operation addresses a named tool/resource/prompt;
- the request's `params._meta` carries the protocol version, client identity, and client capabilities;
- the endpoint never creates or returns `Mcp-Session-Id` for modern requests.

The same handler keeps the SDK's `legacy: 'stateless'` fallback enabled. Clients speaking a 2025-era revision may still send an `initialize` request and then make independent authenticated POSTs, but no protocol session is created. This compatibility path can be removed when supported clients have all migrated.

Every request is bearer-authenticated before the SDK dispatches it. Browser-originated requests are also checked against Fourno's configured public-origin policy before authentication or dispatch; requests without `Origin` remain valid for native and server-to-server MCP clients.

See the official [TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [stable MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), and [release changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) for the wire revision.

## Hosted OAuth flow

Fourno implements the MCP authorization-server surface directly:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata for the MCP resource. |
| `/.well-known/oauth-protected-resource/_fourno/mcp` | Path-aware protected-resource discovery alias. |
| `/.well-known/oauth-authorization-server` | Authorization-server metadata. |
| `/_fourno/oauth/register` | Dynamic client registration for public clients. |
| `/admin/ai/oauth/authorize` | Signed-in consent screen. |
| `/_fourno/oauth/token` | Form-encoded authorization-code and refresh-token exchange. |

The issuer, the `resource` value, and every URL in these documents come from the configured public origin (`PUBLIC_ORIGIN`, auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on Render and Railway), never from the inbound `Host` header. Remote OAuth connectors therefore require `PUBLIC_ORIGIN`. Without it, both discovery endpoints answer `503` with `{ "error": "MCP OAuth needs PUBLIC_ORIGIN to be configured for this deployment." }`, the token endpoint answers `503` with `temporarily_unavailable`, the `401` challenge on `/_fourno/mcp` carries `scope="mcp"` but no `resource_metadata`, and OAuth access tokens do not authenticate. Personal access tokens keep working. Requests addressed to a loopback host (`localhost`, `127.0.0.1`, `::1`) are exempt and use their own origin so local development keeps working; the server warns at boot when no public origin is configured.

The authorization sequence is:

```text
Hosted MCP client
  → reads protected-resource and authorization-server metadata
  → dynamically registers its exact callback URI
  → opens /admin/ai/oauth/authorize with resource + state + S256 challenge
  → user signs in, reviews the client, selects capabilities, and completes step-up
  → Fourno redirects a one-time code to the registered callback
  → client exchanges code + verifier for opaque access and refresh tokens
  → client calls /_fourno/mcp with the access token
```

Security properties:

- Public clients only: no generated client secret is required or stored.
- Redirect URIs are registered exactly. HTTPS is required except for HTTP loopback callbacks used by native clients.
- Authorization codes expire after five minutes, are stored only as SHA-256 hashes, and can be consumed once.
- S256 PKCE, exact client id, callback, and MCP `resource` binding are checked during exchange.
- OAuth access tokens are opaque, stored only as hashes, bound to the exact MCP resource, and expire after at most one hour.
- Refresh tokens rotate on every use. Reuse of a rotated token revokes the connection and all of its tokens.
- OAuth grants expire after 90 days. Disconnecting the connection immediately invalidates its access and refresh tokens.
- The consent API requires `ai.providers.manage`; approval also requires a fresh step-up window. The approver cannot delegate a capability they do not hold.
- Dynamic-registration client names are self-declared. The consent screen surfaces the exact callback and tells the approver to verify that they initiated the request and recognize the address.
- The client-supplied `state` value is round-tripped on success and denial. Redirects are generated only from the callback already registered for that client.

### Claude Desktop / Claude custom connector

1. Deploy Fourno at a public HTTPS origin and set `PUBLIC_ORIGIN` to it (auto-detected on Render and Railway). The OAuth issuer is built only from this value.
2. In Fourno, open **AI → MCP** and copy the **Remote MCP URL**.
3. In Claude, open **Settings → Connectors**, add a custom connector, choose a name, and paste the URL.
4. Leave **OAuth Client ID** and **OAuth Client Secret** empty. Claude can dynamically register as a public PKCE client.
5. Choose **Connect**. The browser returns to Fourno, where the user selects capabilities and approves the connection.

The resulting OAuth connection appears automatically under **Authorized connections**. No Fourno token is copied into Claude.

## Personal access tokens

In **AI → MCP**, choose **Create access token**, name the device/client, choose an expiry and capabilities, then complete step-up. The plaintext `imcp_pat_…` token is returned once; only its SHA-256 hash is stored.

Claude Code example:

```sh
claude mcp add fourno --transport http http://localhost:3000/_fourno/mcp \
  --header "Authorization: Bearer imcp_pat_…"
```

Claude Desktop can also reach a local server through a local stdio bridge. The UI generates a ready-to-copy `mcp-remote` configuration that keeps the token in an environment variable instead of embedding it in the command arguments.

Personal tokens are deliberately not the hosted-connector setup path. The hosted Claude connector form does not provide a general custom-header field, and a cloud-hosted connector cannot reach a local-only endpoint.

## Architecture

```text
MCP client
  │ Streamable HTTP + OAuth/PAT bearer
  ▼
server/router.ts
  ├─ OAuth metadata / registration / token endpoints
  └─ /_fourno/mcp
       ▼
server/ai/mcp/auth.ts
  bearer → OAuth access token or personal token → connection capability set
       ▼
server/ai/mcp/server.ts + registry.ts
  capability-filtered MCP tools
       ▼
executeAiTool(...) / live editor bridge
  ├─ repositories and publisher for headless tools
  ├─ server/collab/siteEditor.ts → live Yjs docs (page edits, no editor needed)
  └─ connection owner's open Site or Content workspace for the remaining browser tools
```

### Module layout

| Module | Responsibility |
|---|---|
| `paths.ts` | Canonical MCP, OAuth, metadata, and consent paths. |
| `oauth/protocol.ts` | Issuer/resource construction (configured public origin, loopback fallback, otherwise none), the 503 issuer-unavailable response, supported scopes, redirect validation, PKCE validation, safe callback generation. |
| `oauth/schemas.ts` | TypeBox schemas for dynamic registration and form/query parsing. |
| `oauth/handler.ts` | Public metadata, dynamic registration, and token endpoints with protocol-shaped errors and rate limits. |
| `oauth/store.ts` | Registered clients, hashed one-time codes, token issue/rotation, resource-bound access lookup. |
| `handlers/oauthAuthorization.ts` | Admin-session consent read/decision API, capability floor, and step-up gate. |
| `handlers/management.ts` | Connection overview, personal-token creation, and revoke/disconnect. |
| `connectors/store.ts` | Persistent connection grant and the token-free `toConnectionView` projection. |
| `connectors/token.ts` | Opaque secret generation, hashing, and PKCE challenge calculation. |
| `auth.ts` | Resolves OAuth access tokens or personal tokens to `{ connectorId, userId, capabilities }`; returns a discovery-aware 401 otherwise. |
| `contentAuthorization.ts` | Before a document tool is relayed to the browser, resolves the target row through `server/auth/dataAccess.ts` with the connection's own identity and capabilities (table family plus own-vs-any ownership), so the owner's admin cookie cannot widen the delegated grant. |
| `transports/http.ts` | Authenticated, Origin-validated `createMcpHandler` entry for MCP 2026-07-28 plus the stateless 2025 fallback. |
| `server.ts` / `registry.ts` | Low-level SDK server, TypeBox input schemas, catalog deduplication, and capability filtering. |
| `editorBridge.ts` | Per-user, per-scope live workspace bridge. The stream carries an **idle lease** (120s, re-armed by every relayed tool request) so an active batch is never cut mid-flight; only quiet streams recycle. The workspace's reconnect loop (`useMcpWorkspaceBridge`) reopens a recycled healthy stream immediately off the stream-end network event — deliberately timer-free, because hidden webviews (backgrounded browser tabs) clamp timers to minutes while network events still fire — and a tab becoming visible short-circuits any pending retry delay. |
| `tools/siteEditTools.ts` | Server-side page-editing tools (insert/replace HTML, node edits, page lifecycle, document reads). Re-homes the browser tool of the same name onto `server/collab/siteEditor.ts`. |
| `tools/publishTool.ts` | Explicit canonical full-site publish with MCP audit metadata. |
| `tools/uploadMediaTool.ts` | Server-resolved image upload (`media_upload`) — inline base64 or SSRF-guarded `sourceUrl` download, through the shared media pipeline. |

## Tool execution model

MCP exposes the full deduplicated tool catalog, filtered by the connection's capabilities.

Server-resolved tools work without an editor open. They include content reads, `get_context`, `site_list_documents`, `site_read_styles`, `site_list_breakpoints`, `media_upload`, explicit `site_publish`, and the **server-side page-editing tools** (next section). Publishing requires `ai.tools.write` plus `pages.publish`, runs the canonical full-site pipeline, swaps the static slot atomically, and records the connection id in the publish audit event.

`media_upload` is the one server-resolved write that mutates outside the live editor draft: it adds an image to the Media library through the same `acceptUploadedMedia` core the HTTP route uses (magic-byte sniffing, SVG sanitisation, storage dispatch, responsive variants). Bytes arrive inline (base64) or via an https `sourceUrl` the host downloads under the plugin network layer's SSRF blocklist — https-only, DNS-resolved, per-redirect-hop re-validation, size-capped. It requires `ai.tools.write` plus `media.write`.

### Editing pages without an open editor

PRD §8.6: an agent can build a page while nobody is in the admin. The page-editing tools run **on the server** against the same Yjs documents the editors hold — `site_read_document`, `site_get_node_html`, `site_insert_html`, `site_replace_node_html`, `site_delete_node`, `site_update_node_props`, `site_move_node`, `site_rename_node`, `site_duplicate_node`, the page lifecycle (`site_add_page`, `site_delete_page`, `site_rename_page`, `site_duplicate_page`, `site_set_page_template`, `site_clear_page_template`), the style registry (`site_apply_css`, `site_assign_class`, `site_remove_class`), and the colour and scale tokens (`site_set_color_tokens`, `site_set_type_scale`, `site_set_spacing_scale`). They inherit schema, description and capability requirements from the browser tool of the same name (`server/ai/mcp/tools/siteEditTools.ts`); the MCP registry lists them first, so they replace the editor-bridged version for MCP callers.

The server is one more Yjs peer (`server/collab/siteEditor.ts`), not a second write path:

1. The site (shell + page/component/layout docs) is projected from the relay's **live** docs — never from the database, so an edit still inside the persist debounce is visible.
2. A pure recipe from `@core/siteEdit` / `@core/page-tree` — the same functions the editor store runs — mutates a Mutative draft.
3. The recipe's patches are translated by the editor's own write translator (`applySitePatchesToDocs`) onto forks of the live docs, giving one update per touched doc.
4. Each update passes `validateGuardedUpdate` with the **connection's capabilities** (structure / content / style, the check partial-capability sockets get). One refused update refuses the whole edit and nothing is written.
5. The updates are applied to the live docs in one synchronous pass. The relay then persists them (debounced blob + derived row JSON) and broadcasts them, so every open editor sees the edit live.

Steps 1–4 contain no `await`, so a human edit cannot interleave with a recipe. Every changed edit writes a `site.edit` audit event (tool, connector, touched docs). Richtext props are sanitised exactly like the editor executor does. CSS and class edits share their recipes with the editor store (`@core/siteEdit`: `applyCssRules`, `deleteCssRules`, `removeCssRuleProperties`, `setNodeClassAssigned`; tokens: `upsertFrameworkColorTokens`, `setScaleGroup`, which also run the framework class reconcile in the same edit); a call that cannot apply (unknown or framework-locked selector, unknown class, ambient rule passed to `site_assign_class`) is refused whole and writes nothing. Server edits address nodes by id (node ids are unique across all documents of a site) and run on the main branch; branch-scoped agent work belongs to the approval queue (PRD §8.8).

Still relayed to an open workspace (not yet headless): `site_set_font_tokens` (installing a Google font runs over HTTP), code assets, `site_open_document`, `site_render_snapshot`, and the content-workspace write tools.

Browser tools that remain run against the connection owner's live workspace. Code-asset, live-DOM, font-token and content-mutation tools route to the matching open Site or Content workspace. If that workspace is not open, the tool returns a scope-specific error while headless tools remain available. `tools/list` states that requirement in each remaining browser tool's description, so a client learns the precondition when it picks the tool rather than from a failed call.

Writes remain drafts. Clients should finish and verify an edit sequence, then call `site_publish` once only when deployment was requested.

## Data model

`ai_mcp_connectors` remains the persistent owner/capability grant (migrations `018` and `019`):

| Column | Notes |
|---|---|
| `id`, `user_id`, `label` | Connection identity and owner. |
| `auth_mode` | `bearer` for personal access tokens, `oauth` for hosted grants. |
| `token_hash` | Personal-token hash; `NULL` for OAuth connections. |
| `capabilities_json` | Granted capability subset. |
| `created_at`, `last_used_at`, `revoked_at`, `expires_at` | Shared lifecycle. |
| `type` | Legacy storage discriminator retained in the existing live schema; it is no longer exposed as a product choice or wire field. |

Migration `021_mcp_oauth` adds, in both dialects:

- `ai_mcp_oauth_clients`: dynamically registered public clients and exact callback lists;
- `ai_mcp_oauth_codes`: hashed, short-lived, one-time PKCE authorization codes;
- `ai_mcp_oauth_tokens`: hashed access/refresh tokens with kind, client, scope, resource, expiry, and revocation state.

The wire-safe `McpConnectionView` never includes a token or hash. Personal-token creation is the only response that contains a plaintext personal token. OAuth codes and tokens stay on the protocol endpoints and never appear in list/read APIs.

Create and manual revoke actions retain the existing `ai.mcp_connector.created` and `ai.mcp_connector.revoked` audit events, with the authentication mode included in create metadata.

## Capability enforcement

- Management and consent require `ai.providers.manage`.
- Token creation and OAuth approval require step-up authentication.
- Mutating tools require `ai.tools.write`.
- Page-tree edits require the matching site/page edit capabilities. Server-side edits are additionally checked per touched document by the collab update guard (the check partial-capability sockets get), so a tool that slips past selection-time gating still cannot write a change class the connection was not granted.
- Full-site deployment additionally requires `pages.publish`.
- Own-vs-any content permissions are checked again against the target row before browser relay.
- The approver can grant only capabilities they hold.

## Tests

- `server/ai/mcp/oauth/protocol.test.ts` covers issuer trust: the configured public origin wins over the `Host` header, loopback requests fall back to their own origin, and any other request has no issuer.
- `server/ai/mcp/oauth/handler.test.ts` covers discovery metadata, the 503 answer without a configured public origin, public dynamic registration, and callback policy.
- `server/ai/mcp/oauth/store.test.ts` covers PKCE exchange, exact binding, one-time codes, access lookup, refresh rotation/reuse, and revocation.
- `server/ai/mcp/auth.test.ts` covers personal and OAuth bearer resolution plus the protected-resource challenge with and without a trustworthy issuer.
- `src/__tests__/ai/mcpOAuthAuthorizationHandler.test.ts` covers signed-in consent, capability selection, exact callback redirects, denial, and privilege floors.
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` covers connection listing, personal-token creation, step-up, revoke, and privilege floors.
- `src/__tests__/server/siteEditor.test.ts` covers server-side page editing against a real relay and database: no editor connected, an open editor peer seeing the edit live, a human edit between two agent calls surviving, the update guard refusing a capability the connection lacks, persistence of derived rows, and the `site.edit` audit event.
- `server/ai/mcp/e2e.test.ts`, `transports/http.test.ts`, and `publishTool.test.ts` cover the real MCP request flow and publish path.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` gates the token-free connection projection.
