/**
 * Shared worker-host state.
 *
 * Kept below workerPool/apiDispatch so transport, crash recovery, and API
 * replies can share worker bookkeeping without importing each other.
 */

import type { WorkerHandle } from '../../runtime/worker'
import type { PendingRequest } from './types'

export const workers = new Map<string, WorkerHandle>()

/** Shared correlation map — values track which pluginId issued the request
 * so a worker crash can reject only that plugin's pending calls. */
export const pendingRequests = new Map<string, PendingRequest>()
