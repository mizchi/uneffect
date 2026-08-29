import { readFile, writeFile } from "node:fs/promises";

export async function synchronizeState(path: string, endpoint: string): Promise<void> {
  const current = await readFile(path, "utf8");
  const response = await fetch(endpoint);
  await fetch(endpoint, { method: "PUT", body: current });
  await writeFile(path, await response.text());
}
