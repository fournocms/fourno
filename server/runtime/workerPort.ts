/**
 * Worker-thread adapter — the worker side. Imported only from worker entry
 * files (`pluginWorker.ts`, `imageVariantWorker.ts`); the host side is
 * `./worker.ts`.
 */
import { parentPort } from 'node:worker_threads'

function requireParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error('[worker] this module must run inside a worker thread')
  return parentPort
}

export function onHostMessage(listener: (message: unknown) => void): void {
  requireParentPort().on('message', listener)
}

export function postToHost(message: unknown, transfer?: readonly ArrayBuffer[]): void {
  requireParentPort().postMessage(message, transfer ? [...transfer] : undefined)
}
