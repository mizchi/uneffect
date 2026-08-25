import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Node } from "@oxlint/plugins";
import { OxlintUtils, definePlugin } from "corsa-oxlint";

export interface CorsaCheckerFactExportOptions {
  files: Record<string, string>;
  corsaExecutable: string;
  timeoutMs?: number;
}

export interface CorsaCheckerFactFile {
  schemaVersion: 7;
  fileId: number;
  compilerRevision: string;
  provenance: { producer: "corsa-checker"; checkerBacked: true };
  symbols: Array<Record<string, unknown>>;
  calls: Array<Record<string, unknown>>;
  trivia: Array<Record<string, unknown>>;
  protocolSymbols: Array<Record<string, unknown>>;
  promiseObservations: Array<Record<string, unknown>>;
  rejectionOwnership: Array<Record<string, unknown>>;
  resourceScopes: Array<Record<string, unknown>>;
  disposals: Array<Record<string, unknown>>;
  suppressedErrors: Array<Record<string, unknown>>;
}

interface PendingFunction {
  node: any;
  symbolId: string;
  name: string;
  typeRepr: string;
  start: number;
  end: number;
}

interface PendingCall {
  callerSymbolId: string;
  calleeSymbolId: string;
  start: number;
  end: number;
}

const createRule = OxlintUtils.RuleCreator(() => "https://github.com/mizchi/uneffect");

export const corsaCheckerFactRule = createRule({
  name: "export-checker-facts",
  meta: {
    type: "problem",
    docs: {
      description: "Export Corsa checker facts for Uneffect's Rust frontend consumer.",
      requiresTypeChecking: true,
    },
    messages: { internal: "Uneffect Corsa fact export failed." },
    schema: [],
  },
  defaultOptions: [],
  create(context: any) {
    const output = process.env.UNEFFECT_CORSA_FACTS_OUT;
    if (!output) throw new Error("UNEFFECT_CORSA_FACTS_OUT is required");
    const services = OxlintUtils.getParserServices(context);
    if (!services.hasFullTypeInformation) throw new Error("Corsa full type information is required");
    const checker = services.program.getTypeChecker();
    const text = context.sourceCode.text as string;
    const functions: PendingFunction[] = [];
    const calls: PendingCall[] = [];
    const functionStack: PendingFunction[] = [];

    return {
      FunctionDeclaration(node: any) {
        if (!node.id || !node.body) return;
        const symbol = checker.getSymbolAtLocation(node.id as Node);
        if (!symbol) return;
        const type = checker.getTypeAtLocation(node.id as Node);
        const pending: PendingFunction = {
          node,
          symbolId: symbol.id,
          name: symbol.name,
          typeRepr: type ? checker.typeToString(type) : "unknown",
          start: byteOffset(text, node.range[0]),
          end: byteOffset(text, node.range[1]),
        };
        functions.push(pending);
        functionStack.push(pending);
      },
      "FunctionDeclaration:exit"() {
        functionStack.pop();
      },
      CallExpression(node: any) {
        const caller = functionStack.at(-1);
        if (!caller) return;
        const target = node.callee?.type === "MemberExpression" && !node.callee.computed
          ? node.callee.property
          : node.callee;
        if (!target) return;
        const callee = checker.getSymbolAtLocation(target as Node);
        if (!callee) return;
        calls.push({
          callerSymbolId: caller.symbolId,
          calleeSymbolId: callee.id,
          start: byteOffset(text, node.range[0]),
          end: byteOffset(text, node.range[1]),
        });
      },
      "Program:exit"() {
        const ids = new Map<string, number>();
        functions.forEach((item, index) => ids.set(item.symbolId, index + 1));
        const symbols = functions.map((item) => ({
          id: ids.get(item.symbolId)!,
          name: item.name,
          kind: "function",
          typeRepr: item.typeRepr,
          overloads: [],
          effectParameters: [],
          span: { start: item.start, end: item.end },
        }));
        const trivia = functions.flatMap((item) => {
          const leading = leadingUneffectTrivia(text, item.node.range[0]);
          if (!leading) return [];
          return [{
            owner: ids.get(item.symbolId)!,
            text: leading.text,
            span: {
              start: byteOffset(text, leading.start),
              end: byteOffset(text, leading.end),
            },
          }];
        });
        const resolvedCalls = calls.flatMap((item) => {
          const caller = ids.get(item.callerSymbolId), callee = ids.get(item.calleeSymbolId);
          if (!caller || !callee) return [];
          return [{
            caller,
            callee,
            overloadIndex: null,
            callbackTiming: "none",
            span: { start: item.start, end: item.end },
          }];
        });
        const facts: CorsaCheckerFactFile = {
          schemaVersion: 7,
          fileId: 1,
          compilerRevision: process.env.UNEFFECT_CORSA_COMPILER_REVISION ?? "corsa-checker@unknown",
          provenance: { producer: "corsa-checker", checkerBacked: true },
          symbols,
          calls: resolvedCalls,
          trivia,
          protocolSymbols: [],
          promiseObservations: [],
          rejectionOwnership: [],
          resourceScopes: [],
          disposals: [],
          suppressedErrors: [],
        };
        writeFileSync(output, JSON.stringify(facts));
      },
    };
  },
});

