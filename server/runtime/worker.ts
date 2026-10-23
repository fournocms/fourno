/**
 * Worker-thread adapter — the host side of every CPU / crash-isolation
 * worker the server spawns (plugin sandbox workers, image-variant workers).
 *
 * Wraps `node:worker_threads` behind the small surface the pools need:
 * post a message (with optional transferables), receive messages, learn
 * about a crash, terminate. The worker side lives in `./workerPort.ts`.
 *
 * Worker entries are TypeScript files. When the host process itself runs
 * TypeScript through tsx (`tsx server/index.ts`, `node --import tsx …`) the
 * worker inherits that loader via `execArgv`. Anywhere else (the Vitest
 * runner, which transforms TS in-process without a Node loader), the worker
 * is started with `--import tsx` so its entry and the project path aliases
 * resolve the same way.
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

export interface WorkerHandle {
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void
  terminate(): void
}

export interface SpawnWorkerOptions {
  onMessage(message: unknown): void
  /** Uncaught exception inside the worker, or a non-zero exit. */
  onCrash(reason: string): void
}

function workerExecArgv(entry: URL): string[] | undefined {
  if (!fileURLToPath(entry).endsWith('.ts')) return undefined
  const inheritsTsLoader = process.execArgv.some((arg) => arg.includes('tsx'))
  return inheritsTsLoader ? undefined : [...process.execArgv, '--import', 'tsx']
}

export function spawnWorker(entry: URL, options: SpawnWorkerOptions): WorkerHandle {
  const worker = new Worker(entry, { execArgv: workerExecArgv(entry) })
  let crashed = false
  const reportCrash = (reason: string): void => {
    if (crashed) return
    crashed = true
    options.onCrash(reason)
  }
  let terminating = false
  worker.on('message', (message: unknown) => options.onMessage(message))
  worker.on('error', (err: Error) => reportCrash(err.message))
  worker.on('messageerror', (err: Error) => reportCrash(`unserializable message: ${err.message}`))
  worker.on('exit', (exitCode: number) => {
    if (!terminating && exitCode !== 0) reportCrash(`worker exited with code ${exitCode}`)
  })
  return {
    postMessage(message, transfer) {
      worker.postMessage(message, transfer ? [...transfer] : undefined)
    },
    terminate() {
      terminating = true
      void worker.terminate()
    },
  }
}
