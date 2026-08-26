/* uneffect:
 * state active: int
 * state starts: int
 * state reconciles: int
 * init active = 0
 * init starts = 0
 * init reconciles = 0
 * action reconcile: active' = active < 5 ? active + 2 * ((5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0)) : active, starts' = starts + (active < 5 ? 2 * ((5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0)) : 0), reconciles' = reconciles + 1
 */

export interface WorkerPool {
  active: number;
  starts: number;
  reconciles: number;
}

/* uneffect: refinement workerPool@1 create */
export function createWorkerPool(initial: WorkerPool): WorkerPool {
  return initial;
}

/* uneffect: refinement workerPool@1 observe */
export function observeWorkerPool(pool: WorkerPool): WorkerPool {
  return pool;
}

/* uneffect: refinement workerPool@1 action reconcile */
export function reconcileWorkerPool(pool: WorkerPool): void {
  // Provisioning occurs in pairs, so reconciling to a minimum of five workers
  // may finish at five or six. External process creation is a separate effect.
  while (pool.active < 5) {
    pool.active += 2;
    pool.starts += 2;
  }
  pool.reconciles++;
}
