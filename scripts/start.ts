/**
 * One-command production-mode runner for local use.
 *
 * `pnpm start` does what a single deploy would do, but in your dev
 * tree against your dev data:
 *
 *   1. Builds the admin SPA (`tsc -b && vite build` → `./dist/`).
 *   2. Frees port 3001 — if anything is already listening it prompts
 *      whether to kill the holder and take over (same UX as `pnpm dev`).
 *   3. Spawns the server (`node --import tsx server/index.ts`) — no watch, no
 *      Vite, the built SPA served from `./dist`.
 *
 * Defaults map to "production mode on the dev DB":
 *   PORT=3001
 *   DATABASE_URL=sqlite:./.tmp/dev.db (server/config.ts default)
 *   STATIC_DIR=./dist
 *   UPLOADS_DIR=./uploads
 *
 * Override any of these via env (`PORT=4000 pnpm start`, etc.).
 */

import { childExited, runCommandSync, startChild, tscCommand, viteCommand } from './lib/nodeCommand'
import { ensurePortFree } from './lib/freePort'

const CMS_PORT = Number(process.env.PORT ?? '3001')

function log(msg: string): void {
  console.error(`[start] ${msg}`)
}

function runStep(name: string, command: string[]): void {
  log(`${name}...`)
  const exitCode = runCommandSync(command, { stdio: 'inherit' })
  if (exitCode !== 0) {
    log(`${name} failed (exit ${exitCode}). Aborting.`)
    process.exit(exitCode)
  }
}

// --- build ---------------------------------------------------------------

runStep('Type-checking (tsc -b)', tscCommand('-b'))
runStep('Building admin SPA (vite build)', viteCommand('build'))

// --- port pre-flight -----------------------------------------------------

await ensurePortFree(CMS_PORT, 'cms', log)

// --- spawn server --------------------------------------------------------

log('')
log(`Starting server on http://localhost:${CMS_PORT}`)
log('')

const child = startChild([process.execPath, '--import', 'tsx', 'server/index.ts'], {
  ...process.env,
  PORT: String(CMS_PORT),
})

let shuttingDown = false
function forward(signal: NodeJS.Signals): void {
  shuttingDown = true
  if (child.exitCode === null) child.kill(signal)
}

process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

const code = await childExited(child)
if (!shuttingDown && code !== 0) {
  log(`server exited with code ${code}`)
}
process.exit(code ?? 0)
