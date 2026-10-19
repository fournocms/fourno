import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SiteDependencyLock } from '@core/site-runtime'
import { isPublicNpmRegistry, npmRegistryUrl } from '../../registry/config'

export interface RuntimeDependencyCache {
  hash: string
  workspaceDir: string
  nodeModulesDir: string
}

interface RuntimeInstallOptions {
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export type RuntimeInstallRunner = (
  command: string[],
  options: RuntimeInstallOptions,
) => Promise<void>

interface EnsureRuntimeDependencyCacheOptions {
  cacheRoot?: string
  /** The npm invocation prefix (`[node, npm-cli.js]`); defaults to the npm bundled with this Node. */
  npmCommand?: string[]
  runInstall?: RuntimeInstallRunner
  /** Override the install timeout (ms). Mainly for tests. */
  installTimeoutMs?: number
  /** Override the package-count cap. Mainly for tests. */
  maxPackages?: number
}

/**
 * Sentinel file written inside the workspace dir AFTER a successful install.
 * The cache is considered valid only when this file exists — `existsSync` on
 * the bare `node_modules/` directory is unreliable because a partial install
 * (interrupted child process, watcher reload, pipe deadlock) can leave the
 * directory created but only sparsely populated.
 */
const INSTALL_SENTINEL_FILE = '.fourno-install-complete'

/**
 * Hard upper bound on packages declared in a single dependency lock. A site
 * needing more than this is almost certainly a misconfiguration or an attempt
 * to exhaust install capacity. The cap is generous for legitimate sites
 * (sites typically use 1–20 runtime packages).
 */
const DEFAULT_MAX_RUNTIME_PACKAGES = 100

/**
 * Hard upper bound on the time a single `npm install` invocation may run.
 * Without this, a stuck registry lookup or hung child process pins the request
 * and ties up server capacity indefinitely.
 */
const DEFAULT_INSTALL_TIMEOUT_MS = 60_000

function sortedExactDependencies(lock: SiteDependencyLock): Record<string, string> {
  return Object.fromEntries(
    Object.values(lock.packages)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((dependency) => [dependency.name, dependency.version]),
  )
}

export function runtimeDependencyLockHash(lock: SiteDependencyLock): string {
  const exactDependencies = sortedExactDependencies(lock)
  const payload = JSON.stringify(exactDependencies)
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// On-disk cache layout — the single owner of the cache path contract.
//
// The writer (`performInstall`) and every reader (`packageServer.ts`,
// `packageImportmap.ts`) MUST derive paths through these accessors. Changing
// the env var, the `deps/` segment, the node_modules location, or the sentinel
// filename here updates writer and readers together — they can never disagree.
// ---------------------------------------------------------------------------

/** Root of the runtime dependency cache. Overridable via `RUNTIME_CACHE_DIR`. */
export function cacheRootDir(): string {
  return resolve(process.env.RUNTIME_CACHE_DIR || join(tmpdir(), 'fourno-runtime-cache'))
}

/** Directory holding all per-hash workspaces under a cache root. */
function depsDir(cacheRoot: string): string {
  return join(cacheRoot, 'deps')
}

/** Content-addressed workspace dir for a given lock hash. */
export function workspaceDirForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(depsDir(cacheRoot), hash)
}

/** Installed-packages dir for a given lock hash. */
export function nodeModulesDirForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(workspaceDirForHash(hash, cacheRoot), 'node_modules')
}

/** Path to the install-complete sentinel for a given lock hash. */
export function sentinelPathForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(workspaceDirForHash(hash, cacheRoot), INSTALL_SENTINEL_FILE)
}

/**
 * The npm that ships with the running Node, invoked through `node npm-cli.js`
 * so no shell (and no `npm.cmd` on Windows) is involved. Official Node
 * installs and images place it at `<prefix>/lib/node_modules/npm` (POSIX) or
 * next to `node.exe` (Windows); anything else falls back to `npm` on PATH.
 */
