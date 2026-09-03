export const answer = 42 as const;

import { readText } from "./fs-bridge.js";

export async function load(path: string): Promise<string> {
  console.log(path);
  await fetch("https://example.com/status");
  return readText(path, "utf8");
}

const request = fetch;
export const loadAliased = (): Promise<Response> => request("https://example.com/aliased");

export function shadowed(console: { log(value: string): void }, fetch: (url: string) => void): void {
  console.log("local");
  fetch("local");
}
