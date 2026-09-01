import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Node } from "@oxlint/plugins";
import { OxlintUtils, SignatureKind, definePlugin, type CorsaSignature, type CorsaSymbol, type CorsaType, type CorsaTypeCheckerShape } from "corsa-oxlint";

export interface CorsaCheckerFactExportOptions {
  files: Record<string, string>;
  corsaExecutable: string;
  timeoutMs?: number;
}

export interface CorsaCheckerFactFile {
  schemaVersion: 8;
  fileId: number;
  compilerRevision: string;
  provenance: { producer: "corsa-checker"; checkerBacked: true };
  symbols: CorsaCheckerFactSymbol[];
  calls: Array<Record<string, unknown>>;
  trivia: Array<Record<string, unknown>>;
  protocolSymbols: Array<Record<string, unknown>>;
  promiseObservations: CorsaCheckerPromiseObservationFact[];
  rejectionOwnership: Array<Record<string, unknown>>;
  resourceScopes: Array<Record<string, unknown>>;
  disposals: Array<Record<string, unknown>>;
  suppressedErrors: Array<Record<string, unknown>>;
}

export interface CorsaCheckerPromiseObservationFact {
  owner: number;
  source: string;
  observation: "await" | "return";
  catchesRejection: boolean;
  conditional: boolean;
  controlConditions: CorsaCheckerControlCondition[];
  controlPaths: CorsaCheckerControlCondition[][];
  span: { start: number; end: number };
}

export interface CorsaCheckerControlCondition {
  id: string;
  expected: boolean;
}

export interface CorsaCheckerInferredEffectFact {
  effect: string;
  builtin: { module: string; export: string };
  /** Opaque identity allocated by the active Corsa checker session. */
  symbolIdentity: string;
  declaration: { fileName: string; start: number; end: number };
  /** Project-wide UTF-8 byte span of the operation that produced the effect. */
  span: { start: number; end: number };
}

export interface CorsaCheckerFactSymbol extends Record<string, unknown> {
  id: number;
  name: string;
  kind: string;
  typeRepr: string;
  overloads: string[];
  effectParameters: number[];
  inferredEffects: CorsaCheckerInferredEffectFact[];
  span: { start: number; end: number };
}

interface PendingFunction {
  node: any;
  symbolId: string;
  name: string;
  typeRepr: string;
  overloads: Array<{ id: string; text: string }>;
  start: number;
  end: number;
  inferredEffects: PendingInferredEffect[];
}

interface PendingInferredEffect {
  effect: string;
  builtin: { module: string; export: string };
  symbolIdentity: string;
  declaration: { fileName: string; start: number; end: number };
  start: number;
  end: number;
}

interface PendingCall {
  callerSymbolId: string;
  calleeSymbolId: string;
  overloadSignatureId: string | null;
  start: number;
  end: number;
}

interface PendingPromiseObservation {
  ownerSymbolId: string;
  source: string;
  start: number;
  end: number;
  control: { ifStart: number; expected: boolean } | null;
  observation: "await" | "return";
  catchesRejection: boolean;
}

interface RawCorsaCheckerFacts {
  fileName: string;
  functions: Array<Omit<PendingFunction, "node"> & { trivia: { text: string; start: number; end: number } | null }>;
  calls: PendingCall[];
  promiseObservations: PendingPromiseObservation[];
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
    const rootFiles = new Set(services.program.getRootFileNames().map((fileName: string) => fileName.toLowerCase()));
    const text = context.sourceCode.text as string;
    const functions: PendingFunction[] = [];
    const calls: PendingCall[] = [];
    const promiseObservations: PendingPromiseObservation[] = [];
    const functionStack: Array<PendingFunction | null> = [];
    const bindingFunctions = new WeakMap<object, PendingFunction>();
    const importedBuiltinBindings = new Map<string, ImportedCheckerBuiltinBinding>();

    const enterBindingFunction = (node: any): void => {
      functionStack.push(bindingFunctions.get(node) ?? null);
    };
    const exitBindingFunction = (node: any): void => {
      functionStack.pop();
    };

