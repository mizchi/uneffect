import { describe, expect, expectTypeOf, it } from "vitest";
import ts from "typescript";
import {
  defineRefinement,
  globalRuntime,
  identityProjection,
  mapFromEntriesProjection,
  parseRefinementDsl,
  resolveRefinementDslLink,
  setFromArrayProjection,
  validateRefinementDslIdentities,
} from "../src/refinement-dsl.js";

describe("TypeScript refinement DSL", () => {
  it("defines callable bindings and explicit projection descriptors", () => {
    type Runtime = { value: number; members: number[]; entries: Array<[number, number]> };
    const create = (initial: Runtime): Runtime => ({ ...initial });
    const observe = (runtime: Runtime): Runtime => runtime;
    const increment = (runtime: Runtime): void => { runtime.value += 1; };
    const nonnegative = (runtime: Runtime): boolean => runtime.value >= 0;

    const definition = defineRefinement({
      name: "counter",
      version: "1",
      runtime: globalRuntime(),
      create,
      observe,
      abstractions: {
        value: identityProjection("value"),
        members: setFromArrayProjection("members"),
        entries: mapFromEntriesProjection("entries"),
      },
      actions: { increment },
      invariants: { nonnegative },
    });

    expect(definition.name).toBe("counter");
    expect(definition.abstractions.members).toEqual({ kind: "set-from-array", path: "members" });
    expectTypeOf(definition.create).returns.toEqualTypeOf<Runtime>();
    expectTypeOf(definition.actions.increment).parameters.toEqualTypeOf<[Runtime]>();
  });

  it("rejects invalid projection paths and unsupported runtime identities", () => {
    expect(() => identityProjection("value[0]")).toThrow(/stable dotted property path/);
    expect(() => globalRuntime("worker" as "main")).toThrow(/main/);
  });

  it("parses a typed refinement module without executing it", () => {
    const source = `
      import { defineRefinement, globalRuntime, identityProjection, setFromArrayProjection } from "@mizchi/uneffect/spec";
      import { create, observe, increment, nonnegative } from "./counter.js";
      export default defineRefinement({
        name: "counter",
        version: "1",
        runtime: globalRuntime(),
        create,
        observe,
        abstractions: { value: identityProjection("value"), members: setFromArrayProjection("members") },
        actions: { increment },
        invariants: { nonnegative },
      });
    `;
    expect(parseRefinementDsl("counter.uneffect.ts", source)).toEqual({
      name: "counter",
      version: "1",
      runtimeIdentity: "globalThis",
      create: "create",
      observe: "observe",
      abstractions: { value: "value", members: "Set(members)" },
      actions: { increment: "increment" },
      invariants: { nonnegative: "nonnegative" },
    });
  });

  it("rejects dynamic or unknown refinement DSL expressions", () => {
    const source = `
      import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
      import { create, observe } from "./counter.js";
      const path = "value";
      export default defineRefinement({ name: "counter", version: "1", create, observe,
        abstractions: { value: identityProjection(path) }, actions: {}, invariants: {} });
    `;
    expect(() => parseRefinementDsl("dynamic.uneffect.ts", source)).toThrow(/string literal/);
    expect(() => parseRefinementDsl("dynamic.uneffect.ts", source.replace("identityProjection(path)", "customProjection(\"value\")")))
      .toThrow(/helpers must be imported from @mizchi\/uneffect\/spec/);
  });

  it("rejects same-spelled helpers without Uneffect TypeChecker identity", () => {
    const files: Record<string, string> = {
      "/spec.uneffect.ts": `import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
        import { create, observe } from "./counter.js";
        export default defineRefinement({ name: "counter", version: "1", create, observe,
          abstractions: { value: identityProjection("value") }, actions: {}, invariants: {} });`,
      "/fake.ts": `export const defineRefinement = (value: unknown) => value; export const identityProjection = (path: string) => ({ path });`,
      "/counter.ts": `export type Runtime = { value: number }; export const create = (value: Runtime) => value; export const observe = (value: Runtime) => value;`,
    };
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
    host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
    host.getSourceFile = (name, languageVersion, onError, fresh) => files[name] === undefined
      ? original(name, languageVersion, onError, fresh)
      : ts.createSourceFile(name, files[name], languageVersion, true, ts.ScriptKind.TS);
    host.resolveModuleNames = (names) => names.map((name) => ({
      resolvedFileName: name === "@mizchi/uneffect/spec" ? "/fake.ts" : "/counter.ts",
      extension: ts.Extension.Ts,
      isExternalLibraryImport: name === "@mizchi/uneffect/spec",
    }));
    const program = ts.createProgram({ rootNames: Object.keys(files), options, host });
    expect(() => validateRefinementDslIdentities(program, "/spec.uneffect.ts"))
      .toThrow(/does not resolve .* TypeChecker symbol identity/);
  });

  it("validates callable Runtime identity and invariant result types", () => {
    const specification = `import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
      import { create, observe, increment, nonnegative } from "./counter.js";
      export default defineRefinement({ name: "counter", version: "1", create, observe,
        abstractions: { value: identityProjection("value") }, actions: { increment }, invariants: { nonnegative } });`;
    const files: Record<string, string> = {
      "/spec.uneffect.ts": specification,
      "/refinement-dsl.ts": `export declare const defineRefinement: <T>(value: T) => T; export declare const identityProjection: (path: string) => unknown;`,
      "/counter.ts": `export type Runtime = { value: number }; export const create = (value: Runtime): Runtime => value;
        export const observe = (value: Runtime): Runtime => value; export const increment = (value: Runtime): void => {};
        export const nonnegative = (value: Runtime): boolean => true;`,
    };
    const options: ts.CompilerOptions = { strict: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const programFor = (counter: string): ts.Program => {
      files["/counter.ts"] = counter;
      const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
      host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
      host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
      host.getSourceFile = (name, languageVersion, onError, fresh) => files[name] === undefined
        ? original(name, languageVersion, onError, fresh)
        : ts.createSourceFile(name, files[name], languageVersion, true, ts.ScriptKind.TS);
      host.resolveModuleNames = (names) => names.map((name) => ({ resolvedFileName: name === "@mizchi/uneffect/spec" ? "/refinement-dsl.ts" : "/counter.ts", extension: ts.Extension.Ts }));
      return ts.createProgram({ rootNames: Object.keys(files), options, host });
    };
    expect(() => validateRefinementDslIdentities(programFor(files["/counter.ts"]!), "/spec.uneffect.ts")).not.toThrow();
    expect(() => validateRefinementDslIdentities(programFor(files["/counter.ts"]!.replace("(value: Runtime): boolean", "(value: Runtime): number")), "/spec.uneffect.ts"))
      .toThrow(/must return boolean/);
    expect(() => validateRefinementDslIdentities(programFor(files["/counter.ts"]!.replace("(value: Runtime): Runtime => value; export const increment", "(value: string): string => value; export const increment")), "/spec.uneffect.ts"))
      .toThrow(/observe must accept/);
  });

  it("lowers a refinement_from attachment to the v1 binding manifest", () => {
    const files = {
      "src/counter.ts": `/* uneffect:refinement_from "./counter.uneffect.ts#default" */
        export type Runtime = { value: number };
        export const create = (value: Runtime): Runtime => value;
        export const observe = (value: Runtime): Runtime => value;
        export const increment = (value: Runtime): void => { value.value += 1 };
        export const nonnegative = (value: Runtime): boolean => value.value >= 0;`,
      "src/counter.uneffect.ts": `import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
        import { create, observe, increment, nonnegative } from "./counter.js";
        export default defineRefinement({ name: "counter", version: "1", create, observe,
          abstractions: { value: identityProjection("value") }, actions: { increment }, invariants: { nonnegative } });`,
    };
    expect(resolveRefinementDslLink("src/counter.ts", files["src/counter.ts"], files)).toEqual({
      schema: "uneffect-refinement-bindings/v1",
      fileName: "src/counter.ts",
      adapterName: "counter",
      version: "1",
      create: "create",
      observe: "observe",
      abstractions: { value: "value" },
      actions: { increment: "increment" },
      invariants: { nonnegative: "nonnegative" },
    });
    expect(() => resolveRefinementDslLink("src/counter.ts", files["src/counter.ts"].replace("#default", "#Named"), files))
      .toThrow(/invalid refinement specification reference/);
    expect(() => resolveRefinementDslLink("src/counter.ts", files["src/counter.ts"].replace("counter.uneffect.ts", "missing.uneffect.ts"), files))
      .toThrow(/does not exist/);
  });
});
