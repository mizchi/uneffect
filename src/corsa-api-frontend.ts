import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { SemanticPositionFact, SemanticQueryFrontend } from "./semantic-query.js";

export type { SemanticPositionFact, SemanticQueryFrontend } from "./semantic-query.js";

export interface CorsaApiFrontendOptions {
  configFile: string;
  /** Explicit Corsa-compatible compiler. Defaults to Uneffect's prebuilt tsgo. */
  corsaExecutable?: string;
  cwd?: string;
}

export interface CorsaApiSymbolFact {
  id: string;
  name: string;
  flags?: number;
  declarations?: string[];
  valueDeclaration?: string;
}

export interface CorsaApiTypeFact {
  id: string;
  texts: string[];
  symbol?: string;
  value?: unknown;
}

export type CorsaBuiltinOperation = "Fetch" | "Console";

export interface CorsaBuiltinCallQuery {
  readonly calleePosition: number;
  readonly receiverPosition?: number;
}

export interface CorsaBuiltinCallResolution {
  readonly operation: CorsaBuiltinOperation;
  readonly compilerRevision: string;
  readonly symbol: CorsaApiSymbolFact;
  readonly receiver?: CorsaApiSymbolFact;
}

export interface CorsaApiFrontend extends SemanticQueryFrontend {
  readonly compilerRevision: string;
  readonly compilerExecutable: string;
  readonly projectId: string;
  readonly rootFiles: readonly string[];
  getSymbolAtPosition(file: string, position: number): CorsaApiSymbolFact | null;
  getSymbolsAtPositions(file: string, positions: readonly number[]): Array<CorsaApiSymbolFact | null>;
  getAliasedSymbol(symbol: CorsaApiSymbolFact): CorsaApiSymbolFact | null;
  getImmediateAliasedSymbol(symbol: CorsaApiSymbolFact): CorsaApiSymbolFact | null;
  getExportsOfModule(symbol: CorsaApiSymbolFact): CorsaApiSymbolFact[];
  getTypeAtPosition(file: string, position: number): CorsaApiTypeFact | null;
  getTypesAtPositions(file: string, positions: readonly number[]): Array<CorsaApiTypeFact | null>;
  getPropertyOfType(type: CorsaApiTypeFact, name: string): CorsaApiSymbolFact | null;
  getSymbolOfType(type: CorsaApiTypeFact): CorsaApiSymbolFact | null;
  isTypeAssignableTo(source: CorsaApiTypeFact, target: CorsaApiTypeFact): boolean | null;
  /** Narrow checker-backed builtin slice currently admitted by migration tests. */
  classifyBuiltinCall(file: string, query: CorsaBuiltinCallQuery): CorsaBuiltinCallResolution | null;
  classifyBuiltinCalls(file: string, queries: readonly CorsaBuiltinCallQuery[]): Array<CorsaBuiltinCallResolution | null>;
}

const packageRequire = createRequire(import.meta.url);

function declaredByDomLibrary(symbol: CorsaApiSymbolFact | null): symbol is CorsaApiSymbolFact {
  return symbol !== null && (symbol.declarations ?? []).some((item) => /(?:^|[/\\])lib\.dom\.d\.ts$/.test(item));
}

function normalizeSymbol(input: unknown): CorsaApiSymbolFact | null {
  if (!input || typeof input !== "object") return null;
  const value = input as { id?: unknown; name?: unknown; flags?: unknown; declarations?: unknown; valueDeclaration?: unknown };
  if ((typeof value.id !== "string" && typeof value.id !== "number") || typeof value.name !== "string") return null;
  return {
    id: String(value.id), name: value.name,
    ...(typeof value.flags === "number" ? { flags: value.flags } : {}),
    ...(Array.isArray(value.declarations) && value.declarations.every((item) => typeof item === "string")
      ? { declarations: value.declarations as string[] } : {}),
    ...(typeof value.valueDeclaration === "string" ? { valueDeclaration: value.valueDeclaration } : {}),
  };
}

function typescript7NativePackage(): string {
  const platform = process.platform === "win32" ? "win32" : process.platform;
  return `@typescript/typescript-${platform}-${process.arch}`;
}

/**
 * Resolves an explicit compiler relative to the selected cwd, or Uneffect's
 * pinned TypeScript 7 native binary. It never searches PATH, never loads the
 * JavaScript `typescript` package, and does not fall back to TypeScript 6.
 */
