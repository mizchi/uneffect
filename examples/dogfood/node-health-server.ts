import { createServer } from "node:http";

/* uneffect: effect Net<"127.0.0.1:8080"> | Console */
export function startHealthServer(): void {
  const server = createServer((request, response) => {
    console.log(request.method, request.url);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  server.listen(8080, "127.0.0.1", () => console.log("health server ready"));
}
