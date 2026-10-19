import { timingSafeEqual } from 'node:crypto'
import { createDbClient } from './db'
import { runMigrations } from './db/runMigrations'
import { syncSystemRoles } from './repositories/roles'
import { readServerConfig } from './config'
import { configureNpmRegistryUrl } from './registry/config'
import { DEV_ORIGIN_ALLOWLIST, configurePublicOrigins, configureTrustedProxyCidrs, stampSocketIp } from './auth/security'
import { applySecurityHeaders } from './securityHeaders'
import { startConversationPurgeTick } from './ai/boot'
import { unsupportedNodeWarning } from './nodeVersion'
import { startHttpServer } from './runtime/httpServer'

// Before anything that could fail for a version-related reason, say which
// Node this is when it is not one a release was tested on. Boot continues.
const nodeWarning = unsupportedNodeWarning(process.versions.node)
if (nodeWarning) console.warn(nodeWarning)

await import('./richtextSanitizer')
const { handleServerRequest } = await import('./router')
const { activateInstalledServerPlugins } = await import('./plugins/runtime')
const { mediaStorageRegistry } = await import('@core/plugins/mediaStorageRegistry')
const { createCollabRelay } = await import('./collab/relay')
const { SITE_SOCKET_PATH, authorizeCollabSocket, createCollabSocketLayer } =
  await import('./collab/socket')

const config = readServerConfig()
configureTrustedProxyCidrs(config.trustedProxyCidrs)
configurePublicOrigins(config.publicOrigins)
// The MCP OAuth issuer is built only from a configured public origin (never
// the inbound Host header), so without one remote OAuth connectors cannot
// discover this server. Loopback development is exempt; see mcpIssuer().
if (config.publicOrigins.length === 0) {
  console.warn('[server] PUBLIC_ORIGIN is not set; MCP OAuth connectors work only from loopback until it is configured. Personal access tokens still work.')
}
configureNpmRegistryUrl(config.npmRegistryUrl)
const { db, migrations } = createDbClient(config.databaseUrl)
await runMigrations(db, migrations)
// System role sync runs after migrations on every boot — the Owner row's
// capabilities are force-reset to `CORE_CAPABILITIES` so existing
// installations don't strand owners on a stale grant list when new
// capabilities are added in code. See `syncSystemRoles` for the policy.
await syncSystemRoles(db)
// Wire the built-in local-disk media adapter BEFORE plugins activate —
// plugin adapters register through the same registry but local-disk is
// always the fallback for unset roles. See `mediaStorageRegistry.ts`.
mediaStorageRegistry.configureLocalDisk({ uploadsDir: config.uploadsDir })
await activateInstalledServerPlugins(db, config.uploadsDir)
// AI runtime: start the nightly conversation-purge tick. Operators add
// their own provider credentials via /admin/ai/providers on first install.
startConversationPurgeTick(db)
// Real-time co-editing: the relay owns live Y documents, their persistence,
// and the reset protocol for out-of-relay writes. The socket layer speaks
// the multiplexed y-protocols wire (see server/collab/socket.ts).
const collabRelay = createCollabRelay(db)
const collabSocket = createCollabSocketLayer(collabRelay)

