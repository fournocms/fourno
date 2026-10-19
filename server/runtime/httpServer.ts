/**
 * HTTP + WebSocket server adapter — the one place the server touches the
 * Node HTTP stack.
 *
 * Everything above this file speaks Web-standard `Request` / `Response`
 * (the in-house router, every handler, the MCP transport). This adapter
 * bridges those to Node:
 *
 *   - HTTP requests go through `srvx` (Node adapter), which hands the fetch
 *     handler a Web `Request` and writes the returned `Response` (including
 *     streamed bodies) back to the Node socket.
 *   - WebSocket upgrades on `upgradePath` are taken off the raw `upgrade`
 *     event, authorized by the caller's `authorize` hook (which sees the same
 *     Web `Request` shape as every other route), and completed by `ws`.
 *   - Topic fan-out (`subscribe` / `unsubscribe` / `publish`) is a small
 *     in-process registry: the collab relay publishes each doc update to the
 *     sockets bound to that doc, including the originator.
 *
 * The server keeps no idle timeout on HTTP requests: the agent endpoint
 * streams NDJSON for as long as a model's tool loop runs, and admin uploads
 * can legitimately take minutes. Header reads stay bounded by Node's
 * `headersTimeout`. WebSockets get a protocol-level ping every
 * `SOCKET_HEARTBEAT_MS`; a peer that misses one round is terminated, so a
 * vanished client releases its relay docs instead of pinning them forever.
 */
