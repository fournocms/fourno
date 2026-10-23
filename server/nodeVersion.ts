/**
 * Which Node this server is built and tested on, and what to say when it runs
 * on something else.
 *
 * The Docker image pins its Node through its base image. A direct install
 * (`pnpm serve` on the operator's machine or a Node host) uses whatever Node
 * is on PATH, and nothing at runtime enforces `engines.node`, so the range is
 * checked here at boot.
 *
 * `SUPPORTED_NODE_RANGE` duplicates `engines.node` from package.json on
 * purpose: `nodeVersion.test.ts` keeps the two identical.
 */
import { satisfies as semverSatisfies } from 'semver'

/** Mirrors `engines.node` in package.json (gated by `nodeVersion.test.ts`). */
export const SUPPORTED_NODE_RANGE = '>=24.11.0'

/**
 * The server keeps booting on an unsupported Node; a direct install must not
 * go down over a version skew. It logs this line once so the operator finds
 * the cause in the supervisor log, not by bisecting a bug.
 */
export function unsupportedNodeWarning(version: string): string | null {
  if (semverSatisfies(version, SUPPORTED_NODE_RANGE, { includePrerelease: true })) return null
  return (
    `[server] Node ${version} is outside the supported range ${SUPPORTED_NODE_RANGE}. ` +
    'Fourno starts anyway, but releases are built and tested inside that range; ' +
    'install a current Node LTS.'
  )
}
