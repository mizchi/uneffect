import { resolve } from "node:path";
import { collectSyntaxFacts, type SyntaxFactExclusion, type SyntaxFacts } from "../oxc-syntax.js";
import type { CorsaApiFrontend, CorsaBuiltinCallResolution } from "./corsa-api-frontend.js";

export type CorsaBuiltinCallEntry = {
  readonly fileName: string;
  readonly start: number;
  readonly end: number;
} & ({ readonly status: "classified" } & CorsaBuiltinCallResolution | { readonly status: "unclassified" });

export interface CorsaBuiltinCallsResult {
  readonly schema: "uneffect-corsa-builtin-calls/v1";
  readonly corsaRevision: string;
  readonly entries: readonly CorsaBuiltinCallEntry[];
  readonly files: readonly {
    source: SyntaxFacts["source"];
    parser: SyntaxFacts["parser"];
    errors: readonly string[];
    exclusions: readonly SyntaxFactExclusion[];
  }[];
  readonly summary: { classified: number; unclassified: number; excluded: number; invalidFiles: number };
}

/** Classifications are a bounded builtin inventory, not a proof of effect freedom. */
export function analyzeCorsaBuiltinCalls(
  sources: ReadonlyMap<string, string>,
  corsa: Pick<CorsaApiFrontend, "rootFiles" | "compilerRevision" | "classifyBuiltinCalls">,
): CorsaBuiltinCallsResult {
  const roots = new Set(corsa.rootFiles.map(file => resolve(file)));
  const entries: CorsaBuiltinCallEntry[] = [];
  const files: CorsaBuiltinCallsResult["files"][number][] = [];
  const seen = new Set<string>();
  for (const [inputFile, sourceText] of sources) {
    const fileName = resolve(inputFile);
    if (!roots.has(fileName)) throw new Error(`Corsa project does not contain ${fileName}`);
    if (seen.has(fileName)) throw new Error(`Duplicate Corsa source ${fileName}`);
    seen.add(fileName);
    const syntax = collectSyntaxFacts(fileName, sourceText);
    const exclusions = syntax.coverage.find(item => item.domain === "call-sites")!.exclusions;
    files.push({ source: syntax.source, parser: syntax.parser, errors: syntax.errors, exclusions });
    if (syntax.errors.length > 0) continue;
    const sites = syntax.sites.filter(site => site.kind === "call");
    const operations = corsa.classifyBuiltinCalls(fileName, sites.map(site => ({
      calleePosition: site.calleePosition,
      ...(site.receiverPosition === undefined ? {} : { receiverPosition: site.receiverPosition }),
    })));
    if (operations.length !== sites.length) throw new Error(`Corsa classification count differs from call count for ${fileName}`);
    for (const [index, site] of sites.entries()) {
      const operation = operations[index];
      if (operation && operation.compilerRevision !== corsa.compilerRevision) throw new Error(`Corsa classification revision differs for ${fileName}`);
      entries.push({ fileName, start: site.start, end: site.end,
        ...(operation ? { ...operation, status: "classified" as const } : { status: "unclassified" as const }),
      });
    }
  }
  entries.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.start - b.start);
  files.sort((a, b) => a.source.fileName.localeCompare(b.source.fileName));
  return {
    schema: "uneffect-corsa-builtin-calls/v1", corsaRevision: corsa.compilerRevision, entries, files,
    summary: {
      classified: entries.filter(entry => entry.status === "classified").length,
      unclassified: entries.filter(entry => entry.status === "unclassified").length,
      excluded: files.reduce((count, file) => count + file.exclusions.length, 0),
      invalidFiles: files.filter(file => file.errors.length > 0).length,
    },
  };
}
