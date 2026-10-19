import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

describe('server css module stub', () => {
  it('lets a plain Node process import a CSS module as a class-name map', () => {
    const probe = [
      "const styles = (await import('./src/ui/components/CanvasModulePlaceholder/CanvasModulePlaceholder.module.css')).default",
      'process.stdout.write(styles.placeholder)',
    ].join('\n')
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', './server/runtime/cssModuleStub.ts', '--input-type=module', '-e', probe],
      { encoding: 'utf8' },
    )

    expect(result.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION')
    expect(result.stdout).toBe('placeholder')
  })

  it('is the first import of the server entry, ahead of every module that can reach src/', () => {
    const entry = readFileSync('server/index.ts', 'utf8')

    expect(entry.split('\n')[0]).toBe("import './runtime/cssModuleStub'")
  })
})
