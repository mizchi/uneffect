// Derived from Workhub archive/search/report writer modules at
// revision 089c385082644d30f4fceef88e41236b624a6b29.
import { access, appendFile, mkdir, readdir } from "node:fs/promises";

export async function updateArchive(directory: string, logPath: string): Promise<void> {
  await access(directory);
  const entries = await readdir(directory);
  await mkdir(directory, { recursive: true });
  await appendFile(logPath, `${entries.length}\n`, "utf8");
}
