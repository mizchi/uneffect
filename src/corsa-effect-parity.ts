import { resolve } from "node:path";
import ts from "@typescript/typescript6";
import type { CorsaApiFrontend, CorsaBuiltinOperation } from "./corsa-api-frontend.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";

export type CorsaEffectParityStatus = "agree" | "mismatch";

export interface CorsaEffectParityEntry {
  readonly fileName: string;
  readonly start: number;
  readonly end: number;
  readonly operation: CorsaBuiltinOperation;
  readonly status: CorsaEffectParityStatus;
  readonly typescript?: CorsaBuiltinOperation;
  readonly corsa?: CorsaBuiltinOperation;
}

export interface CorsaEffectParityResult {
  readonly schema: "uneffect-corsa-effect-parity/v1";
  readonly typescriptRevision: string;
  readonly corsaRevision: string;
  readonly entries: readonly CorsaEffectParityEntry[];
  readonly summary: Readonly<Record<CorsaEffectParityStatus, number>>;
}

function selectedTypeScriptOperation(
  resolved: ReturnType<TypeScriptFrontendAdapter["resolveCall"]>,
): CorsaBuiltinOperation | undefined {
  if (resolved?.symbol.module !== "global") return undefined;
  if (resolved.symbol.export === "fetch") return "Fetch";
  if (resolved.symbol.export.startsWith("console.")) return "Console";
  return undefined;
}

/**
 * Runs the first Corsa semantic sidecar beside the authoritative TypeScript
 * frontend. A disagreement is retained as evidence and is never converted to
 * a successful fallback.
 */
export function analyzeCorsaEffectParity(program: ts.Program, corsa: CorsaApiFrontend): CorsaEffectParityResult {
  const adapter = new TypeScriptFrontendAdapter(program);
  const roots = new Set(corsa.rootFiles.map((file) => resolve(file)));
  const entries: CorsaEffectParityEntry[] = [];

  for (const source of program.getSourceFiles()) {
    if (!roots.has(resolve(source.fileName))) continue;
    const calls: Array<{ node: ts.CallExpression; typescript?: CorsaBuiltinOperation; query: { calleePosition: number; receiverPosition?: number } }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const typescript = selectedTypeScriptOperation(adapter.resolveCall(node));
        const expression = node.expression;
        const query = ts.isPropertyAccessExpression(expression)
          ? { calleePosition: expression.name.getStart(source), receiverPosition: expression.expression.getStart(source) }
          : { calleePosition: expression.getStart(source) };
        calls.push({ node, ...(typescript === undefined ? {} : { typescript }), query });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    const corsaOperations = corsa.classifyBuiltinCalls(source.fileName, calls.map((call) => call.query));
    for (const [index, call] of calls.entries()) {
        const { node, typescript } = call;
        const corsaOperation = corsaOperations[index]?.operation;
        if (typescript !== undefined || corsaOperation !== undefined) {
          const operation = typescript ?? corsaOperation!;
          entries.push({
            fileName: source.fileName,
            start: node.getStart(source),
            end: node.getEnd(),
            operation,
            status: typescript === corsaOperation ? "agree" : "mismatch",
            ...(typescript === undefined ? {} : { typescript }),
            ...(corsaOperation === undefined ? {} : { corsa: corsaOperation }),
          });
        }
    }
  }

  entries.sort((left, right) => left.fileName.localeCompare(right.fileName) || left.start - right.start);
  return {
    schema: "uneffect-corsa-effect-parity/v1",
    typescriptRevision: `typescript-api@${ts.version}`,
    corsaRevision: corsa.compilerRevision,
    entries,
    summary: {
      agree: entries.filter((entry) => entry.status === "agree").length,
      mismatch: entries.filter((entry) => entry.status === "mismatch").length,
    },
  };
}
