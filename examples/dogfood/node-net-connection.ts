import { createConnection, type Socket } from "node:net";

/* uneffect:effect Net | Timer */
export function connectUpstream(host: string, port: number, onReady: () => void): Socket {
  return createConnection({ host, port }, () => {
    queueMicrotask(onReady);
  });
}
