import { spawnSync } from 'node:child_process'

/**
 * Run an ES-module TypeScript snippet in a fresh Node process (tsx loader,
 * repo root as cwd) — for assertions that must see the real server runtime
 * instead of the test process's ambient happy-dom globals.
 */
export function runTypeScriptSnippet(source: string): { exitCode: number; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}
