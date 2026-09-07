import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CorsaApiClient } from "@corsa-bind/napi";
import { resolveCorsaExecutable } from "../frontends/corsa/corsa-api-frontend.js";
import { decodeNativeSourceIndex, parseNativeNodeHandle } from "../frontends/corsa/native-source-index.js";
import { oxcParameterBinding, parseOxcSource, topLevelOxcFunctions, type OxcSource, type OxcFunctionSource } from "../frontends/oxc/source.js";

export interface PropertyPredicateImport {
  localName: string;
  exportedName: string;
  declarationFileName: string;
}

function exportedUnaryDeclaration(source: OxcSource, declaration: OxcFunctionSource): boolean {
  return declaration.node.params.length === 1 && !!oxcParameterBinding(declaration.node.params[0]!)
    && source.program.body.some(statement => (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") && statement.declaration === declaration.node);
}

/**
 * A disposable native project for symbol identity only. Generator domains are
 * source declarations, so missing numeric type libraries do not become proof facts.
 * Original sources and output paths never change; Corsa reads a private copy.
 */
function openNativePredicates(files: Readonly<Record<string, string>>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-property-symbols-"));
  let client: CorsaApiClient | undefined, snapshot: string | undefined;
  const close = (): void => {
    try { try { if (snapshot) client?.releaseHandle(snapshot); } finally { client?.close(); } }
    finally { rmSync(directory, { recursive: true, force: true }); }
  };
  try {
    const paths = new Map<string, string>();
    for (const [name, text] of Object.entries(files)) {
      const absolute = resolve(name).replaceAll("\\", "/"), path = join(directory, "sources", absolute.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, ""));
      if ([...paths.values()].includes(path)) throw new Error(`duplicate property source path: ${name}`);
      paths.set(name, path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", noLib: true, types: [], noEmit: true }, files: [...paths.values()] }));
    const binding = createRequire(import.meta.url)("@corsa-bind/napi") as typeof import("@corsa-bind/napi");
    client = binding.CorsaApiClient.spawn({ executable: resolveCorsaExecutable(), cwd: directory, mode: "jsonrpc" });
    const initialized = client.initialize();
    const canonical = (path: string): string => initialized.useCaseSensitiveFileNames ? path.replaceAll("\\", "/") : path.replaceAll("\\", "/").toLowerCase();
    const opened = client.updateSnapshot({ openProject: configFile });
    snapshot = opened.snapshot;
    const project = opened.projects.find((item: { configFileName: string }) => canonical(item.configFileName) === canonical(configFile));
    if (!project) throw new Error("Corsa did not open the property predicate project");
    const sourceIndexes = new Map<string, ReturnType<typeof decodeNativeSourceIndex>>();
    const index = (path: string) => {
      const cached = sourceIndexes.get(canonical(path));
      if (cached) return cached;
      const bytes = client!.getSourceFile(snapshot!, project.id, path);
      if (!bytes) throw new Error(`${path}: missing property predicate snapshot source`);
      const source = decodeNativeSourceIndex(bytes);
      sourceIndexes.set(canonical(path), source);
      return source;
    };
    return {
      close,
      resolve(source: OxcSource, predicate: string): PropertyPredicateImport | undefined {
        const path = paths.get(source.fileName)!;
        if (index(path).text !== source.text) throw new Error("property source does not match the Corsa snapshot");
        for (const statement of source.program.body) {
          if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
          const specifier = statement.specifiers.find(item => item.type === "ImportSpecifier" && item.local.name === predicate && item.importKind !== "type");
          if (!specifier || specifier.type !== "ImportSpecifier") continue;
          const symbol = client!.getSymbolAtPosition(snapshot!, project.id, path, specifier.local.start);
          if (!symbol) return undefined;
          const target = symbol.flags & 2_097_152 ? client!.getAliasedSymbol(snapshot!, project.id, symbol.id) : symbol;
          if (target?.declarations?.length !== 1) return undefined;
          const handle = parseNativeNodeHandle(target.declarations[0]);
          const original = [...paths].find(([, file]) => canonical(file) === canonical(handle.path))?.[0];
          if (!original) return undefined;
          const module = client!.getSymbolAtPosition(snapshot!, project.id, path, statement.source.start);
          if (module?.declarations?.length !== 1) return undefined;
          const moduleHandle = parseNativeNodeHandle(module.declarations[0]);
          if (moduleHandle.kind !== 307 || canonical(moduleHandle.path) !== canonical(handle.path)) return undefined;
          const declaredSource = parseOxcSource(original, files[original]!);
          const native = index(handle.path);
          if (native.text !== declaredSource.text) throw new Error("property predicate declaration does not match the Corsa snapshot");
          const span = native.node(target.declarations[0]).span;
          const declaration = topLevelOxcFunctions(declaredSource).find(item => item.start === span.start && item.end === span.end);
          if (!declaration || !exportedUnaryDeclaration(declaredSource, declaration)) return undefined;
          return { localName: predicate, exportedName: declaration.node.id.name, declarationFileName: original };
        }
        return undefined;
      },
    };
  } catch (error) { close(); throw error; }
}

/** Source-local declarations are explicit contracts; cross-file imports require native symbol identity. */
export function createPropertyPredicateResolver(files: Readonly<Record<string, string>>, allowImports: boolean) {
  let native: ReturnType<typeof openNativePredicates> | undefined;
  return {
    close() { native?.close(); },
    resolve(source: OxcSource, predicate: string): PropertyPredicateImport | undefined {
      const declarations = source.program.body.map(statement => statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement)
        .filter(node => (node?.type === "FunctionDeclaration" || node?.type === "TSDeclareFunction") && node.id?.name === predicate);
      if (declarations.length > 1) return undefined;
      const local = topLevelOxcFunctions(source).find(item => item.node.id.name === predicate);
      if (local) return exportedUnaryDeclaration(source, local) ? { localName: predicate, exportedName: predicate, declarationFileName: source.fileName } : undefined;
      if (!allowImports || !source.program.body.some(statement => statement.type === "ImportDeclaration" && statement.importKind !== "type"
        && statement.specifiers.some(item => item.type === "ImportSpecifier" && item.importKind !== "type" && item.local.name === predicate))) return undefined;
      native ??= openNativePredicates(files);
      return native.resolve(source, predicate);
    },
  };
}
