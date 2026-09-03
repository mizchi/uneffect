import { resolve } from "node:path";
import type { SemanticPositionFact, SemanticQueryFrontend } from "./semantic-query.js";

export type { SemanticPositionFact, SemanticQueryFrontend } from "./semantic-query.js";

export interface CorsaApiFrontendOptions {
  configFile: string;
  corsaExecutable: string;
  cwd?: string;
}

export interface CorsaApiSymbolFact {
  id: string;
  name: string;
  declarations?: string[];
  valueDeclaration?: string;
}

export interface CorsaApiTypeFact {
  id: string;
  texts: string[];
  symbol?: string;
  value?: unknown;
}

export interface CorsaApiFrontend extends SemanticQueryFrontend {
  readonly compilerRevision: string;
  readonly projectId: string;
  readonly rootFiles: readonly string[];
  getSymbolAtPosition(file: string, position: number): CorsaApiSymbolFact | null;
  getTypeAtPosition(file: string, position: number): CorsaApiTypeFact | null;
  getTypesAtPositions(file: string, positions: readonly number[]): Array<CorsaApiTypeFact | null>;
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
  const client = await CorsaApiClient.spawnAsync({
    executable: resolve(options.corsaExecutable),
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
      if (!type || type.texts.length > 0) return type;
      return { ...type, texts: [client.typeToString(snapshot!.snapshot, project.id, type.id)] };
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
    return {
      compilerRevision: `corsa-api@${version()}`,
      projectId: project.id,
      rootFiles: [...project.rootFiles],
      getSymbolAtPosition(file, position) {
        assertOpen();
        return client.getSymbolAtPosition(snapshot!.snapshot, project.id, projectFile(file), position) as CorsaApiSymbolFact | null;
      },
      getTypeAtPosition(file, position) {
        assertOpen();
        return normalizeType(client.getTypeAtPosition(snapshot!.snapshot, project.id, projectFile(file), position) as CorsaApiTypeFact | null);
      },
      getTypesAtPositions(file, positions) {
        assertOpen();
        const source = projectFile(file);
        const types = client.callJson("getTypesAtPositions", {
          snapshot: snapshot!.snapshot,
          project: project.id,
          file: source,
          positions: [...positions],
        }) as Array<CorsaApiTypeFact | null>;
        return types.map(normalizeType);
      },
      queryPosition(file, position): SemanticPositionFact {
        assertOpen();
        const source = projectFile(file);
        const symbol = client.getSymbolAtPosition(snapshot!.snapshot, project.id, source, position) as CorsaApiSymbolFact | null;
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
