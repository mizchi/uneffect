/* uneffect:capability module_effect none */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OwnershipGuardObligation } from "./async-safety.js";
import type { OwnershipEvidenceArtifact } from "./evidence.js";

export interface OwnershipEvidenceCacheEntry {
  fileName: string;
  key: string;
  obligation: OwnershipGuardObligation;
  artifact: OwnershipEvidenceArtifact;
}

export interface OwnershipEvidenceCache {
  schema: "ownership-evidence-cache/v1";
  entries: OwnershipEvidenceCacheEntry[];
}

/* uneffect:capability effect none */
export function ownershipEvidenceKey(fileName: string, obligation: OwnershipGuardObligation, occurrence = 0): string {
  return JSON.stringify([fileName, obligation.owner, obligation.callee, obligation.ownership, obligation.parameter, occurrence]);
}

/* uneffect:capability effect FsRead */
export function readOwnershipEvidenceCache(path: string): OwnershipEvidenceCache {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return { schema: "ownership-evidence-cache/v1", entries: [] };
    const candidate = value as Partial<OwnershipEvidenceCache>;
    if (candidate.schema !== "ownership-evidence-cache/v1" || !Array.isArray(candidate.entries)) return { schema: "ownership-evidence-cache/v1", entries: [] };
    return { schema: candidate.schema, entries: candidate.entries.filter((entry): entry is OwnershipEvidenceCacheEntry => Boolean(entry && typeof entry === "object" && typeof entry.key === "string" && entry.obligation && entry.artifact)) };
  } catch {
    return { schema: "ownership-evidence-cache/v1", entries: [] };
  }
}

/* uneffect:capability effect FsWrite */
export function writeOwnershipEvidenceCache(path: string, cache: OwnershipEvidenceCache): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
