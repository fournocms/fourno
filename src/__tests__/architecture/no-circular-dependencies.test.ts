import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../../..')
const MADGE_CLI = join(ROOT, 'node_modules/madge/bin/cli.js')

describe('Circular dependencies', () => {
  it('keeps the tsconfig-aware source graph cycle-free', () => {
    const result = spawnSync(
      process.execPath,
      [MADGE_CLI, '--circular', '--ts-config', 'tsconfig.json', '--extensions', 'ts,tsx', 'src', 'server'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    const output = `${result.stdout}${result.stderr}`
    if (result.status !== 0) {
      throw new Error(
        `Circular dependencies found. Run the same command locally for the full graph:\n` +
          `pnpm exec madge --circular --ts-config tsconfig.json --extensions ts,tsx src server\n\n` +
          output,
      )
    }

    expect(output).toContain('No circular dependency found')
  }, 60_000) // madge parses all ~2800 source files; ~15 s on Node under load
})
