import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});

/* uneffect: effect Net<"127.0.0.1:8080"> | Console */
export function startHealthServer(): void {
  server.listen(8080, "127.0.0.1", () => console.log("health server ready"));
}
