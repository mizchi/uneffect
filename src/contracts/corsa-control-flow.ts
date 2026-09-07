import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Node } from "oxc-parser";
import { openCorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import type { CorsaApiFrontendOptions } from "../frontends/corsa/corsa-api-frontend.js";
import { oxcStatementExit, type OxcContractControlFlowOptions } from "../frontends/oxc/contract-control-flow.js";
import { parseOxcSource, topLevelOxcFunctions } from "../frontends/oxc/source.js";
import type { ContractExit, CorsaContractControlFlow } from "./control-flow-contracts.js";

export interface AnalyzeCorsaContractControlFlowOptions extends CorsaApiFrontendOptions {
  /** Files and exact text already present in the configured native project. */
  readonly files: Readonly<Record<string, string>>;
}
function mayFallThrough(exits: readonly ContractExit[]): boolean {
  return exits.some(exit => exit === "normal" || exit.startsWith("break:") || exit.startsWith("continue:"));
}

/** Same-snapshot diagnostics and semantic facts refine the shared structural completion rules. */
export async function analyzeCorsaContractControlFlow(options: AnalyzeCorsaContractControlFlowOptions): Promise<CorsaContractControlFlow[]> {
  const { files, ...frontendOptions } = options;
  const sources = Object.entries(files).map(([file, text]) => ({ file, text,
    absolute: resolve(options.cwd ?? process.cwd(), file), source: parseOxcSource(file, text) }));
  const frontend = await openCorsaCallableFrontend(frontendOptions);
  try {
    for (const source of sources) frontend.assertSource(source.absolute, source.text);
    const errors = frontend.getProjectDiagnostics().filter(diagnostic => diagnostic.category === "error");
    if (errors.length) throw new Error(errors.map(error => `${error.fileName ?? options.configFile}: TS${error.code}: ${error.message}`).join("\n"));
    return sources.flatMap(({ file, text, absolute, source }) => {
      const booleans = new WeakMap<Node, boolean | undefined>();
      const calls = new WeakMap<Node, boolean>();
      const semantics: OxcContractControlFlowOptions = {
        constantBoolean(node) {
          if (!booleans.has(node)) {
            const type = frontend.getExpressionType(absolute, node, text);
            booleans.set(node, type ? frontend.getBooleanLiteralValue(type) : undefined);
          }
          return booleans.get(node);
        },
        isNeverCall(node) {
          if (!calls.has(node)) {
            const signature = frontend.getResolvedSignature(absolute, node, text);
            calls.set(node, signature !== null && frontend.isNeverType(signature.returnType));
          }
          return calls.get(node)!;
        },
      };
      const sourceDigest = createHash("sha256").update(text).digest("hex");
      return topLevelOxcFunctions(source).map(({ node, start, end }) => {
        const structuralExits = [...oxcStatementExit(node.body)], exits = [...oxcStatementExit(node.body, semantics)];
        return { fileName: file, name: node.id.name, span: { start, end }, evidence: "structural-with-corsa-types" as const,
          compilerRevision: frontend.compilerRevision, sourceDigest, exits, mayFallThrough: mayFallThrough(exits),
          structural: { exits: structuralExits, mayFallThrough: mayFallThrough(structuralExits) } };
      });
    });
  } finally { frontend.close(); }
}