    return {
      ImportDeclaration(node: any) {
        if (node.source?.type !== "Literal" || typeof node.source.value !== "string") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== "ImportSpecifier" || specifier.local?.type !== "Identifier") continue;
          const importedName = specifier.imported?.name ?? specifier.imported?.value;
          if (typeof importedName !== "string") continue;
          const contract = checkerImportedBuiltinContracts.get(`${node.source.value}\0${importedName}`);
          const symbol = contract ? checker.getSymbolAtLocation(specifier.local as Node) : undefined;
          if (!contract || !symbol) continue;
          importedBuiltinBindings.set(symbol.id, {
            contract,
            symbolIdentity: symbol.id,
            declaration: {
              fileName: context.filename,
              start: byteOffset(text, specifier.range[0]),
              end: byteOffset(text, specifier.range[1]),
            },
          });
        }
      },
      FunctionDeclaration(node: any) {
        if (!node.id || !node.body) {
          functionStack.push(null);
          return;
        }
        const wrapper = node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration"
          ? node.parent
          : node;
        if (wrapper.parent?.type !== "Program") {
          functionStack.push(null);
          return;
        }
        const directSymbol = checker.getSymbolAtLocation(node.id as Node);
        const type = checker.getTypeAtLocation(node.id as Node);
        const symbol = type ? (checker.getSymbolOfType(type) ?? directSymbol) : directSymbol;
        if (!symbol) return;
        const pending: PendingFunction = {
          node,
          symbolId: symbol.id,
          name: symbol.name,
          typeRepr: type ? checker.typeToString(type) : "unknown",
          overloads: type ? overloadFacts(checker, type) : [],
          start: byteOffset(text, node.range[0]),
          end: byteOffset(text, node.range[1]),
          inferredEffects: [],
        };
        functions.push(pending);
        functionStack.push(pending);
      },
      "FunctionDeclaration:exit"() {
        functionStack.pop();
      },
      VariableDeclarator(node: any) {
        const initializer = node.init;
        const caller = functionStack.at(-1);
        const declaration = node.parent;
        const imported = initializer?.type === "AwaitExpression" ? initializer.argument : undefined;
        if (caller && declaration?.type === "VariableDeclaration" && declaration.kind === "const"
          && declaration.declarations?.length === 1 && node.id?.type === "ObjectPattern"
          && node.id.properties?.length === 1 && imported?.type === "ImportExpression"
          && imported.source?.type === "Literal" && typeof imported.source.value === "string") {
          const property = node.id.properties[0];
          const importedName = property?.type === "Property" && property.shorthand === true && !property.computed
            && property.key?.type === "Identifier" && property.value?.type === "Identifier"
            ? property.key.name
            : undefined;
          const contract = importedName
            ? checkerImportedBuiltinContracts.get(`${imported.source.value}\0${importedName}`)
            : undefined;
          const symbol = contract ? checker.getSymbolAtLocation(property.value as Node) : undefined;
          const awaitControl = contract ? classifyDirectAwaitControl(initializer, caller.node) : { supported: false as const };
          const rejectionCatch = contract ? classifyDirectAwaitRejectionCatch(initializer, caller.node) : { supported: false as const };
          if (contract && symbol && awaitControl.supported && rejectionCatch.supported) {
            importedBuiltinBindings.set(symbol.id, {
              contract,
              symbolIdentity: symbol.id,
              declaration: {
                fileName: context.filename,
                start: byteOffset(text, property.range[0]),
                end: byteOffset(text, property.range[1]),
              },
            });
            promiseObservations.push({
              ownerSymbolId: caller.symbolId,
              source: text.slice(imported.range[0], imported.range[1]),
              start: byteOffset(text, imported.range[0]),
              end: byteOffset(text, imported.range[1]),
              control: awaitControl.control === null ? null : {
                ifStart: byteOffset(text, awaitControl.control.node.range[0]),
                expected: awaitControl.control.expected,
              },
              observation: "await",
              catchesRejection: rejectionCatch.catchesRejection,
            });
          }
        }
        if (!initializer || (initializer.type !== "ArrowFunctionExpression" && initializer.type !== "FunctionExpression")) return;
        if (node.id?.type !== "Identifier") return;
        const wrapper = declaration?.parent?.type === "ExportNamedDeclaration" ? declaration.parent : declaration;
        if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations?.length !== 1) return;
        if (wrapper?.parent?.type !== "Program") return;
        const directSymbol = checker.getSymbolAtLocation(node.id as Node);
        const type = checker.getTypeAtLocation(node.id as Node);
        const symbol = type ? (checker.getSymbolOfType(type) ?? directSymbol) : directSymbol;
        if (!symbol) return;
        const pending: PendingFunction = {
          node: wrapper,
          symbolId: symbol.id,
          // Corsa represents anonymous function values with a synthetic
          // `__function` type symbol. Keep that symbol for identity/edges,
          // but expose the immutable binding name as the source callable.
          name: node.id.name,
          typeRepr: type ? checker.typeToString(type) : "unknown",
          overloads: type ? overloadFacts(checker, type) : [],
          start: byteOffset(text, wrapper.range[0]),
          end: byteOffset(text, wrapper.range[1]),
          inferredEffects: [],
        };
        functions.push(pending);
        bindingFunctions.set(initializer, pending);
      },
      MethodDefinition(node: any) {
        if (node.computed || node.kind !== "method" || node.key?.type !== "Identifier") return;
        const classBody = node.parent;
        const classNode = classBody?.parent;
        if (classBody?.type !== "ClassBody" || classNode?.type !== "ClassDeclaration" || classNode.id?.type !== "Identifier") return;
        const wrapper = classNode.parent?.type === "ExportNamedDeclaration" || classNode.parent?.type === "ExportDefaultDeclaration"
          ? classNode.parent
          : classNode;
        if (wrapper.parent?.type !== "Program" || node.value?.type !== "FunctionExpression") return;
        const directSymbol = checker.getSymbolAtLocation(node.key as Node);
        const type = checker.getTypeAtLocation(node.key as Node);
        const symbol = type ? (checker.getSymbolOfType(type) ?? directSymbol) : directSymbol;
        if (!symbol) return;
        const pending: PendingFunction = {
          node,
          symbolId: symbol.id,
          name: `${classNode.id.name}.${node.key.name}`,
          typeRepr: type ? checker.typeToString(type) : "unknown",
          overloads: type ? overloadFacts(checker, type) : [],
          start: byteOffset(text, node.range[0]),
          end: byteOffset(text, node.range[1]),
          inferredEffects: [],
        };
        functions.push(pending);
        bindingFunctions.set(node.value, pending);
      },
      ArrowFunctionExpression: enterBindingFunction,
      "ArrowFunctionExpression:exit": exitBindingFunction,
      FunctionExpression: enterBindingFunction,
      "FunctionExpression:exit": exitBindingFunction,
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
        const awaitControl = node.parent?.type === "AwaitExpression"
          ? classifyDirectAwaitControl(node.parent, caller.node)
          : { supported: false as const };
        if (awaitControl.supported) {
          const rejectionCatch = classifyDirectAwaitRejectionCatch(node.parent, caller.node);
          if (rejectionCatch.supported) promiseObservations.push({
            ownerSymbolId: caller.symbolId,
            source: text.slice(node.range[0], node.range[1]),
            start: byteOffset(text, node.range[0]),
            end: byteOffset(text, node.range[1]),
            control: awaitControl.control === null ? null : {
              ifStart: byteOffset(text, awaitControl.control.node.range[0]),
              expected: awaitControl.control.expected,
            },
            observation: "await",
            catchesRejection: rejectionCatch.catchesRejection,
          });
        }
        const returnedExpression = directReturnedCallExpression(node);
        if (returnedExpression && (isExplicitCorsaPromiseType(checker, returnedExpression.expression)
          || (type ? isExplicitCorsaPromiseReturn(checker, type, node) : false))) {
          const returnControl = classifyDirectAwaitControl(returnedExpression.returnStatement, caller.node);
          if (returnControl.supported && returnControl.control === null) {
            promiseObservations.push({
              ownerSymbolId: caller.symbolId,
              source: text.slice(returnedExpression.expression.range[0], returnedExpression.expression.range[1]),
              start: byteOffset(text, returnedExpression.expression.range[0]),
              end: byteOffset(text, returnedExpression.expression.range[1]),
              control: null,
              observation: "return",
              catchesRejection: false,
            });
          }
        }
        const inferred = directSymbol ? checkerBuiltinEffects(
          checker, node, directSymbol, callee, text, rootFiles, importedBuiltinBindings.get(directSymbol.id),
        ) : [];
        for (const effect of inferred) {
          if (!caller.inferredEffects.some((item) => item.effect === effect.effect
            && item.symbolIdentity === effect.symbolIdentity && item.start === effect.start)) {
            caller.inferredEffects.push(effect);
          }
        }
        calls.push({
          callerSymbolId: caller.symbolId,
          calleeSymbolId: callee.id,
          overloadSignatureId: type ? selectedCallSignatureId(checker, type, node) : null,
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
          promiseObservations,
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
      compilerOptions: { module: "esnext", target: "es2022", strict: true, types: ["node"] },
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
    const functionsBySymbol = new Map(allFunctions.map((item) => [item.symbolId, item]));
    const symbols = allFunctions.map((item) => ({
      id: ids.get(item.symbolId)!,
      name: projectFunctionDisplayName(item.fileName, item.name, nameCounts),
      kind: "function",
      typeRepr: item.typeRepr,
      overloads: item.overloads.map((overload) => overload.text),
      effectParameters: [],
      inferredEffects: item.inferredEffects.map((effect) => ({
        effect: effect.effect,
        builtin: effect.builtin,
        symbolIdentity: effect.symbolIdentity,
        declaration: {
          ...effect.declaration,
          fileName: sourcePaths.has(resolve(effect.declaration.fileName))
            ? sourceNameOf(effect.declaration.fileName)
            : effect.declaration.fileName,
        },
        span: {
          start: coordinates.base(item.fileName) + effect.start,
          end: coordinates.base(item.fileName) + effect.end,
        },
      })),
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
        const target = functionsBySymbol.get(item.calleeSymbolId)!;
        let overloadIndex: number | null = null;
        if (target.overloads.length > 0) {
          overloadIndex = item.overloadSignatureId === null
            ? -1
            : target.overloads.findIndex((overload) => overload.id === item.overloadSignatureId);
          if (overloadIndex < 0) {
            throw new Error(`corsa-oxlint did not resolve an exported overload for call to ${target.name}`);
          }
        }
        return [{
          caller,
          callee,
          overloadIndex,
          callbackTiming: "none",
          span: {
            start: coordinates.base(fileName) + item.start,
            end: coordinates.base(fileName) + item.end,
          },
        }];
      });
    });
    const promiseObservations: CorsaCheckerPromiseObservationFact[] = rawFiles.flatMap((raw) => {
      const fileName = sourceNameOf(raw.fileName);
      return raw.promiseObservations.map((item): CorsaCheckerPromiseObservationFact => {
        const owner = ids.get(item.ownerSymbolId)!;
        const ownerName = raw.functions.find((fn) => fn.symbolId === item.ownerSymbolId)?.name;
        if (!ownerName) throw new Error(`missing Corsa Promise observation owner ${owner}`);
        const condition = item.control === null ? null : {
          id: `${ownerName}@if:${item.control.ifStart}`,
          expected: item.control.expected,
        };
        return {
          owner,
          source: item.source,
          observation: item.observation,
          catchesRejection: item.catchesRejection,
          conditional: condition !== null,
          controlConditions: condition === null ? [] : [condition],
          controlPaths: condition === null ? [[]] : [[condition]],
          span: {
            start: coordinates.base(fileName) + item.start,
            end: coordinates.base(fileName) + item.end,
          },
        };
      });
    });
    const facts: CorsaCheckerFactFile = {
      schemaVersion: 8,
      fileId: 1,
      compilerRevision,
      provenance: { producer: "corsa-checker", checkerBacked: true },
      symbols,
      calls,
      trivia,
      protocolSymbols: [],
      promiseObservations,
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

interface CheckerBuiltinIdentity {
  readonly module: string;
  readonly export: string;
  readonly effect: string | readonly string[];
}

interface CheckerBuiltinContract extends CheckerBuiltinIdentity {
  readonly declaration: RegExp;
}

interface ImportedCheckerBuiltinBinding {
  readonly contract: CheckerBuiltinIdentity;
  readonly symbolIdentity: string;
  readonly declaration: { readonly fileName: string; readonly start: number; readonly end: number };
}

const checkerImportedBuiltinContracts = new Map<string, CheckerBuiltinIdentity>([
  ["node:fs/promises\0access", { module: "node:fs/promises", export: "access", effect: "FsRead" }],
  ["node:fs/promises\0readdir", { module: "node:fs/promises", export: "readdir", effect: "FsRead" }],
  ["node:fs/promises\0readFile", { module: "node:fs/promises", export: "readFile", effect: "FsRead" }],
  ["node:fs/promises\0appendFile", { module: "node:fs/promises", export: "appendFile", effect: "FsWrite" }],
  ["node:fs/promises\0mkdir", { module: "node:fs/promises", export: "mkdir", effect: "FsWrite" }],
  ["node:fs/promises\0writeFile", { module: "node:fs/promises", export: "writeFile", effect: "FsWrite" }],
]);

const checkerIdentifierBuiltinContracts = new Map<string, CheckerBuiltinContract>([
  ["fetch", { module: "global", export: "fetch", effect: ["Fetch", "Net"], declaration: /[\\/]lib[\\/]lib\.(?:dom|webworker)\.d\.ts$/ }],
]);

const checkerMemberBuiltinContracts = new Map<string, CheckerBuiltinContract>([
  ["console\0console.log", { module: "global", export: "console.log", effect: "Console", declaration: /[\\/]lib[\\/]lib\.dom\.d\.ts$/ }],
]);

function checkerBuiltinEffects(
  checker: CorsaTypeCheckerShape,
  call: any,
  directCallee: CorsaSymbol,
  resolvedCallee: CorsaSymbol,
  sourceText: string,
  rootFiles: ReadonlySet<string>,
  importedBinding?: ImportedCheckerBuiltinBinding,
): PendingInferredEffect[] {
  let contract: CheckerBuiltinIdentity | CheckerBuiltinContract | undefined;
  let receiver: CorsaSymbol | undefined;
  if (call.callee?.type === "Identifier") {
    contract = importedBinding?.contract ?? checkerIdentifierBuiltinContracts.get(directCallee.name)
      ?? checkerIdentifierBuiltinContracts.get(resolvedCallee.name);
  } else if (call.callee?.type === "MemberExpression" && !call.callee.computed
    && call.callee.object?.type === "Identifier" && call.callee.property?.type === "Identifier") {
    receiver = checker.getSymbolAtLocation(call.callee.object as Node);
    const key = `${receiver?.name ?? ""}\0${receiver?.name ?? ""}.${directCallee.name}`;
    contract = checkerMemberBuiltinContracts.get(key);
  }
  if (!contract) return [];
  const declarations = resolvedCallee.declarations
    .map((handle) => checker.getNode(handle))
    .filter((node): node is NonNullable<ReturnType<CorsaTypeCheckerShape["getNode"]>> => node !== undefined);
  const directDeclarations = directCallee.declarations
    .map((handle) => checker.getNode(handle))
    .filter((node): node is NonNullable<ReturnType<CorsaTypeCheckerShape["getNode"]>> => node !== undefined);
  const declarationPattern = importedBinding ? undefined : (contract as CheckerBuiltinContract).declaration;
  const isBuiltinDeclaration = (node: { fileName: string }): boolean =>
    Boolean(declarationPattern?.test(node.fileName)) && !rootFiles.has(node.fileName.toLowerCase());
  const checkerDeclaration = declarations.find(isBuiltinDeclaration)
    ?? directDeclarations.find(isBuiltinDeclaration);
  if (!importedBinding && !checkerDeclaration) return [];
  if (receiver) {
    const receiverDeclarations = receiver.declarations
      .map((handle) => checker.getNode(handle))
      .filter((node): node is NonNullable<ReturnType<CorsaTypeCheckerShape["getNode"]>> => node !== undefined);
    if (!receiverDeclarations.some(isBuiltinDeclaration)) return [];
  }
  const effects = typeof contract.effect === "string" ? [contract.effect] : contract.effect;
  return effects.map((effect) => ({
    effect,
    builtin: { module: contract.module, export: contract.export },
    symbolIdentity: importedBinding?.symbolIdentity ?? resolvedCallee.id,
    declaration: importedBinding?.declaration ?? {
      fileName: checkerDeclaration!.fileName,
      start: checkerDeclaration!.pos,
      end: checkerDeclaration!.end,
    },
    start: byteOffset(sourceText, call.range[0]),
    end: byteOffset(sourceText, call.range[1]),
  }));
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

function classifyDirectAwaitControl(awaitNode: any, ownerNode: any): {
  supported: true;
  control: { node: any; expected: boolean } | null;
} | { supported: false } {
  let control: { node: any; expected: boolean } | null = null;
  let child = awaitNode;
  for (let current = awaitNode.parent; current && current !== ownerNode; current = current.parent) {
    if (current.type === "IfStatement") {
      if (control !== null) return { supported: false };
      if (current.consequent === child) control = { node: current, expected: true };
      else if (current.alternate === child) control = { node: current, expected: false };
      else return { supported: false };
    } else if (current.type === "ConditionalExpression" || current.type === "LogicalExpression"
      || current.type === "SwitchCase" || current.type === "ForStatement"
      || current.type === "ForInStatement" || current.type === "ForOfStatement"
      || current.type === "WhileStatement" || current.type === "DoWhileStatement"
      || current.type === "CatchClause") {
      return { supported: false };
    }
    child = current;
  }
  return { supported: true, control };
}

function classifyDirectAwaitRejectionCatch(awaitNode: any, ownerNode: any): {
  supported: true;
  catchesRejection: boolean;
} | { supported: false } {
  let catchesRejection = false;
  let protectedTryCount = 0;
  let child = awaitNode;
  for (let current = awaitNode.parent; current && current !== ownerNode; current = current.parent) {
    if (current.type === "CatchClause") return { supported: false };
    if (current.type === "TryStatement") {
      if (current.block !== child) return { supported: false };
      protectedTryCount += 1;
      if (protectedTryCount > 1) return { supported: false };
      catchesRejection = current.handler !== null;
    }
    child = current;
  }
  return { supported: true, catchesRejection };
}

function directReturnedCallExpression(call: any): { expression: any; returnStatement: any } | null {
  if (call.parent?.type === "ReturnStatement" && call.parent.argument === call) {
    return { expression: call, returnStatement: call.parent };
  }
  if (call.parent?.type === "TSAsExpression" && call.parent.expression === call
    && call.parent.parent?.type === "ReturnStatement" && call.parent.parent.argument === call.parent) {
    return { expression: call.parent, returnStatement: call.parent.parent };
  }
  return null;
}

function isExplicitCorsaPromiseType(checker: CorsaTypeCheckerShape, expression: Node): boolean {
  const type = checker.getTypeAtLocation(expression);
  if (!type) return false;
  return /^(?:Promise|PromiseLike)<.+>$/.test(checker.typeToString(type));
}

function isExplicitCorsaPromiseReturn(checker: CorsaTypeCheckerShape, type: CorsaType, call: any): boolean {
  const argumentTypeTexts: string[][] = [];
  for (const argument of (call.arguments ?? []) as Node[]) {
    const argumentType = checker.getTypeAtLocation(argument);
    if (!argumentType) {
      argumentTypeTexts.push(["unknown"]);
      continue;
    }
    const base = checker.getBaseTypeOfLiteralType(argumentType);
    argumentTypeTexts.push([...new Set([
      checker.typeToString(argumentType),
      ...(base ? [checker.typeToString(base)] : []),
      ...checker.getTypesOfType(argumentType).map((item) => checker.typeToString(item)),
    ])]);
  }
  const explicitTypeArgumentTexts: string[] = [];
  for (const argument of (call.typeArguments ?? []) as Node[]) {
    const argumentType = checker.getTypeAtLocation(argument);
    explicitTypeArgumentTexts.push(argumentType ? checker.typeToString(argumentType) : "unknown");
  }
  const signature = checker.getCallSignatureFacts(
    type, SignatureKind.Call, argumentTypeTexts, explicitTypeArgumentTexts,
  ).signature;
  const result = signature && checker.getReturnTypeOfSignature(signature);
  return Boolean(result && /^(?:Promise|PromiseLike)<.+>$/.test(checker.typeToString(result)));
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

function overloadFacts(checker: CorsaTypeCheckerShape, type: CorsaType): Array<{ id: string; text: string }> {
  const signatures = [...checker.getSignaturesOfType(type, SignatureKind.Call)].sort((left, right) => {
    const leftNode = left.declaration ? checker.getNode(left.declaration) : undefined;
    const rightNode = right.declaration ? checker.getNode(right.declaration) : undefined;
    return (leftNode?.range[0] ?? Number.MAX_SAFE_INTEGER) - (rightNode?.range[0] ?? Number.MAX_SAFE_INTEGER);
  });
  if (signatures.length <= 1) return [];
  return signatures.map((signature) => ({ id: signature.id, text: corsaSignatureText(checker, signature) }));
}

function selectedCallSignatureId(checker: CorsaTypeCheckerShape, type: CorsaType, node: any): string | null {
  const argumentTypeTexts: string[][] = [];
  for (const argument of (node.arguments ?? []) as Node[]) {
    const argumentType = checker.getTypeAtLocation(argument);
    if (!argumentType) {
      argumentTypeTexts.push(["unknown"]);
      continue;
    }
    const base = checker.getBaseTypeOfLiteralType(argumentType);
    argumentTypeTexts.push([...new Set([
      checker.typeToString(argumentType),
      ...(base ? [checker.typeToString(base)] : []),
      ...checker.getTypesOfType(argumentType).map((item) => checker.typeToString(item)),
    ])]);
  }
  const explicitTypeArgumentTexts: string[] = [];
  for (const argument of (node.typeArguments ?? []) as Node[]) {
    const argumentType = checker.getTypeAtLocation(argument);
    explicitTypeArgumentTexts.push(argumentType ? checker.typeToString(argumentType) : "unknown");
  }
  return checker.getCallSignatureFacts(type, SignatureKind.Call, argumentTypeTexts, explicitTypeArgumentTexts).signature?.id ?? null;
}

function corsaSignatureText(checker: CorsaTypeCheckerShape, signature: CorsaSignature): string {
  const parameters = signature.parameterSymbols?.map((symbol, index) => {
    const alternatives = signature.parameterTypeTexts?.[index];
    return `${symbol.name}: ${alternatives?.length ? alternatives.join(" | ") : "unknown"}`;
  }) ?? signature.parameters.map((_, index) => `arg${index}: unknown`);
  const result = checker.getReturnTypeOfSignature(signature);
  return `(${parameters.join(", ")}): ${result ? checker.typeToString(result) : "unknown"}`;
}
