import { cpus, hostname, release, totalmem } from "node:os";

export interface RuntimeMetadata {
  hostname: string;
  osRelease: string;
  cpuCount: number;
  totalMemory: number;
}

/* uneffect:capability effect Sys<hostname | osRelease | cpus | systemMemoryInfo> */
export function collectRuntimeMetadata(): RuntimeMetadata {
  return {
    hostname: hostname(),
    osRelease: release(),
    cpuCount: cpus().length,
    totalMemory: totalmem(),
  };
}
