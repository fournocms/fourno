import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tsxCliPath = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const viteEntrypointPath = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url))
const tscEntrypointPath = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

/**
 * Local tool invocations as `[node, <entry>, ...args]`. Spawning the running
 * Node binary with the tool's JS entry works the same on every platform —
 * spawning `tsx` or `vite` by name fails on Windows, where the bins are
 * `.cmd` shims that need a shell.
 */
export function tsxCommand(...args: string[]): string[] {
  return [process.execPath, tsxCliPath, ...args]
}

export function viteCommand(...args: string[]): string[] {
  return [process.execPath, viteEntrypointPath, ...args]
}

export function tscCommand(...args: string[]): string[] {
  return [process.execPath, tscEntrypointPath, ...args]
}

interface RunOptions {
  stdio?: StdioOptions
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** Run a command to completion. Returns its exit code (1 when it could not start). */
export function runCommandSync(command: readonly string[], options: RunOptions = {}): number {
  const [executable, ...args] = command
  if (!executable) throw new Error('empty command')
  const result = spawnSync(executable, args, { stdio: options.stdio ?? 'ignore', env: options.env, cwd: options.cwd })
  return result.status ?? 1
}

/** Run a command to completion and capture its stdout. */
export function captureCommandSync(command: readonly string[]): { exitCode: number; stdout: string } {
  const [executable, ...args] = command
  if (!executable) throw new Error('empty command')
  const result = spawnSync(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '' }
}

/** Start a long-running child with inherited stdio. */
export function startChild(command: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const [executable, ...args] = command
  if (!executable) throw new Error('empty command')
  return spawn(executable, args, { env, stdio: 'inherit' })
}

/** Resolves with the child's exit code once it exits (signals map to 1). */
export function childExited(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode)
      return
    }
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}