export function resolveCorsaExecutable(options: Pick<CorsaApiFrontendOptions, "corsaExecutable" | "cwd"> = {}): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.corsaExecutable !== undefined) return resolve(cwd, options.corsaExecutable);
  const pkg = typescript7NativePackage();
  try {
    const root = dirname(packageRequire.resolve(`${pkg}/package.json`));
    const binary = process.platform === "win32" ? join(root, "lib", "tsc.exe") : join(root, "lib", "tsc");
    return binary;
  } catch (cause) {
    throw new Error(
      `No Corsa compiler was supplied and ${pkg} is unavailable; install the optional TypeScript 7 native package or pass corsaExecutable`,
      { cause },
    );
  }
}

interface CorsaProjectResponse {
  id: string;
  rootFiles: string[];
}

interface CorsaSnapshotResponse {
  snapshot: string;
  projects: CorsaProjectResponse[];
}

/**
 * Opens the prebuilt Corsa Node binding as a narrow, replaceable checker
 * frontend. Syntax traversal deliberately remains outside this adapter.
 */
export async function openCorsaApiFrontend(options: CorsaApiFrontendOptions): Promise<CorsaApiFrontend> {
  const { CorsaApiClient, version } = await import("@corsa-bind/napi");
  const configFile = resolve(options.configFile);
  const cwd = resolve(options.cwd ?? process.cwd());
  const compilerExecutable = resolveCorsaExecutable(options);
  const client = await CorsaApiClient.spawnAsync({
    executable: compilerExecutable,
    cwd,
    mode: "jsonrpc",
  });
  let snapshot: CorsaSnapshotResponse | undefined;
  try {
    await client.initializeAsync();
    snapshot = await client.updateSnapshotAsync({ openProject: configFile }) as CorsaSnapshotResponse;
    const project = snapshot.projects.find((item) => resolve(item.id) === configFile)
      ?? snapshot.projects.find((item) => item.rootFiles.length > 0);
    if (!project) throw new Error(`Corsa did not open a project for ${configFile}`);
    const roots = new Map(project.rootFiles.map((file) => [resolve(file), file]));
    const normalizeType = (type: CorsaApiTypeFact | null): CorsaApiTypeFact | null => {
      if (!type) return type;
      const id = String(type.id);
      const texts = type.texts?.length ? type.texts : [client.typeToString(snapshot!.snapshot, project.id, id)];
      return { ...type, id, texts };
    };
    const projectFile = (file: string): string => {
      const absolute = resolve(file);
      const known = roots.get(absolute);
      if (!known) throw new Error(`${absolute} is not part of the Corsa project`);
      return known;
    };
    let closed = false;
    const assertOpen = (): void => {
      if (closed) throw new Error("Corsa API frontend is closed");
    };
    const classify = (
      symbol: CorsaApiSymbolFact | null, receiver: CorsaApiSymbolFact | null | undefined,
      typeSymbol: CorsaApiSymbolFact | null = null,
    ): CorsaBuiltinCallResolution | null => {
      const fetchIdentity = typeSymbol?.name === "fetch" && declaredByDomLibrary(typeSymbol) ? typeSymbol : symbol;
      if (fetchIdentity?.name === "fetch" && declaredByDomLibrary(fetchIdentity) && receiver === undefined) {
        return { operation: "Fetch", compilerRevision: `corsa-api@${version()}`, symbol: fetchIdentity };
      }
      if (receiver?.name === "console" && declaredByDomLibrary(receiver) && declaredByDomLibrary(symbol)) {
        return { operation: "Console", compilerRevision: `corsa-api@${version()}`, symbol, receiver };
      }
      return null;
    };
    const typeSymbolAt = (source: string, position: number): CorsaApiSymbolFact | null => {
      const type = normalizeType(client.getTypeAtPosition(snapshot!.snapshot, project.id, source, position) as CorsaApiTypeFact | null);
      return type ? normalizeSymbol(client.getSymbolOfType(snapshot!.snapshot, type.id, project.id)) : null;
    };
    return {
      compilerRevision: `corsa-api@${version()}`,
      compilerExecutable,
      projectId: project.id,
      rootFiles: [...project.rootFiles],
      getSymbolAtPosition(file, position) {
        assertOpen();
        return normalizeSymbol(client.getSymbolAtPosition(snapshot!.snapshot, project.id, projectFile(file), position));
      },
      getSymbolsAtPositions(file, positions) {
        assertOpen();
        const symbols = client.getSymbolsAtPositions(
          snapshot!.snapshot, project.id, projectFile(file), [...positions],
        ) as unknown[];
        return (Array.isArray(symbols) ? symbols : []).map(normalizeSymbol);
      },
      getAliasedSymbol(symbol) {
        assertOpen();
        if (((symbol.flags ?? 0) & 2_097_152) === 0) return null;
        return normalizeSymbol(client.getAliasedSymbol(snapshot!.snapshot, project.id, symbol.id));
      },
      getImmediateAliasedSymbol(symbol) {
        assertOpen();
        if (((symbol.flags ?? 0) & 2_097_152) === 0) return null;
        return normalizeSymbol(client.getImmediateAliasedSymbol(snapshot!.snapshot, project.id, symbol.id));
      },
      getExportsOfModule(symbol) {
        assertOpen();
        const exported = client.getExportsOfModule(snapshot!.snapshot, project.id, symbol.id) as unknown;
        return (Array.isArray(exported) ? exported : []).flatMap((item) => {
          const normalized = normalizeSymbol(item);
          return normalized ? [normalized] : [];
        });
      },
      getTypeAtPosition(file, position) {
        assertOpen();
        return normalizeType(client.getTypeAtPosition(snapshot!.snapshot, project.id, projectFile(file), position) as CorsaApiTypeFact | null);
      },
      getTypesAtPositions(file, positions) {
        assertOpen();
        const types = client.getTypesAtPositions(
          snapshot!.snapshot, project.id, projectFile(file), [...positions],
        );
        return (Array.isArray(types) ? types : []).map((type) => normalizeType(type as CorsaApiTypeFact | null));
      },
      getPropertyOfType(type, name) {
        assertOpen();
        return normalizeSymbol(client.getPropertyOfType(snapshot!.snapshot, project.id, type.id, name));
      },
      getSymbolOfType(type) {
        assertOpen();
        return normalizeSymbol(client.getSymbolOfType(snapshot!.snapshot, type.id, project.id));
      },
      isTypeAssignableTo(source, target) {
        assertOpen();
        const assignable = client.isTypeAssignableTo(snapshot!.snapshot, project.id, source.id, target.id);
        return typeof assignable === "boolean" ? assignable : null;
      },
      classifyBuiltinCall(file, query) {
        assertOpen();
        const source = projectFile(file);
        const symbol = normalizeSymbol(client.getSymbolAtPosition(snapshot!.snapshot, project.id, source, query.calleePosition));
        const receiver = query.receiverPosition === undefined ? undefined
          : normalizeSymbol(client.getSymbolAtPosition(snapshot!.snapshot, project.id, source, query.receiverPosition));
        return classify(symbol, receiver, typeSymbolAt(source, query.calleePosition));
      },
      classifyBuiltinCalls(file, queries) {
        assertOpen();
        const source = projectFile(file);
        const positions = queries.flatMap((query) => [query.calleePosition, ...(query.receiverPosition === undefined ? [] : [query.receiverPosition])]);
        const symbols = (client.getSymbolsAtPositions(
          snapshot!.snapshot, project.id, source, positions,
        ) as unknown[] ?? []).map(normalizeSymbol);
        const calleeTypes = (client.getTypesAtPositions(
          snapshot!.snapshot, project.id, source, queries.map((query) => query.calleePosition),
        ) ?? []).map((type) => normalizeType(type as CorsaApiTypeFact | null));
        let offset = 0;
        return queries.map((query, index) => {
          const symbol = symbols[offset++] ?? null;
          const receiver = query.receiverPosition === undefined ? undefined : symbols[offset++] ?? null;
          const type = calleeTypes[index];
          const typeSymbol = type ? normalizeSymbol(client.getSymbolOfType(snapshot!.snapshot, type.id, project.id)) : null;
          return classify(symbol, receiver, typeSymbol);
        });
      },
      queryPosition(file, position): SemanticPositionFact {
        assertOpen();
        const source = projectFile(file);
        const symbol = normalizeSymbol(client.getSymbolAtPosition(snapshot!.snapshot, project.id, source, position));
        const type = normalizeType(client.getTypeAtPosition(snapshot!.snapshot, project.id, source, position) as CorsaApiTypeFact | null);
        return { symbol, type };
      },
      close() {
        if (closed) return;
        closed = true;
        client.releaseHandle(snapshot!.snapshot);
        client.close();
      },
    };
  } catch (error) {
    if (snapshot?.snapshot) client.releaseHandle(snapshot.snapshot);
    client.close();
    throw error;
  }
}