function bundledNpmCommand(): string[] {
  const nodeDir = dirname(process.execPath)
  const candidates = process.platform === 'win32'
    ? [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const npmCli = candidates.find((candidate) => existsSync(candidate))
  return npmCli ? [process.execPath, npmCli] : ['npm']
}

async function defaultRunInstall(command: string[], options: RuntimeInstallOptions): Promise<void> {
  const [executable, ...args] = command
  if (!executable) throw new Error('[runtime dependency cache] empty install command')
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Honor an external abort (used to enforce the install timeout). Killing
  // the child makes it exit with a signal, which we surface as a clean error
  // message below.
  const onAbort = () => {
    child.kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // Drain stdout/stderr while waiting for exit. Without this, a noisy child
    // process can fill the pipe buffer and block waiting for someone to read
    // it — never reaching the exit syscall — which would leave us with a
    // partially extracted node_modules/ tree.
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', (code) => resolveExit(code))
    })
    if (exitCode === 0) return

    if (options.signal?.aborted) {
      throw new Error('[runtime dependency cache] install timed out')
    }
    const stderrText = Buffer.concat(stderrChunks).toString('utf8')
    const stdoutText = Buffer.concat(stdoutChunks).toString('utf8')
    throw new Error(
      `[runtime dependency cache] install failed (${exitCode}): ${stderrText || stdoutText}`,
    )
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function tempWorkspaceDir(cacheRoot: string, hash: string): string {
  // Process pid + random suffix avoids collisions between concurrent server
  // requests racing to populate the same lock hash. See INSTALL_SENTINEL_FILE
  // comment for why a fixed-name workspace dir was unsafe.
  const random = randomBytes(6).toString('hex')
  return join(depsDir(cacheRoot), `.tmp-${hash}-${process.pid}-${random}`)
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * In-process map of installs currently running, keyed by lock hash. Two
 * concurrent requests for the same dependency set share the same install
 * promise instead of each spawning their own child process — important for
 * preview, where many incremental edits can fan out into duplicate builds.
 */
const inFlightInstalls = new Map<string, Promise<RuntimeDependencyCache>>()

async function performInstall(
  lock: SiteDependencyLock,
  options: EnsureRuntimeDependencyCacheOptions,
): Promise<RuntimeDependencyCache> {
  const hash = runtimeDependencyLockHash(lock)
  const cacheRoot = options.cacheRoot ?? cacheRootDir()
  const workspaceDir = workspaceDirForHash(hash, cacheRoot)
  const nodeModulesDir = nodeModulesDirForHash(hash, cacheRoot)
  const sentinelPath = sentinelPathForHash(hash, cacheRoot)

  // Fast path: cache is intact — install completed and the sentinel marker
  // proves it.
  if (existsSync(sentinelPath)) {
    return { hash, workspaceDir, nodeModulesDir }
  }

  // Slow path: install atomically. We materialize the workspace into a temp
  // sibling dir, run `npm install`, write the sentinel marker, and only then
  // rename the temp dir into its final hash-based slot. A partial install
  // therefore never appears as a valid cache entry — the next request will
  // simply re-attempt the install.
  const exactDependencies = sortedExactDependencies(lock)
  const maxPackages = options.maxPackages ?? DEFAULT_MAX_RUNTIME_PACKAGES
  if (Object.keys(exactDependencies).length > maxPackages) {
    throw new Error(
      `[runtime dependency cache] too many runtime packages (${Object.keys(exactDependencies).length}); max is ${maxPackages}`,
    )
  }

  const tempDir = tempWorkspaceDir(cacheRoot, hash)

  await mkdir(tempDir, { recursive: true })

  try {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      private: true,
      name: `fourno-runtime-${hash}`,
      version: '0.0.0',
      type: 'module',
      dependencies: exactDependencies,
    }, null, 2), 'utf8')

    const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), installTimeoutMs)
    try {
      // Lifecycle scripts never run: `--ignore-scripts` plus the matching
      // config env var, so a nested npm invocation inherits the refusal too.
      const command = [
        ...(options.npmCommand ?? bundledNpmCommand()),
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
      ]
      // The same registry the resolver read metadata from — a private mirror
      // configured through NPM_REGISTRY_URL must also serve the tarballs.
      const registryUrl = npmRegistryUrl()
      await (options.runInstall ?? defaultRunInstall)(command, {
        cwd: tempDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          npm_config_ignore_scripts: 'true',
          ...(isPublicNpmRegistry(registryUrl) ? {} : { npm_config_registry: registryUrl }),
        },
        signal: abort.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // Sentinel goes inside the temp dir at the location it will live after the
    // rename, so the renamed directory is already a "valid" cache from the
    // first instant it is observable at the final path.
    await writeFile(join(tempDir, INSTALL_SENTINEL_FILE), JSON.stringify({
      hash,
      completedAt: Date.now(),
      packageCount: Object.keys(exactDependencies).length,
    }), 'utf8')

    try {
      await rename(tempDir, workspaceDir)
    } catch {
      // Rename failed — most likely because the target already exists. Two
      // sub-cases:
      //   1. Another process won the race and produced a valid cache. Drop
      //      our temp and use theirs.
      //   2. The target is a stale broken cache (no sentinel). Remove it and
      //      retry once.
      if (existsSync(sentinelPath)) {
        await removeIfExists(tempDir)
      } else {
        await removeIfExists(workspaceDir)
        await rename(tempDir, workspaceDir)
      }
    }
  } catch (err) {
    await removeIfExists(tempDir)
    throw err
  }

  return { hash, workspaceDir, nodeModulesDir }
}

export async function ensureRuntimeDependencyCache(
  lock: SiteDependencyLock,
  options: EnsureRuntimeDependencyCacheOptions = {},
): Promise<RuntimeDependencyCache> {
  const hash = runtimeDependencyLockHash(lock)

  // Concurrency dedupe: if a request for this exact lock is already running,
  // join it instead of spawning a duplicate `npm install`. This collapses the
  // thundering-herd that happens when several preview rebuilds queue up
  // before the first install completes.
  const existing = inFlightInstalls.get(hash)
  if (existing) return existing

  const promise = performInstall(lock, options)
  inFlightInstalls.set(hash, promise)
  try {
    return await promise
  } finally {
    inFlightInstalls.delete(hash)
  }
}