export const corsaCheckerExporterPlugin = definePlugin({
  meta: { name: "uneffect-corsa-exporter" },
  rules: { "export-checker-facts": corsaCheckerFactRule },
});
export default corsaCheckerExporterPlugin;

export async function exportCorsaCheckerFacts(options: CorsaCheckerFactExportOptions): Promise<CorsaCheckerFactFile> {
  const entries = Object.entries(options.files);
  if (entries.length !== 1) throw new Error("Corsa checker fact export currently supports exactly one source file");
  const [fileName, source] = entries[0]!;
  const workspace = mkdtempSync(join(tmpdir(), "uneffect-corsa-"));
  try {
    const sourcePath = join(workspace, basename(fileName));
    const configPath = join(workspace, "oxlint.config.mjs");
    const tsconfigPath = join(workspace, "tsconfig.json");
    const outputPath = join(workspace, "facts.json");
    writeFileSync(sourcePath, source);
    writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: { module: "esnext", target: "es2022", strict: true },
      include: [basename(sourcePath)],
    }));
    const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
    writeFileSync(configPath, `
      export default {
        settings: { corsaOxlint: { parserOptions: {
          project: [${JSON.stringify(tsconfigPath)}],
          tsconfigRootDir: ${JSON.stringify(workspace)},
          corsa: { executable: ${JSON.stringify(resolve(options.corsaExecutable))} }
        } } },
        jsPlugins: [{ name: "uneffect-corsa", specifier: ${JSON.stringify(moduleUrl)} }],
        rules: { "uneffect-corsa/export-checker-facts": "error" }
      };
    `);
    const oxlintPackage = fileURLToPath(import.meta.resolve("oxlint/package.json"));
    const oxlintBin = join(dirname(oxlintPackage), "bin", "oxlint");
    const version = spawnSync(resolve(options.corsaExecutable), ["--version"], { encoding: "utf8" });
    const compilerRevision = version.status === 0 ? `corsa-checker@${version.stdout.trim()}` : "corsa-checker@unknown";
    const execution = spawnSync(process.execPath, [oxlintBin, "--config", configPath, sourcePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      env: {
        ...process.env,
        UNEFFECT_CORSA_FACTS_OUT: outputPath,
        UNEFFECT_CORSA_COMPILER_REVISION: compilerRevision,
      },
    });
    if (execution.error || execution.status !== 0) {
      throw new Error(`corsa-oxlint fact export failed: ${execution.stderr}${execution.stdout}${execution.error?.message ?? ""}`.trim());
    }
    const { authenticateCorsaCheckerFacts } = await import("./corsa-fact-provenance.js");
    return authenticateCorsaCheckerFacts(JSON.parse(readFileSync(outputPath, "utf8")) as CorsaCheckerFactFile);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function byteOffset(text: string, utf16Offset: number): number {
  return Buffer.byteLength(text.slice(0, utf16Offset));
}

function leadingUneffectTrivia(text: string, before: number): { text: string; start: number; end: number } | null {
  const prefix = text.slice(0, before);
  const start = prefix.lastIndexOf("/*");
  if (start < 0) return null;
  const close = prefix.indexOf("*/", start);
  if (close < 0) return null;
  const end = close + 2;
  const comment = prefix.slice(start, end);
  const modifiers = prefix.slice(end);
  if (!comment.includes("uneffect:") || !/^\s*(?:(?:export|default|async)\s+)*$/.test(modifiers)) return null;
  return { text: comment, start, end };
}
