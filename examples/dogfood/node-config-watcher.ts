import { readFile, watch } from "node:fs";

/* uneffect:effect FsRead<"config.json"> | Console */
export function reportConfigChanges(): void {
  watch("config.json", (eventType) => {
    readFile("config.json", "utf8", (error, contents) => {
      console.log("config changed", eventType, error?.message ?? contents.length);
    });
  });
}

/* uneffect:effect FsRead<"config.json"> */
export function probeConfigWatcherLifecycle(): void {
  const watcher = watch("config.json", () => undefined);
  watcher.close();
}
