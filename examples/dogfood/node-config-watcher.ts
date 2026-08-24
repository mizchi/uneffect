import { watch } from "node:fs";

/* uneffect: effect FsRead<"config.json"> | Console */
export function reportConfigChanges(): void {
  watch("config.json", (eventType) => {
    console.log("config changed", eventType);
  });
}
