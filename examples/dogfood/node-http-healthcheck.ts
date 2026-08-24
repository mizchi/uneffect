import { get } from "node:https";

/* uneffect: effect Net<"api.example.com:443"> | Timer */
export function checkHealth(report: (status: number | undefined) => void): void {
  get("https://api.example.com/v1/health", (response) => {
    queueMicrotask(() => report(response.statusCode));
  });
}
