import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetch as undiciFetch, type Dispatcher } from 'undici'
import {
  createPinnedDispatcher,
  performGatedFetch,
  isBlockedAddress,
} from '../../../server/plugins/host/network'
import type { HostPluginRecord } from '../../../server/plugins/host/types'

/**
 * SSRF hardening for the gated plugin fetch (ISS-004, ISS-005, ISS-010, ISS-011).
 *
 * `performGatedFetch` is the single kernel-of-correctness for plugin outbound
 * network access. It must:
 *  - block any target (initial OR redirect) that resolves to a private,
 *    loopback, link-local, CGNAT or unique-local address — even when the
 *    hostname is allowlisted (DNS rebinding / cloud-metadata),
 *  - follow redirects manually and re-apply the allowlist + IP guard to every
 *    hop (no transparent redirect following),
 *  - cap the redirect chain.
 */

function makeEntry(allowlist: string[]): HostPluginRecord {
  return {
    manifest: { id: 'test.plugin', networkAllowedHosts: allowlist },
    inflightFetches: new Map(),
  } as unknown as HostPluginRecord
}

const PUBLIC_IP = '93.184.216.34'

/**
 * A fetch stub driven by a scripted sequence of responses keyed by URL. The
 * guard keeps the hostname in the URL and pins the connection through an
 * undici `dispatcher` in the init, so the stub sees the logical URL as-is.
 */
function scriptedFetch(script: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const called = typeof input === 'string' ? input : input.toString()
    const entry = script[called]
    if (!entry) throw new Error(`unexpected fetch to ${called}`)
    return typeof entry === 'function' ? entry() : entry
  }) as unknown as typeof fetch
}

function resolver(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host: string) => map[host] ?? [PUBLIC_IP]
}

