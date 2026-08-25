import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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

interface RawCorsaCheckerFacts {
  fileName: string;
  functions: Array<Omit<PendingFunction, "node"> & { trivia: { text: string; start: number; end: number } | null }>;
  calls: PendingCall[];
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
        const directSymbol = checker.getSymbolAtLocation(node.id as Node);
        const type = checker.getTypeAtLocation(node.id as Node);
        const symbol = type ? (checker.getSymbolOfType(type) ?? directSymbol) : directSymbol;
        if (!symbol) return;
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
        const directSymbol = checker.getSymbolAtLocation(target as Node);
        const type = checker.getTypeAtLocation(target as Node);
        const callee = type ? (checker.getSymbolOfType(type) ?? directSymbol) : directSymbol;
        if (!callee) return;
        calls.push({
          callerSymbolId: caller.symbolId,
          calleeSymbolId: callee.id,
          start: byteOffset(text, node.range[0]),
          end: byteOffset(text, node.range[1]),
        });
      },
      "Program:exit"() {
        const raw: RawCorsaCheckerFacts = {
          fileName: context.filename,
          functions: functions.map(({ node, ...item }) => {
            const leading = leadingUneffectTrivia(text, node.range[0]);
            return {
              ...item,
              trivia: leading ? {
                text: leading.text,
                start: byteOffset(text, leading.start),
                end: byteOffset(text, leading.end),
              } : null,
            };
          }),
          calls,
        };
        const outputName = createHash("sha256").update(context.filename).digest("hex");
        writeFileSync(join(output, `${outputName}.json`), JSON.stringify(raw));
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
  const { createProjectByteCoordinates, projectFunctionDisplayName } = await import("./project-coordinates.js");
  const coordinates = createProjectByteCoordinates(options.files);
  if (coordinates.fileNames.length === 0) throw new Error("Corsa checker fact export requires at least one source file");
  const workspace = mkdtempSync(join(tmpdir(), "uneffect-corsa-"));
  try {
    const configPath = join(workspace, "oxlint.config.mjs");
    const tsconfigPath = join(workspace, "tsconfig.json");
    const outputPath = join(workspace, "facts");
    mkdirSync(outputPath);
    const sourcePaths = new Map<string, string>();
    for (const fileName of coordinates.fileNames) {
      const sourcePath = safeWorkspacePath(workspace, fileName);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, options.files[fileName]!);
      sourcePaths.set(resolve(sourcePath), fileName);
    }
    writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: { module: "esnext", target: "es2022", strict: true },
      include: ["**/*.ts", "**/*.tsx"],
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
    const execution = spawnSync(process.execPath, [oxlintBin, "--config", configPath, ...sourcePaths.keys()], {
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
    const sourceNameOf = (fileName: string): string => {
      const name = sourcePaths.get(resolve(fileName));
      if (!name) throw new Error(`corsa-oxlint returned an unknown source file: ${fileName}`);
      return name;
    };
    const rawFiles = readdirSync(outputPath)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(outputPath, name), "utf8")) as RawCorsaCheckerFacts)
      .sort((left, right) => sourceNameOf(left.fileName).localeCompare(sourceNameOf(right.fileName)));
    if (rawFiles.length !== coordinates.fileNames.length) {
      throw new Error(`corsa-oxlint fact export produced ${rawFiles.length} file record(s), expected ${coordinates.fileNames.length}`);
    }
    const allFunctions = rawFiles.flatMap((raw) => {
      const fileName = sourceNameOf(raw.fileName);
      return raw.functions.map((item) => ({ ...item, fileName }));
    });
    const ids = new Map<string, number>();
    allFunctions.forEach((item, index) => ids.set(item.symbolId, index + 1));
    const nameCounts = new Map<string, number>();
    for (const item of allFunctions) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
    const symbols = allFunctions.map((item) => ({
      id: ids.get(item.symbolId)!,
      name: projectFunctionDisplayName(item.fileName, item.name, nameCounts),
      kind: "function",
      typeRepr: item.typeRepr,
      overloads: [],
      effectParameters: [],
      span: {
        start: coordinates.base(item.fileName) + item.start,
        end: coordinates.base(item.fileName) + item.end,
      },
    }));
    const trivia = allFunctions.flatMap((item) => item.trivia ? [{
      owner: ids.get(item.symbolId)!,
      text: item.trivia.text,
      span: {
        start: coordinates.base(item.fileName) + item.trivia.start,
        end: coordinates.base(item.fileName) + item.trivia.end,
      },
    }] : []);
    const calls = rawFiles.flatMap((raw) => {
      const fileName = sourceNameOf(raw.fileName);
      return raw.calls.flatMap((item) => {
        const caller = ids.get(item.callerSymbolId), callee = ids.get(item.calleeSymbolId);
        if (!caller || !callee) return [];
        return [{
          caller,
          callee,
          overloadIndex: null,
          callbackTiming: "none",
          span: {
            start: coordinates.base(fileName) + item.start,
            end: coordinates.base(fileName) + item.end,
          },
        }];
      });
    });
    const facts: CorsaCheckerFactFile = {
      schemaVersion: 7,
      fileId: 1,
      compilerRevision,
      provenance: { producer: "corsa-checker", checkerBacked: true },
      symbols,
      calls,
      trivia,
      protocolSymbols: [],
      promiseObservations: [],
      rejectionOwnership: [],
      resourceScopes: [],
      disposals: [],
      suppressedErrors: [],
    };
    const { authenticateCorsaCheckerFacts } = await import("./corsa-fact-provenance.js");
    return authenticateCorsaCheckerFacts(facts);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function safeWorkspacePath(workspace: string, fileName: string): string {
  const target = resolve(workspace, fileName);
  const child = relative(workspace, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`source file must be a relative path inside the project: ${fileName}`);
  }
  return target;
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