/**
 * Build the CORS response headers for an incoming request.
 *
 * Returns headers ONLY when the request's `Origin` is on the dev allowlist
 * (the production admin shell is same-origin behind Caddy, so no ACAO is
 * needed). Anything else gets an empty header set — the browser then blocks
 * cross-origin reads naturally instead of us "allow"-ing a wrong value.
 *
 * Echoing an unrelated allowlist entry with `Access-Control-Allow-Credentials: true`
 * (the previous behaviour) was harmless in practice — browsers reject the
 * response when ACAO doesn't match the requesting Origin — but it was the
 * same shape as classic broken-CORS bugs and made misconfigured
 * `VITE_ALLOWED_ORIGIN` values silently open the API up.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !DEV_ORIGIN_ALLOWLIST.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // The response body varies by Origin (we either include ACAO or don't),
    // so caches must key on Origin to avoid serving a permissive response to
    // a non-allowlisted origin.
    'Vary': 'Origin',
  }
}

const server = await startHttpServer({
  port: config.port,
  hostname: config.host,

  async fetch(req, { clientAddress }) {
    const origin = req.headers.get('origin')
    const cors = corsHeaders(origin)
    const pathname = new URL(req.url).pathname

    // Stamp the socket peer address onto the request so downstream
    // `clientIp(req)` returns a real value when no `X-Forwarded-For` is
    // present (dev, self-hosted without a proxy). Strips any inbound spoof.
    stampSocketIp(req, clientAddress)

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return applySecurityHeaders(
        new Response(null, { status: 204, headers: cors }),
        pathname,
      )
    }

    // Supervisor shutdown: on platforms without POSIX signals (Windows, where
    // the process never receives SIGTERM) a supervising process stops the
    // server through this token-gated endpoint instead. Only exists when the
    // supervisor set INSTATIC_SHUTDOWN_TOKEN at spawn; 404s otherwise so it
    // is invisible on normal deployments.
    if (pathname === '/_instatic/shutdown' && req.method === 'POST') {
      const provided = req.headers.get('x-instatic-shutdown-token')
      if (config.shutdownToken && shutdownTokenMatches(provided, config.shutdownToken)) {
        setTimeout(() => void shutdown('shutdown endpoint'), 50)
        return applySecurityHeaders(
          new Response(JSON.stringify({ ok: true }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
          pathname,
        )
      }
      return applySecurityHeaders(new Response('Not Found', { status: 404 }), pathname)
    }

    // A plain (non-upgrade) request to the collab socket path. Real
    // handshakes never get here: the server adapter takes WebSocket upgrades
    // off the connection before the request handler runs.
    if (pathname === SITE_SOCKET_PATH) {
      return applySecurityHeaders(
        new Response(JSON.stringify({ error: 'WebSocket upgrade required' }), {
          status: 426,
          headers: { 'Content-Type': 'application/json' },
        }),
        pathname,
      )
    }

    try {
      const res = await handleServerRequest(req, {
        db,
        staticDir: config.staticDir,
        uploadsDir: config.uploadsDir,
        databaseUrl: config.databaseUrl,
        collabRelay,
      })
      for (const [k, v] of Object.entries(cors)) {
        res.headers.set(k, v)
      }
      return applySecurityHeaders(res, pathname)
    } catch (err) {
      // Never echo `err.message` to the client — inner handlers already return
      // structured error bodies for the failure modes they expect; anything
      // that escapes to here is an unexpected crash whose message can leak
      // SQL fragments, absolute paths, spawn() arguments, etc. Log fully,
      // respond generically.
      console.error('[server] Unhandled request error:', err)
      return applySecurityHeaders(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        }),
        pathname,
      )
    }
  },

  // Real-time co-editing socket — a WebSocket upgrade is a different
  // protocol lifecycle from the request/response router, so it is gated
  // here at the server boundary: origin + session auth run on the handshake
  // request, and a rejection is answered with the same security headers as
  // any other response.
  upgrade: {
    path: SITE_SOCKET_PATH,
    async authorize(req, { clientAddress }) {
      stampSocketIp(req, clientAddress)
      const verdict = await authorizeCollabSocket(req, db)
      return verdict instanceof Response ? applySecurityHeaders(verdict, SITE_SOCKET_PATH) : verdict
    },
    handlers: collabSocket.handlers,
  },
})

// The collab fan-out publishes through the server's topic registry —
// register the live server handle now that it is listening.
collabSocket.setPublisher(server)

// Graceful shutdown: the relay persists on an 800 ms debounce, so a redeploy
// (SIGTERM) or Ctrl-C (SIGINT) mid-window would drop the un-persisted edits
// the old transactional save made durable on ack. Flush every dirty doc
// before exiting. Idempotent + guarded so a double signal can't double-run.
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received — flushing collab docs before exit`)
  try {
    await collabRelay.destroy() // final-persists every live doc, detaches sources
  } catch (err) {
    console.error('[server] collab flush on shutdown failed:', err)
  }
  await server.stop()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

function shutdownTokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

console.log(`[server] Listening on http://localhost:${config.port}`)
