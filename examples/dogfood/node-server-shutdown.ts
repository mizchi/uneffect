import { createServer } from "node:http";

/** A request-triggered shutdown whose completion work is deferred to the close phase. */
/* uneffect:effect Net<"127.0.0.1:8081"> | Timer */
export function startShutdownServer(): void {
  const server = createServer((_request, response) => {
    response.end("shutting down");
    server.close(() => {
      queueMicrotask(() => undefined);
    });
  });
  server.listen(8081, "127.0.0.1");
}
