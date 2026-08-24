import type { Socket } from "node:net";

/* uneffect: effect Net<"api.example.com:443"> | Timer */
export function reconnectUpstream(socket: Socket, onReady: () => void): Socket {
  return socket.connect({ host: "api.example.com", port: 443 }, () => {
    queueMicrotask(onReady);
  });
}
