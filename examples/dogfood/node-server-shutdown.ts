import type { Server } from "node:net";

/** A graceful shutdown boundary whose completion work is deferred to the close phase. */
/* uneffect: effect Timer */
export function closeServer(server: Server): void {
  server.close(() => {
    queueMicrotask(() => undefined);
  });
}
