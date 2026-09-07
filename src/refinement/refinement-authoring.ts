export type RefinementProjection =
  | { readonly kind: "identity"; readonly path: string }
  | { readonly kind: "set-from-array"; readonly path: string }
  | { readonly kind: "map-from-entries"; readonly path: string };

export type RefinementRuntimeDescriptor =
  | { readonly kind: "global"; readonly identity: "globalThis"; readonly realm: "main" }
  | { readonly kind: "node-global"; readonly identity: `node:global@${number}#${string}`; readonly major: number; readonly realm: string };

export type RefinementCallable<Runtime, Result = unknown> = (runtime: Runtime, ...arguments_: never[]) => Result;

export interface RefinementDefinition<Runtime> {
  readonly name: string;
  readonly version: string;
  readonly runtime?: RefinementRuntimeDescriptor;
  readonly create: (initial: Runtime) => Runtime;
  readonly observe: (runtime: Runtime) => unknown;
  readonly abstractions: Readonly<Record<string, RefinementProjection>>;
  readonly actions: Readonly<Record<string, RefinementCallable<Runtime>>>;
  readonly invariants: Readonly<Record<string, RefinementCallable<Runtime, boolean>>>;
}

const dottedPath = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
export function projection(kind: RefinementProjection["kind"], path: string): RefinementProjection {
  if (!dottedPath.test(path)) throw new Error(`refinement projection requires a stable dotted property path: ${path}`);
  return { kind, path } as RefinementProjection;
}

export function identityProjection(path: string): RefinementProjection {
  return projection("identity", path);
}

export function setFromArrayProjection(path: string): RefinementProjection {
  return projection("set-from-array", path);
}

export function mapFromEntriesProjection(path: string): RefinementProjection {
  return projection("map-from-entries", path);
}

export function globalRuntime(realm: "main" = "main"): RefinementRuntimeDescriptor {
  if (realm !== "main") throw new Error("globalThis refinement runtime currently supports only the main realm");
  return { kind: "global", identity: "globalThis", realm };
}

export function nodeGlobalRuntime(major: number, realm: string): RefinementRuntimeDescriptor {
  if (!Number.isSafeInteger(major) || major <= 0) throw new Error("Node refinement runtime major must be a positive safe integer");
  if (!/^[A-Za-z_$][\w$-]*$/.test(realm)) throw new Error(`invalid Node refinement runtime realm: ${realm}`);
  return { kind: "node-global", identity: `node:global@${major}#${realm}`, major, realm };
}

export function defineRefinement<
  const Create extends (initial: any) => any,
  const Definition extends RefinementDefinition<ReturnType<Create>> & { readonly create: Create },
>(definition: Definition): Definition {
  return definition;
}
