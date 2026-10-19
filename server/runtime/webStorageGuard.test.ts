import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

describe('server web storage guard', () => {
  it('boots the Yjs dependency chain without the localStorage ExperimentalWarning', () => {
    const probe = "await import('lib0/storage'); process.stdout.write(typeof localStorage)"
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', './server/runtime/webStorageGuard.ts', '--input-type=module', '-e', probe],
      { encoding: 'utf8' },
    )

    expect(result.stderr).not.toContain('localStorage is not available')
    expect(result.stdout).toBe('undefined')
  })

  it('is imported by the server entry ahead of the collab relay', () => {
    const entry = readFileSync('server/index.ts', 'utf8')
    const guardIndex = entry.indexOf("import './runtime/webStorageGuard'")

    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(entry.indexOf("await import('./collab/relay')"))
  })
})
