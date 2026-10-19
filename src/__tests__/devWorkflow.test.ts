import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { tscCommand, tsxCommand, viteCommand } from '../../scripts/lib/nodeCommand'

const root = new URL('../../', import.meta.url)

function readSiteFile(path: string) {
  return readFileSync(new URL(path, root), 'utf-8')
}

describe('development workflow', () => {
  it('`pnpm dev` is the one-command launcher for cms + vite', () => {
    const pkg = JSON.parse(readSiteFile('package.json')) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts['dev']).toBe('tsx scripts/dev.ts')
    expect(pkg.scripts['dev:agent']).toBe('pnpm run dev:server')
    expect(pkg.scripts['dev:server']).toBe('tsx watch server/index.ts')
    expect(pkg.scripts['dev:vite']).toBe('vite')
    expect(pkg.scripts['build']).toBe('tsc -b && vite build')
    expect(pkg.scripts['preview']).toBe('vite preview')
    expect(pkg.scripts['serve']).toBe('node --import tsx server/index.ts')
    expect(pkg.scripts['dev:all']).toBeUndefined()
    expect(existsSync(new URL('scripts/dev.ts', root))).toBe(true)
    expect(existsSync(new URL('scripts/dev-all.ts', root))).toBe(false)

    const script = readSiteFile('scripts/dev.ts')
    // Spawns cms + vite without a recursive `pnpm dev` call.
    expect(script).toContain("tsxCommand('watch', 'server/index.ts')")
    expect(script).toContain("viteCommand('--host', '127.0.0.1'")
    expect(script).not.toContain('command: `vite')
    expect(script).not.toContain('command.split')
    // Knows about the docker postgres host port.
    expect(script).toContain('127.0.0.1')
    expect(script).toContain('5433')
    // Manages the docker postgres + app containers.
    expect(script).toContain('compose')
    expect(script).toContain('postgres')
    expect(script).toContain('app')
    // Forwards signals to children.
    expect(script).toContain('SIGINT')
    expect(script).toContain('SIGTERM')
  })

  it('development launchers run local tool entrypoints through the running Node', () => {
    const devScript = readSiteFile('scripts/dev.ts')
    const e2eScript = readSiteFile('scripts/e2e-dev.ts')
    const startScript = readSiteFile('scripts/start.ts')

    // Spawning `tsx` / `vite` / `tsc` by name fails on Windows, where the bins
    // are `.cmd` shims; `[node, <entry>.js, ...]` works everywhere.
    for (const [command, entry] of [
      [tsxCommand('watch', 'server/index.ts'), '/node_modules/tsx/dist/cli.mjs'],
      [viteCommand('--host', '127.0.0.1'), '/node_modules/vite/bin/vite.js'],
      [tscCommand('-b'), '/node_modules/typescript/bin/tsc'],
    ] as const) {
      expect(command[0]).toBe(process.execPath)
      expect(command[1].replaceAll('\\', '/').endsWith(entry)).toBe(true)
      expect(existsSync(command[1])).toBe(true)
    }
    expect(viteCommand('--host', '127.0.0.1').slice(2)).toEqual(['--host', '127.0.0.1'])

    for (const script of [devScript, e2eScript]) {
      expect(script).toContain("viteCommand('--host', '127.0.0.1'")
      expect(script).not.toContain("['vite'")
      expect(script).not.toContain("['tsx'")
      expect(script).not.toContain("['bun'")
    }
    expect(e2eScript).toContain("tsxCommand('server/index.ts')")
    expect(startScript).toContain("tscCommand('-b')")
    expect(startScript).toContain("viteCommand('build')")
    expect(startScript).toContain("[process.execPath, '--import', 'tsx', 'server/index.ts']")
    expect(startScript).not.toContain("['bun'")
  })

  it('Vite proxies CMS API and uploaded media to the local CMS server', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    // `/admin/api` covers both the CMS endpoints (`/admin/api/cms/...`) and
    // the agent endpoints (`/admin/api/agent`, `/admin/api/agent/tool-result`).
    // The shared `/admin/` prefix is required so the session cookie (scoped
    // to `Path=/admin`) is sent on every request to the CMS backend.
    expect(viteConfig).toContain("'/admin/api'")
    expect(viteConfig).toContain("'/uploads'")
    expect(viteConfig).toContain("const CMS_DEV_SERVER_ORIGIN = `http://localhost:${process.env.PORT ?? '3001'}`")
    expect(viteConfig).toContain('target: CMS_DEV_SERVER_ORIGIN')
    expect(viteConfig).toContain('changeOrigin: true')
  })

  it('Vite forwards WebSocket upgrades, so the collab socket is same-origin in dev', () => {
    const viteConfig = readSiteFile('vite.config.ts')
    const devScript = readSiteFile('scripts/dev.ts')

    // The collab socket rides the same proxy as every other /admin/api
    // request, so the dev server is same-origin like production. No port is
    // dialled directly.
    expect(viteConfig).toMatch(/^\s*ws:\s*true/m)
    expect(viteConfig).not.toContain('VITE_CMS_DEV_PORT')

    // dev.ts must hand PORT to the Vite child so the proxy target cannot
    // drift from the CMS it started (both defaults happen to be 3001).
    expect(devScript).toContain('env: { PORT: String(CMS_PORT) }')
  })

  it('Vite forwards public page routes to the CMS server instead of the admin SPA', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    expect(viteConfig).toContain('function publicSiteDevProxyPlugin')
    expect(viteConfig).toContain('publicSiteDevProxyPlugin()')
    expect(viteConfig).toContain("pathname === '/admin'")
    expect(viteConfig).toContain("pathname.startsWith('/admin/')")
    expect(viteConfig).toContain("pathname === '/'")
    expect(viteConfig).toContain('proxyPublicSiteRequest')
  })

  it('Vite forwards published runtime assets to the CMS server in local dev', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    expect(viteConfig).toContain("pathname.startsWith('/_instatic/assets/')")
  })

  it('Docker Postgres uses a non-default host port for local dev', () => {
    const compose = readSiteFile('docker-compose.yml')

    // docker-compose.yml is dev-only and only exposes the Postgres container
    // on a non-default host port (5433) to avoid clashing with a local
    // Postgres install. The DATABASE_URL the app uses to reach the container
    // lives in compose.prod.yml — not in the dev-only compose file.
    expect(compose).toContain('"5433:5432"')
    expect(compose).toContain('image: postgres:16')
  })
})

describe('Node version guard wiring', () => {
  // The guard is worthless unless the server actually calls it, and it must
  // only warn: a direct install must keep serving on an unsupported Node.
  it('the server logs the unsupported-Node warning and boots anyway', () => {
    const src = readSiteFile('server/index.ts')
    expect(src).toContain('unsupportedNodeWarning(process.versions.node)')
    expect(src).toContain('console.warn(nodeWarning)')
  })
})
