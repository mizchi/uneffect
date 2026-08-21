import { readFile } from "node:fs/promises";

/* uneffect: effect FsRead<"$CWD/config/app.json"> | Console */
export async function main() {
  const config = JSON.parse(await readFile("$CWD/config/app.json", "utf8")) as { endpoint: string };
  console.log(`endpoint=${config.endpoint}`);
}