describe('isBlockedAddress', () => {
  test('blocks loopback, private, link-local, CGNAT, ULA and mapped forms', () => {
    for (const ip of [
      '127.0.0.1', '127.5.5.5', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })
  test('allows ordinary public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })
  // GHSA-99x9: non-canonical spellings of loopback. GHSA-ffj5: IPv6 transition
  // prefixes (NAT64 / 6to4 / Teredo) that embed an internal IPv4. The prior
  // string / prefix matcher missed all of these; parsing to a canonical range
  // catches them.
  test('blocks non-canonical loopback and IPv6 transition addresses', () => {
    for (const ip of [
      '::0:1', '0::1', '0:0::1', '::00:1',
      '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })
})

describe('performGatedFetch — SSRF guards', () => {
  test('fetches an allowlisted public host', async () => {
    const res = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      {},
      {
        fetchImpl: scriptedFetch({ 'https://api.example.com/data': new Response('OK', { status: 200 }) }),
        resolveHostAddresses: resolver({ 'api.example.com': [PUBLIC_IP] }),
      },
    )
    expect(res.body).toBe('OK')
    expect(res.status).toBe(200)
  })

  // GHSA-c76p / GHSA-r4rj: the check resolved the host, but the connect
  // re-resolved it, so a rebinding DNS could swing the socket to an internal IP
  // between the two. The guard now pins the connection to the checked IP.
  test('pins the connection to the validated IP, defeating DNS rebinding', async () => {
    let fetchedUrl = ''
    let fetchedDispatcher: Dispatcher | undefined
    const fetchImpl = (async (input: string | URL, init?: RequestInit & { dispatcher?: Dispatcher }) => {
      fetchedUrl = String(input)
      fetchedDispatcher = init?.dispatcher
      return new Response('OK', { status: 200 })
    }) as unknown as typeof fetch

    // A rebinding resolver hands a metadata IP on any SECOND lookup. With
    // pinning there is no second lookup, so the first (public) result is used.
    let calls = 0
    const rebinding = async () => (++calls === 1 ? [PUBLIC_IP] : ['169.254.169.254'])

    const res = await performGatedFetch(
      makeEntry(['rebind.example.com']),
      'https://rebind.example.com/x',
      {},
      { fetchImpl, resolveHostAddresses: rebinding },
    )

    expect(res.status).toBe(200)
    // The URL keeps its hostname, so Host, TLS SNI and certificate identity
    // all still target the host; the pin lives in the dispatcher.
    expect(fetchedUrl).toBe('https://rebind.example.com/x')
    expect(fetchedDispatcher).toBeDefined()
    expect(calls).toBe(1) // resolved exactly once, no re-resolution to rebind
    await fetchedDispatcher?.close()
  })

  test('the pinned dispatcher connects to the pinned IP whatever the hostname resolves to', async () => {
    const seenHostHeaders: string[] = []
    const server = createServer((req, res) => {
      seenHostHeaders.push(req.headers.host ?? '')
      res.end('pinned')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    // `.invalid` never resolves (RFC 6761), so only the pin can route this.
    const url = `http://pinned-host.invalid:${port}/probe`
    const dispatcher = createPinnedDispatcher('127.0.0.1')
    try {
      const res = await undiciFetch(url, { dispatcher })
      expect(await res.text()).toBe('pinned')
      expect(seenHostHeaders).toEqual([`pinned-host.invalid:${port}`])
      await expect(undiciFetch(url)).rejects.toThrow()
    } finally {
      await dispatcher.close()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('rejects an allowlisted host that resolves to a private IP (DNS rebinding)', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['internal.example.com']),
        'https://internal.example.com/',
        {},
        {
          fetchImpl: scriptedFetch({}),
          resolveHostAddresses: resolver({ 'internal.example.com': ['10.0.0.5'] }),
        },
      ),
    ).rejects.toThrow(/blocked|private|resolves/i)
  })

  test('rejects a redirect to a non-allowlisted host', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['api.example.com']),
        'https://api.example.com/start',
        {},
        {
          fetchImpl: scriptedFetch({
            'https://api.example.com/start': new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example.org/' },
            }),
          }),
          resolveHostAddresses: resolver({ 'api.example.com': [PUBLIC_IP] }),
        },
      ),
    ).rejects.toThrow(/allowlist/i)
  })

  test('rejects a redirect to an allowlisted host that resolves to metadata IP', async () => {
    await expect(
      performGatedFetch(
        makeEntry(['api.example.com', 'metadata.example.com']),
        'https://api.example.com/start',
        {},
        {
          fetchImpl: scriptedFetch({
            'https://api.example.com/start': new Response(null, {
              status: 302,
              headers: { location: 'https://metadata.example.com/latest/meta-data/' },
            }),
          }),
          resolveHostAddresses: resolver({
            'api.example.com': [PUBLIC_IP],
            'metadata.example.com': ['169.254.169.254'],
          }),
        },
      ),
    ).rejects.toThrow(/blocked|private|resolves/i)
  })

  test('follows a redirect to an allowlisted public host', async () => {
    const res = await performGatedFetch(
      makeEntry(['a.example.com', 'b.example.com']),
      'https://a.example.com/start',
      {},
      {
        fetchImpl: scriptedFetch({
          'https://a.example.com/start': new Response(null, {
            status: 302,
            headers: { location: 'https://b.example.com/final' },
          }),
          'https://b.example.com/final': new Response('LANDED', { status: 200 }),
        }),
        resolveHostAddresses: resolver({ 'a.example.com': [PUBLIC_IP], 'b.example.com': [PUBLIC_IP] }),
      },
    )
    expect(res.body).toBe('LANDED')
  })

  test('caps the redirect chain', async () => {
    // Every hop redirects to the next within the same allowlisted host.
    const fetchImpl = (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const n = Number(new URL(url).searchParams.get('n') ?? '0')
      return new Response(null, { status: 302, headers: { location: `https://loop.example.com/?n=${n + 1}` } })
    }) as unknown as typeof fetch
    await expect(
      performGatedFetch(
        makeEntry(['loop.example.com']),
        'https://loop.example.com/?n=0',
        {},
        { fetchImpl, resolveHostAddresses: resolver({ 'loop.example.com': [PUBLIC_IP] }) },
      ),
    ).rejects.toThrow(/redirect/i)
  })
})

describe('network.ts source invariant', () => {
  test('uses manual redirect handling (never transparent following)', () => {
    const src = readFileSync(new URL('../../../server/plugins/host/network.ts', import.meta.url), 'utf8')
    expect(src).toContain("redirect: 'manual'")
  })
})
