/* uneffect:refinement_from "./worker-pool-scale-up.uneffect.ts#default" */
/* uneffect:state active: int */ /* uneffect:state starts: int */ /* uneffect:state reconciles: int */ /* uneffect:init active = 0 */ /* uneffect:init starts = 0 */ /* uneffect:init reconciles = 0 */ /* uneffect:action reconcile: active' = active < 5 ? active + 2 * ((5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0)) : active, starts' = starts + (active < 5 ? 2 * ((5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0)) : 0), reconciles' = reconciles + 1 */

export interface WorkerPool {
  active: number;
  starts: number;
  reconciles: number;
}

export function createWorkerPool(initial: WorkerPool): WorkerPool {
  return initial;
}

export function observeWorkerPool(pool: WorkerPool): WorkerPool {
  return pool;
}

export function reconcileWorkerPool(pool: WorkerPool): void {
  // Provisioning occurs in pairs, so reconciling to a minimum of five workers
  // may finish at five or six. External process creation is a separate effect.
  while (pool.active < 5) {
    pool.active += 2;
    pool.starts += 2;
  }
  pool.reconciles++;
}
