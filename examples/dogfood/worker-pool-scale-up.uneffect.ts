import { defineRefinement } from "@mizchi/uneffect/spec";
import { createWorkerPool, observeWorkerPool, reconcileWorkerPool } from "./worker-pool-scale-up.js";

export default defineRefinement({
  name: "workerPool",
  version: "1",
  create: createWorkerPool,
  observe: observeWorkerPool,
  abstractions: {},
  actions: {
    "reconcile": reconcileWorkerPool,
  },
  invariants: {},
});
