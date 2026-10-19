/**
 * The runtime version guard.
 *
 * Nothing at runtime enforces `engines.node`, so the server checks
 * `process.versions.node` itself and warns (a direct install must keep
 * serving across a version skew).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SUPPORTED_NODE_RANGE, unsupportedNodeWarning } from '../../../server/nodeVersion'

describe('Node version guard', () => {
  it('the server constant mirrors engines.node in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string } }
    expect(SUPPORTED_NODE_RANGE).toBe(pkg.engines.node)
  })

  it('stays quiet on a supported Node and warns outside the range', () => {
    expect(unsupportedNodeWarning('24.11.0')).toBeNull()
    expect(unsupportedNodeWarning('26.7.0')).toBeNull()
    const old = unsupportedNodeWarning('22.12.0')
    expect(old).toContain('Node 22.12.0')
    expect(old).toContain(SUPPORTED_NODE_RANGE)
  })

  it('the running Node is a supported one', () => {
    expect(unsupportedNodeWarning(process.versions.node)).toBeNull()
  })
})