import type { IncomingMessage, Server as NodeHttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { NodeRequest, serve } from 'srvx/node'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

const SOCKET_HEARTBEAT_MS = 30_000

/** Connection facts the fetch handler cannot read off a `Request`. */
export interface RequestContext {
  /** Socket peer address (never derived from forwarding headers). */
  clientAddress: string | null
}

/** One accepted WebSocket connection, carrying the data `authorize` attached. */
export interface RealtimeSocket<TData> {
  readonly data: TData
  send(payload: Uint8Array): void
  subscribe(topic: string): void
  unsubscribe(topic: string): void
}

export interface RealtimeHandlers<TData> {
  /** Frames larger than this close the connection (1009) before buffering. */
  maxPayloadLength: number
  open(socket: RealtimeSocket<TData>): void
  message(socket: RealtimeSocket<TData>, payload: Uint8Array | string): void | Promise<void>
  close(socket: RealtimeSocket<TData>): void
}

export interface UpgradeRoute<TData> {
  path: string
  /**
   * Gate the handshake. Resolve to `{ accept: data }` to open the socket, or
   * to a `Response` (401/403/…) that is written back instead.
   */
  authorize(req: Request, context: RequestContext): Promise<{ accept: TData } | Response>
  handlers: RealtimeHandlers<TData>
}

export interface HttpServerOptions<TData> {
  port: number
  hostname: string
  fetch(req: Request, context: RequestContext): Promise<Response>
  upgrade?: UpgradeRoute<TData>
}

export interface HttpServerHandle {
  /** The bound port (resolved when `port: 0` asked for an ephemeral one). */
  readonly port: number
  /** Send `payload` to every socket subscribed to `topic`. Returns the recipient count. */
  publish(topic: string, payload: Uint8Array): number
  /** Stop accepting connections and close every open socket. */
  stop(): Promise<void>
}

/** Pub/sub registry shared by every socket of one server. */
class TopicRegistry {
  private readonly subscribersByTopic = new Map<string, Set<WebSocket>>()

  subscribe(topic: string, socket: WebSocket): void {
    let subscribers = this.subscribersByTopic.get(topic)
    if (!subscribers) {
      subscribers = new Set()
      this.subscribersByTopic.set(topic, subscribers)
    }
    subscribers.add(socket)
  }

  unsubscribe(topic: string, socket: WebSocket): void {
    const subscribers = this.subscribersByTopic.get(topic)
    if (!subscribers) return
    subscribers.delete(socket)
    if (subscribers.size === 0) this.subscribersByTopic.delete(topic)
  }

  unsubscribeAll(socket: WebSocket, topics: Iterable<string>): void {
    for (const topic of topics) this.unsubscribe(topic, socket)
  }

  publish(topic: string, payload: Uint8Array): number {
    const subscribers = this.subscribersByTopic.get(topic)
    if (!subscribers) return 0
    let recipientCount = 0
    for (const socket of subscribers) {
      if (socket.readyState !== socket.OPEN) continue
      socket.send(payload, { binary: true })
      recipientCount++
    }
    return recipientCount
  }
}

function normalizeRawData(raw: RawData, isBinary: boolean): Uint8Array | string {
  const bytes = Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw
  return isBinary ? bytes : Buffer.from(bytes).toString('utf8')
}

/** Write a Web `Response` onto a raw socket that never became a WebSocket. */
async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer())
  const headerLines = [`HTTP/1.1 ${response.status} ${response.statusText || 'Error'}`]
  response.headers.forEach((value, name) => {
    if (name !== 'content-length' && name !== 'connection') headerLines.push(`${name}: ${value}`)
  })
  headerLines.push(`content-length: ${body.byteLength}`, 'connection: close')
  socket.end(Buffer.concat([Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`), body]))
}

export async function startHttpServer<TData>(options: HttpServerOptions<TData>): Promise<HttpServerHandle> {
  const server = serve({
    port: options.port,
    hostname: options.hostname,
    silent: true,
    // Signal handling belongs to the entry point (it flushes collab docs first).
    gracefulShutdown: false,
    node: { requestTimeout: 0 },
    fetch: (req) => {
      const clientAddress = (req as Request & { ip?: string }).ip ?? null
      return options.fetch(req, { clientAddress })
    },
  })
  await server.ready()
  const nodeServer = server.node?.server as NodeHttpServer | undefined
  if (!nodeServer) throw new Error('[server] srvx did not expose the Node HTTP server')

  const topics = new TopicRegistry()
  const upgradeRoute = options.upgrade
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let webSocketServer: WebSocketServer | null = null

  if (upgradeRoute) {
    const route = upgradeRoute
    const handlers = route.handlers
    const sockets = new WebSocketServer({ noServer: true, maxPayload: handlers.maxPayloadLength })
    webSocketServer = sockets
    const alive = new WeakSet<WebSocket>()

    nodeServer.on('upgrade', (nodeReq: IncomingMessage, rawSocket: Duplex, head: Buffer) => {
      const pathname = new URL(nodeReq.url ?? '/', 'http://localhost').pathname
      if (pathname !== route.path) {
        rawSocket.destroy()
        return
      }
      const req = new NodeRequest({ req: nodeReq })
      const clientAddress = nodeReq.socket.remoteAddress ?? null
      route
        .authorize(req, { clientAddress })
        .then(async (verdict) => {
          if (verdict instanceof Response) {
            await rejectUpgrade(rawSocket, verdict)
            return
          }
          sockets.handleUpgrade(nodeReq, rawSocket, head, (webSocket) => {
            const subscribedTopics = new Set<string>()
            const socket: RealtimeSocket<TData> = {
              data: verdict.accept,
              send: (payload) => webSocket.send(payload, { binary: true }),
              subscribe: (topic) => {
                subscribedTopics.add(topic)
                topics.subscribe(topic, webSocket)
              },
              unsubscribe: (topic) => {
                subscribedTopics.delete(topic)
                topics.unsubscribe(topic, webSocket)
              },
            }
            alive.add(webSocket)
            webSocket.on('pong', () => alive.add(webSocket))
            webSocket.on('message', (raw, isBinary) => {
              void handlers.message(socket, normalizeRawData(raw, isBinary))
            })
            webSocket.on('close', () => {
              topics.unsubscribeAll(webSocket, subscribedTopics)
              subscribedTopics.clear()
              handlers.close(socket)
            })
            webSocket.on('error', (err) => {
              console.error('[server] websocket error:', err)
            })
            handlers.open(socket)
          })
        })
        .catch((err: unknown) => {
          console.error('[server] websocket upgrade failed:', err)
          rawSocket.destroy()
        })
    })

    heartbeat = setInterval(() => {
      for (const webSocket of sockets.clients) {
        if (!alive.has(webSocket)) {
          webSocket.terminate()
          continue
        }
        alive.delete(webSocket)
        webSocket.ping()
      }
    }, SOCKET_HEARTBEAT_MS)
    heartbeat.unref()
  }

  const address = nodeServer.address()
  const port = typeof address === 'object' && address ? address.port : options.port

  return {
    port,
    publish: (topic, payload) => topics.publish(topic, payload),
    async stop() {
      if (heartbeat) clearInterval(heartbeat)
      if (webSocketServer) {
        for (const webSocket of webSocketServer.clients) webSocket.terminate()
        webSocketServer.close()
      }
      await server.close(true)
    },
  }
}
