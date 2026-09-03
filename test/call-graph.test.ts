import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildProgramCallGraph, instantiateCallbackEffects } from "../src/call-graph.js";
import { analyzeProgramEffects } from "../src/effects.js";
import { formatEffect, parseEffectExpression } from "../src/capabilities.js";
import { builtinContractRegistry, extendBuiltinContractRegistry } from "../src/builtin-contracts.js";

describe("multi-file call graph and effect polymorphism", () => {
  it("composes TypedArray callbacks and receiver mutations", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-typed-array-builtins-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        type State = { calls: number };
        /* uneffect:effect Mutate<typeof this.calls> | Mutate<typeof array> */
        function visit(this: State, value: number, index: number, array: Uint8Array) { this.calls++; array[index] = value }
        /* uneffect:effect Mutate<typeof array> */
        function reduce(_sum: number, value: number, index: number, array: Uint8Array): number { array[index] = value; return value }
        /* uneffect:effect Console | Throw<RangeError> */
        function compare(left: number, right: number): number { console.log(left, right); if (left < 0) throw new RangeError("sort"); return left - right }
        /* uneffect:effect Console */ function mapValue(value: number): number { console.log(value); return value }

        /* uneffect:effect Mutate<typeof state.calls> | Mutate<typeof values> */
        export function each(values: Uint8Array, state: State) { values.forEach(visit, state) }
        /* uneffect:effect Mutate<typeof values> */
        export function reduced(values: Uint8Array) { return values.reduce(reduce, 0) }
        export function sorted(values: Uint8Array) { return values.sort(compare) }
        /* uneffect:effect Console | Mutate<typeof values> */ export function caughtSort(values: Uint8Array) { try { return values.sort(compare) } catch { return values } }
        /* uneffect:effect Console */ export function mapped(values: Uint8Array) { return values.map(mapValue) }
        /* uneffect:effect Mutate<typeof values> */ export function filled(values: Uint8Array) { return values.fill(0) }
        /* uneffect:effect Mutate<typeof values> */ export function copied(values: Uint8Array, source: Uint8Array) { values.set(source) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics.filter((diagnostic) => ["each", "reduced", "caughtSort", "mapped", "filled", "copied"].includes(diagnostic.functionName))).toEqual([]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "sorted", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "sorted", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "sorted", effect: "Mutate<typeof values>", kind: "missing" }),
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves mutation contracts for every standard TypedArray owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-typed-array-owner-matrix-"));
    try {
      const entry = join(directory, "entry.ts");
      const owners = [
        "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
        "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
      ];
      writeFileSync(entry, owners.map((owner) => `
        /* uneffect:effect Mutate<typeof values> */
        export function reverse${owner}(values: ${owner}) { return values.reverse() }
      `).join("\n"));
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes String replacement and ES2024 grouping callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-replace-groupby-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:effect Console | Throw<TypeError> */
        function replacement(match: string): string { console.log(match); if (match === "!") throw new TypeError("replace"); return match }
        /* uneffect:effect Console | Throw<RangeError> */
        function classify(value: number): "even" | "odd" { console.log(value); if (value < 0) throw new RangeError("group"); return value % 2 ? "odd" : "even" }
        /* uneffect:effect Console | Throw<URIError> */
        function* values() { console.log("iterate"); yield 1; throw new URIError("iterate") }
        /* uneffect:effect Mutate<typeof value.count> */
        function classifyBox(value: { count: number }): string { value.count++; return String(value.count) }

        export function replaceOne(input: string) { return input.replace("x", replacement) }
        export function replaceEvery(input: string) { return input.replaceAll("x", replacement) }
        export function objectGroups() { return Object.groupBy(values(), classify) }
        export function mapGroups() { return Map.groupBy(values(), classify) }
        export function opaqueGroupElement(values: Array<{ count: number }>) { return Object.groupBy(values, classifyBox) }
        /* uneffect:effect Console */
        export function caught(input: string) { try { return input.replace("x", replacement) } catch { return input } }
        /* uneffect:effect Console */
        export function caughtGrouping() { try { return Object.groupBy(values(), classify) } catch { return {} } }
        const lookalike = { replace(callback: (value: string) => string) { return callback("x") } };
        /* uneffect:effect Console | Throw<TypeError> */
        export function local() { return lookalike.replace(replacement) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["replaceOne", "replaceEvery"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<TypeError>", kind: "missing" }),
        ]));
      }
      for (const functionName of ["objectGroups", "mapGroups"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<RangeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<URIError>", kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) => ["caught", "caughtGrouping", "local"].includes(diagnostic.functionName))).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "opaqueGroupElement", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps runtime callback values distinct while projecting explicit thisArg", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callback-invocation-shapes-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        import { readFile } from "node:fs";
        type Box = { count: number };
        /* uneffect:effect Mutate<typeof value.count> */
        function mutateValue(value: Box): Box { value.count++; return value }
        /* uneffect:effect Mutate<typeof this.count> */
        function mapWithOwner(this: Box, value: number): number { this.count++; return value }
        /* uneffect:effect Mutate<typeof value.count> */
        function mapValue(value: Box): Box { value.count++; return value }
        /* uneffect:effect Mutate<typeof this.count> */
        function mutateHolder(this: Box, _key: string, value: unknown): unknown { this.count++; return value }
        /* uneffect:effect Console */ function finalized() { console.log("done") }
        /* uneffect:effect Mutate<typeof data[0]> */
        function mutateFileData(_error: NodeJS.ErrnoException | null, data: Buffer) { data[0] = 0 }

        export function fulfilled(promise: Promise<Box>) { return promise.then(mutateValue) }
        export function rejected(promise: Promise<Box>) { return promise.catch(mutateValue) }
        /* uneffect:effect Console */ export function finallyRun(promise: Promise<Box>) { return promise.finally(finalized) }
        /* uneffect:effect Mutate<typeof owner.count> */
        export function fromWithThis(values: number[], owner: Box) { return Array.from(values, mapWithOwner, owner) }
        export function fromOpaqueElement(values: Box[]) { return Array.from(values, mapValue) }
        export function stringifyHolder(value: number) { return JSON.stringify(value, mutateHolder) }
        /* uneffect:effect Timer | Mutate<typeof value.count> */
        export function timerArgument(value: Box) { setTimeout(mutateValue, 0, value) }
        export function nodeCallback(path: string) { readFile(path, mutateFileData) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics.filter((diagnostic) => ["finallyRun", "fromWithThis", "timerArgument"].includes(diagnostic.functionName))).toEqual([]);
      for (const functionName of ["fulfilled", "rejected", "fromOpaqueElement", "stringifyHolder", "nodeCallback"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, kind: "unknown", effect: "Mutate<unknown-alias>",
        }));
        expect(result.diagnostics.some((diagnostic) => diagnostic.functionName === functionName
          && diagnostic.kind === "missing" && /Mutate<typeof (?:value|this)/.test(diagnostic.effect))).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes standard Map and Set forEach callbacks synchronously", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-map-set-foreach-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:effect Console | Throw<TypeError> */
        function inspect() { console.log("item"); throw new TypeError("item") }
        /* uneffect:effect Mutate<typeof collection> */
        function clearMap(_value: number, _key: string, collection: Map<string, number>) { collection.clear() }
        /* uneffect:effect Mutate<typeof value.count> */
        function mutateValue(value: { count: number }) { value.count++ }
        /* uneffect:effect Mutate<typeof collection> */
        function clearArray(_value: number, _index: number, collection: number[]) { collection.length = 0 }
        /* uneffect:effect Mutate<typeof this.count> */
        function incrementOwner(this: { count: number }, _value: number) { this.count++ }
        export function mapEach(values: Map<string, number>) { values.forEach(inspect) }
        export function readonlyMapEach(values: ReadonlyMap<string, number>) { values.forEach(inspect) }
        export function setEach(values: Set<number>) { values.forEach(inspect) }
        export function readonlySetEach(values: ReadonlySet<number>) { values.forEach(inspect) }
        /* uneffect:effect Mutate<typeof values> */
        export function clearFromCallback(values: Map<string, number>) { values.forEach(clearMap) }
        export function mutateOpaqueElement(values: Set<{ count: number }>) { values.forEach(mutateValue) }
        /* uneffect:effect Mutate<typeof values> */
        export function clearArrayFromCallback(values: number[]) { values.forEach(clearArray) }
        /* uneffect:effect Mutate<typeof owner.count> */
        export function arrayThisArgument(values: number[], owner: { count: number }) { values.forEach(incrementOwner, owner) }
        export function mutateOpaqueArrayElement(values: Array<{ count: number }>) { values.forEach(mutateValue) }
        /* uneffect:effect Console */
        export function caught(values: Map<string, number>) { try { values.forEach(inspect) } catch {} }
        /* uneffect:effect Mutate<typeof values> */
        export function weakMapSet(values: WeakMap<object, number>, key: object) { values.set(key, 1) }
        /* uneffect:effect Mutate<typeof values> */
        export function weakMapDelete(values: WeakMap<object, number>, key: object) { values.delete(key) }
        /* uneffect:effect Mutate<typeof values> */
        export function weakSetAdd(values: WeakSet<object>, key: object) { values.add(key) }
        /* uneffect:effect Mutate<typeof values> */
        export function weakSetDelete(values: WeakSet<object>, key: object) { values.delete(key) }
        const lookalike = { forEach(callback: () => void) { queueMicrotask(callback) } };
        /* uneffect:effect Timer | Console | Throw<TypeError> */
        export function local() { lookalike.forEach(inspect) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["mapEach", "readonlyMapEach", "setEach", "readonlySetEach"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<TypeError>", kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) => [
        "caught", "clearFromCallback", "clearArrayFromCallback", "arrayThisArgument",
        "weakMapSet", "weakMapDelete", "weakSetAdd", "weakSetDelete", "local",
      ].includes(diagnostic.functionName))).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "mutateOpaqueElement", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "mutateOpaqueArrayElement", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes structuredClone enumerable getters and exposes clone failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-structured-clone-hooks-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        const source = {
          reads: 0,
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("get"); if (this.reads < 0) throw new TypeError("get"); return 1 }
        };
        export function cloneKnown(value: typeof source) { return structuredClone(value) }
        export function cloneNestedLiteral(value: typeof source) { return structuredClone({ nested: value }) }
        /* uneffect:effect Clone<typeof value> | Throw<DOMException> */
        export function clonePlain(value: { count: number }) { return structuredClone(value) }
        /* uneffect:effect Clone<typeof value> | InvokeUserCode | Throw<DOMException> */
        export function cloneUnknown(value: unknown) { return structuredClone(value) }
        /* uneffect:effect Clone<typeof proxy> | Throw<DOMException> */
        export function cloneProxy(value: object) { const proxy = new Proxy(value, {}); return structuredClone(proxy) }
        /* uneffect:effect Clone<typeof value> | InvokeUserCode | Console | Mutate<typeof value.reads> */
        export function caught(value: typeof source) { try { return structuredClone(value) } catch { return null } }
        const localStructuredClone = <T>(value: T): T => value;
        export function lookalike(value: typeof source) { return localStructuredClone(value) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["cloneKnown", "cloneNestedLiteral"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<TypeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<DOMException>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: expect.stringMatching(/^Mutate</), kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) =>
        ["clonePlain", "cloneUnknown", "cloneProxy", "caught", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes Object.assign source getters and target setters", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-object-assign-hooks-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Target {
          writes = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.writes> */
          set value(next: number) { this.writes++; console.log(next); if (next < 0) throw new RangeError("set") }
        }
        class PrototypeSource {
          /* uneffect:effect Console */ get value(): number { console.log("prototype"); return 1 }
        }
        const sourceObject = {
          reads: 0,
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("get"); if (this.reads < 0) throw new TypeError("get"); return 1 }
        };
        export function copy(target: Target, source: typeof sourceObject) { return Object.assign(target, source) }
        /* uneffect:effect InvokeUserCode | Mutate<typeof target> */ export function copyUnknown(target: {}, source: unknown) { return Object.assign(target, source) }
        /* uneffect:effect InvokeUserCode | Mutate<typeof target> */ export function copyGeneric<T extends object>(target: {}, source: T) { return Object.assign(target, source) }
        /* uneffect:effect InvokeUserCode | Mutate<typeof target> */ export function copyProxy(target: {}, source: typeof sourceObject) { return Object.assign(target, new Proxy(source, {})) }
        /* uneffect:effect InvokeUserCode */ export function copyProxyTarget(target: Target, source: { value: number }) { return Object.assign(new Proxy(target, {}), source) }
        /* uneffect:effect Mutate<typeof target> */ export function copyPlain(target: { value: number }, source: { value: number }) { return Object.assign(target, source) }
        /* uneffect:effect Mutate<typeof target> */ export function copyPrototype(target: Target, source: PrototypeSource) { return Object.assign(target, source) }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof target> | Mutate<typeof target.writes> | Mutate<typeof source.reads> */
        export function caught(target: Target, source: typeof sourceObject) { try { return Object.assign(target, source) } catch { return target } }
        const LocalObject = { assign: <T, U>(target: T, _source: U): T => target };
        export function lookalike(target: Target, source: typeof sourceObject) { return LocalObject.assign(target, source) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "copy", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "copy", effect: "Throw<TypeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "copy", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "copy", effect: "Mutate<typeof source.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "copy", effect: "Mutate<typeof target.writes>", kind: "missing" }),
        expect.objectContaining({ functionName: "copy", effect: "Mutate<typeof target>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) =>
        ["copyUnknown", "copyGeneric", "copyProxy", "copyPlain", "copyPrototype", "caught", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
      for (const functionName of ["copyProxyTarget"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName, kind: "missing", effect: expect.stringMatching(/^Mutate</) }));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes Object value enumeration from key enumeration", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-object-enumeration-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        const sourceObject = {
          reads: 0,
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("get"); if (this.reads < 0) throw new TypeError("get"); return 1 }
        };
        class PrototypeSource {
          /* uneffect:effect Console */ get value(): number { console.log("prototype"); return 1 }
        }
        export function values(source: typeof sourceObject) { return Object.values(source) }
        export function entries(source: typeof sourceObject) { return Object.entries(source) }
        export function keys(source: typeof sourceObject) { return Object.keys(source) }
        /* uneffect:effect InvokeUserCode */ export function unknown(source: any) { return Object.values(source) }
        /* uneffect:effect InvokeUserCode */ export function generic<T extends object>(source: T) { return Object.entries(source) }
        /* uneffect:effect InvokeUserCode */ export function proxy(source: typeof sourceObject) { return Object.values(new Proxy(source, {})) }
        /* uneffect:effect InvokeUserCode */ export function proxyKeys(source: typeof sourceObject) { return Object.keys(new Proxy(source, {})) }
        export function prototype(source: PrototypeSource) { return Object.values(source) }
        export function primitive(source: string) { return Object.values(source) }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof source.reads> */
        export function caught(source: typeof sourceObject) { try { return Object.entries(source) } catch { return [] } }
        const LocalObject = { values: <T>(_source: T): unknown[] => [] };
        export function lookalike(source: typeof sourceObject) { return LocalObject.values(source) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["values", "entries"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<TypeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof source.reads>", kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) =>
        ["keys", "unknown", "generic", "proxy", "proxyKeys", "prototype", "primitive", "caught", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes Reflect.get and Reflect.set accessor hooks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-reflect-accessors-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Box {
          reads = 0; writes = 0;
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("get"); if (this.reads < 0) throw new TypeError("get"); return 1 }
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.writes> */
          set value(next: number) { this.writes++; console.log(next); if (next < 0) throw new RangeError("set") }
        }
        export function read(box: Box) { return Reflect.get(box, "value") }
        export function write(box: Box, next: number) { return Reflect.set(box, "value", next) }
        export function readWithReceiver(owner: Box, receiver: Box) { return Reflect.get(owner, "value", receiver) }
        export function writeWithReceiver(owner: Box, receiver: Box, next: number) { return Reflect.set(owner, "value", next, receiver) }
        export function readUnion(box: Box, key: "value" | "other") { return Reflect.get(box, key) }
        /* uneffect:effect InvokeUserCode */ export function dynamic(box: Box, key: string) { return Reflect.get(box, key) }
        /* uneffect:effect InvokeUserCode */ export function unknown(box: any) { return Reflect.get(box, "value") }
        /* uneffect:effect InvokeUserCode */ export function proxy(box: Box) { return Reflect.get(new Proxy(box, {}), "value") }
        export function has(box: Box) { return Reflect.has(box, "value") }
        /* uneffect:effect Mutate<typeof box> */ export function remove(box: Box) { return Reflect.deleteProperty(box, "value") }
        /* uneffect:effect InvokeUserCode */ export function proxyHas(box: Box) { return Reflect.has(new Proxy(box, {}), "value") }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof box.reads> */
        export function caught(box: Box) { try { return Reflect.get(box, "value") } catch { return undefined } }
        const LocalReflect = { get: <T>(_target: T, _key: PropertyKey): unknown => undefined };
        export function lookalike(box: Box) { return LocalReflect.get(box, "value") }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "read", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "read", effect: "Throw<TypeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "read", effect: "Mutate<typeof box.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Mutate<typeof box.writes>", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Mutate<typeof box>", kind: "missing" }),
        expect.objectContaining({ functionName: "readWithReceiver", effect: "Mutate<typeof receiver.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "writeWithReceiver", effect: "Mutate<typeof owner>", kind: "missing" }),
        expect.objectContaining({ functionName: "writeWithReceiver", effect: "Mutate<typeof receiver>", kind: "missing" }),
        expect.objectContaining({ functionName: "writeWithReceiver", effect: "Mutate<typeof receiver.writes>", kind: "missing" }),
        expect.objectContaining({ functionName: "readUnion", effect: "Mutate<typeof box.reads>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) =>
        ["dynamic", "unknown", "proxy", "has", "remove", "proxyHas", "caught", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes standard call/apply wrappers into the underlying callable", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-indirect-call-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class State { calls = 0 }
        class Value { used = 0 }
        /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> | Mutate<typeof value.used> */
        function run(this: State, value: Value): number {
          this.calls++; value.used++; console.log(value.used);
          if (value.used < 0) throw new RangeError("run"); return value.used;
        }
        const alias = run;
        export function viaCall(state: State, value: Value) { return run.call(state, value) }
        export function viaAlias(state: State, value: Value) { return alias.call(state, value) }
        export function viaApply(state: State, value: Value) { return run.apply(state, [value]) }
        export function viaApplyTuple(state: State, value: Value) { const args: [Value] = [value]; return run.apply(state, args) }
        export function viaReflect(state: State, value: Value) { return Reflect.apply(run, state, [value]) }
        /* uneffect:effect Console | Mutate<typeof state.calls> | Mutate<typeof value.used> */
        export function caught(state: State, value: Value) { try { return run.call(state, value) } catch { return 0 } }
        /* uneffect:effect InvokeUserCode */
        export function dynamic(fn: (this: State, value: Value) => number, state: State, value: Value) { return fn.call(state, value) }
        /* uneffect:effect InvokeUserCode | Console | Throw<RangeError> | Mutate<typeof state.calls> */
        export function dynamicArguments(state: State, values: [Value]) { return run.apply(state, values) }
        /* uneffect:effect InvokeUserCode | Console | Throw<RangeError> | Mutate<typeof state.calls> */
        export function mutatedArguments(state: State, value: Value, other: Value) { const args: [Value] = [value]; args[0] = other; return run.apply(state, args) }
        /* uneffect:effect InvokeUserCode */
        export function proxy(state: State, value: Value) { return new Proxy(run, {}).call(state, value) }
        const fake = { call(_state: State, _value: Value) { return 1 } };
        export function lookalike(state: State, value: Value) { return fake.call(state, value) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
        strict: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["viaCall", "viaAlias", "viaApply", "viaApplyTuple", "viaReflect"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<RangeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof state.calls>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof value.used>", kind: "missing" }),
        ]));
        expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === functionName
          && (diagnostic.effect === "InvokeUserCode" || diagnostic.kind === "unknown"))).toEqual([]);
      }
      expect(result.diagnostics.filter((diagnostic) =>
        ["caught", "dynamic", "proxy", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "dynamicArguments", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "mutatedArguments", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defers bound callable effects until invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-bound-call-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class State { calls = 0 }
        class Value { used = 0 }
        /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> | Mutate<typeof value.used> */
        function run(this: State, value: Value): number {
          this.calls++; value.used++; console.log(value.used);
          if (value.used < 0) throw new RangeError("run"); return value.used;
        }
        export function createOnly(state: State, value: Value) { const bound = run.bind(state, value); return 1 }
        export function invoke(state: State, value: Value) { const bound = run.bind(state, value); return bound() }
        export function partial(state: State, value: Value) { const bound = run.bind(state); return bound(value) }
        export function aliased(state: State, value: Value) { const bound = run.bind(state, value); const renamed = bound; return renamed() }
        export function twice(state: State, value: Value) { const bound = run.bind(state, value); bound(); return bound() }
        export function throughCall(state: State, value: Value) { const bound = run.bind(state, value); return bound.call(undefined) }
        export function throughApply(state: State, value: Value) { const bound = run.bind(state); return bound.apply(undefined, [value]) }
        /* uneffect:effect Console | Mutate<typeof state.calls> | Mutate<typeof value.used> */
        export function caught(state: State, value: Value) { const bound = run.bind(state, value); try { return bound() } catch { return 0 } }
        export function escape(state: State, value: Value) { return run.bind(state, value) }
        function observe(_fn: () => number) {}
        /* uneffect:effect InvokeUserCode */
        export function escapedThenInvoke(state: State, value: Value) { const bound = run.bind(state, value); observe(bound); return bound() }
        /* uneffect:effect InvokeUserCode */
        export function dynamic(fn: (this: State, value: Value) => number, state: State, value: Value) { const bound = fn.bind(state, value); return bound() }
        /* uneffect:effect InvokeUserCode */
        export function proxy(state: State, value: Value) { const bound = new Proxy(run, {}).bind(state, value); return bound() }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
        strict: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["invoke", "partial", "aliased", "twice", "throughCall", "throughApply"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<RangeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof state.calls>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof value.used>", kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) =>
        ["createOnly", "caught", "escape", "escapedThenInvoke", "dynamic", "proxy"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes Reflect.construct into same-Program constructors", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-reflect-construct-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Value { used = 0 }
        class Built {
          count = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.count> | Mutate<typeof value.used> */
          constructor(value: Value) { this.count++; value.used++; console.log(value.used); if (value.used < 0) throw new RangeError("build") }
        }
        /* uneffect:effect Console */ function initialize(): number { console.log("field"); return 1 }
        class Implicit { field = initialize() }
        export function build(value: Value) { const result = Reflect.construct(Built, [value]); return result }
        export function implicit() { const result = Reflect.construct(Implicit, []); return result }
        /* uneffect:effect Console | Mutate<typeof value.used> */
        export function caught(value: Value) { try { const result = Reflect.construct(Built, [value]); return result } catch { return undefined } }
        /* uneffect:effect InvokeUserCode */
        export function dynamicTarget(Ctor: new (value: Value) => Built, value: Value) { return Reflect.construct(Ctor, [value]) }
        /* uneffect:effect InvokeUserCode | Console | Throw<RangeError> */
        export function dynamicArguments(value: Value, args: [Value]) { const result = Reflect.construct(Built, args); return result }
        /* uneffect:effect InvokeUserCode */
        export function proxy(value: Value) { return Reflect.construct(new Proxy(Built, {}), [value]) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
        strict: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "build", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "build", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "build", effect: "Mutate<typeof value.used>", kind: "missing" }),
        expect.objectContaining({ functionName: "implicit", effect: "Console", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) =>
        ["caught", "dynamicTarget", "proxy"].includes(diagnostic.functionName))).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "dynamicArguments", kind: "unknown", effect: "Mutate<unknown-alias>",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks standard object mutation and descriptor hooks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-object-mutation-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Descriptor {
          reads = 0;
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("descriptor"); if (this.reads < 0) throw new TypeError("descriptor"); return 1 }
        }
        export function define(target: object, descriptor: Descriptor) { return Object.defineProperty(target, "value", descriptor) }
        export function reflectDefine(target: object, descriptor: Descriptor) { return Reflect.defineProperty(target, "value", descriptor) }
        export function defineMany(target: object, descriptor: Descriptor) { return Object.defineProperties(target, { value: descriptor }) }
        /* uneffect:effect Mutate<typeof target> */
        export function plain(target: object) { return Object.defineProperty(target, "value", { value: 1 }) }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof target> | Mutate<typeof descriptor.reads> */
        export function caught(target: object, descriptor: Descriptor) { try { return Object.defineProperty(target, "value", descriptor) } catch { return target } }
        /* uneffect:effect Mutate<typeof target> */ export function freeze(target: object) { return Object.freeze(target) }
        /* uneffect:effect Mutate<typeof target> */ export function seal(target: object) { return Object.seal(target) }
        /* uneffect:effect Mutate<typeof target> */ export function prevent(target: object) { return Object.preventExtensions(target) }
        /* uneffect:effect Mutate<typeof target> */ export function setProto(target: object, proto: object | null) { return Object.setPrototypeOf(target, proto) }
        /* uneffect:effect Mutate<typeof target> */ export function reflectSetProto(target: object, proto: object | null) { return Reflect.setPrototypeOf(target, proto) }
        /* uneffect:effect InvokeUserCode */ export function proxy(target: object) { const wrapped = new Proxy(target, {}); Object.freeze(wrapped) }
        const LocalObject = { defineProperty<T>(_target: T, _key: PropertyKey, _descriptor: PropertyDescriptor): T { return _target } };
        export function lookalike(target: object, descriptor: Descriptor) { return LocalObject.defineProperty(target, "value", descriptor) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
        strict: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["define", "reflectDefine", "defineMany"]) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName, effect: "Console", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Throw<TypeError>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof descriptor.reads>", kind: "missing" }),
          expect.objectContaining({ functionName, effect: "Mutate<typeof target>", kind: "missing" }),
        ]));
      }
      expect(result.diagnostics.filter((diagnostic) =>
        ["plain", "caught", "freeze", "seal", "prevent", "setProto", "reflectSetProto", "proxy", "lookalike"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("separates Object.create descriptor conversion from descriptor inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-object-descriptors-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Descriptor {
          reads = 0;
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.reads> */
          get value(): number { this.reads++; console.log("descriptor"); if (this.reads < 0) throw new TypeError("descriptor"); return 1 }
        }
        const source = {
          /* uneffect:effect Console */ get value(): number { console.log("ordinary getter"); return 1 }
        };
        export function create(descriptor: Descriptor) { return Object.create(null, { value: descriptor }) }
        export function createPlain() { return Object.create(null, { value: { value: 1 } }) }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof descriptor.reads> */
        export function caught(descriptor: Descriptor) { try { return Object.create(null, { value: descriptor }) } catch { return undefined } }
        export function inspect() { return Object.getOwnPropertyDescriptor(source, "value") }
        export function inspectAll() { return Object.getOwnPropertyDescriptors(source) }
        export function owns() { return Object.hasOwn(source, "value") }
        /* uneffect:effect InvokeUserCode */ export function inspectProxy() { return Object.getOwnPropertyDescriptor(new Proxy(source, {}), "value") }
        /* uneffect:effect InvokeUserCode */ export function inspectAllProxy() { return Object.getOwnPropertyDescriptors(new Proxy(source, {})) }
        /* uneffect:effect InvokeUserCode */ export function ownsProxy() { return Object.hasOwn(new Proxy(source, {}), "value") }
        /* uneffect:effect InvokeUserCode */ export function inspectUnknown(value: any) { return Object.getOwnPropertyDescriptor(value, "value") }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
        strict: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "create", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "create", effect: "Throw<TypeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "create", effect: "Mutate<typeof descriptor.reads>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) =>
        ["createPlain", "caught", "inspect", "inspectAll", "owns", "inspectProxy", "inspectAllProxy", "ownsProxy", "inspectUnknown"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes JSON.stringify toJSON and enumerable getter hooks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-json-hooks-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Payload {
          calls = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> */
          toJSON(key: string) { this.calls++; console.log(key); if (this.calls < 0) throw new RangeError("json"); return { ok: true } }
        }
        const getterObject = {
          calls: 0,
          /* uneffect:effect Console | Throw<TypeError> | Mutate<typeof this.calls> */
          get value(): number { this.calls++; console.log("getter"); throw new TypeError("getter") }
        }
        export function encode(payload: Payload) { return JSON.stringify(payload) }
        export function encodeGetter(value: typeof getterObject) { return JSON.stringify(value) }
        /* uneffect:effect InvokeUserCode */ export function encodeUnknown(value: unknown) { return JSON.stringify(value) }
        /* uneffect:effect InvokeUserCode */ export function encodeArray(values: Payload[]) { return JSON.stringify(values) }
        export function encodePrimitive(value: string) { return JSON.stringify(value) }
        export function encodePlain(value: { ready: boolean }) { return JSON.stringify(value) }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof payload.calls> */
        export function caught(payload: Payload) { try { return JSON.stringify(payload) } catch { return undefined } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "encode", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "encode", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "encode", effect: "Mutate<typeof payload.calls>", kind: "missing" }),
        expect.objectContaining({ functionName: "encodeGetter", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "encodeGetter", effect: "Throw<TypeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "encodeGetter", effect: "Mutate<typeof value.calls>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) => ["encodeUnknown", "encodeArray", "encodePrimitive", "encodePlain", "caught"].includes(diagnostic.functionName))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes getter effects from direct object destructuring", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-destructure-getter-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Box {
          reads = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.reads> */
          get value() { this.reads++; console.log("get"); if (this.reads < 0) throw new RangeError("get"); return 1 }
        }
        class ReadonlyBox {
          /* uneffect:effect Console | Throw<RangeError> */
          get value(): number { console.log("parameter get"); throw new RangeError("get") }
        }
        class Inner {
          /* uneffect:effect Console | Throw<RangeError> */
          get value(): number { console.log("nested get"); throw new RangeError("nested") }
        }
        class MutableInner {
          reads = 0;
          /* uneffect:effect Console | Mutate<typeof this.reads> */
          get value() { this.reads++; console.log("nested mutable"); return 1 }
        }
        class Outer { readonly inner = new Inner() }
        class MutableOuter { readonly inner = new MutableInner() }
        class Key {
          /* uneffect:effect Console | Throw<TypeError> */
          [Symbol.toPrimitive]() { console.log("key"); throw new TypeError("key") }
        }
        /* uneffect:effect Random */ function fallback() { crypto.getRandomValues(new Uint8Array(1)); return 0 }
        export function direct(box: Box) { const { value } = box; return value }
        export function renamed(source: Box) { const { value: result = fallback() } = source; return result }
        export function parameter({ value }: ReadonlyBox) { return value }
        export function parameterBodyCatch({ value }: ReadonlyBox) { try { return value } catch { return 0 } }
        export function nested(source: Outer) { const { inner: { value } } = source; return value }
        export function nestedMutable(source: MutableOuter) { const { inner: { value } } = source; return value }
        export function computed(source: Record<string, number>, key: Key & string) { const { [key]: value } = source; return value }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof caught.reads> */
        export function caughtRead(caught: Box) { try { const { value } = caught; return value } catch { return 0 } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "direct", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "direct", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "direct", effect: "Mutate<typeof box.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "renamed", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "renamed", effect: "Random", kind: "missing" }),
        expect.objectContaining({ functionName: "renamed", effect: "Mutate<typeof source.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "parameter", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "parameter", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "parameterBodyCatch", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "nested", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "nested", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "nestedMutable", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "computed", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "computed", effect: "Throw<TypeError>", kind: "missing" }),
      ]));
      expect(result.summaries.find((summary) => summary.functionName === "parameter"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "nested"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "nestedMutable"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unresolved-mutation-alias" })] });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caughtRead")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes enumerable object-literal getters through object spread and rest", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-object-copy-getter-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        const object = {
          calls: 0,
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> */
          get value() { this.calls++; console.log("copy"); if (this.calls < 0) throw new RangeError("copy"); return 1 }
        }
        export function spread(source: typeof object) { return { ...source } }
        export function rest(source: typeof object) { const { calls, ...remaining } = source; return remaining }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof source.calls> */
        export function caught(source: typeof object) { try { return { ...source } } catch { return {} } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      for (const functionName of ["spread", "rest"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName, effect: "Console", kind: "missing" }));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName, effect: "Throw<RangeError>", kind: "missing" }));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName, effect: "Mutate<typeof source.calls>", kind: "missing" }));
      }
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caught")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes a local Symbol.hasInstance hook through instanceof", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-has-instance-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Matcher {
          static calls = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> */
          static [Symbol.hasInstance](value: unknown) {
            this.calls++; console.log(value); if (this.calls < 0) throw new RangeError("match"); return true
          }
        }
        export function matches(candidate: unknown) { return candidate instanceof Matcher }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof Matcher.calls> */
        export function caught(candidate: unknown) { try { return candidate instanceof Matcher } catch { return false } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const matches = graph.nodes.find((node) => node.name === "matches")!;
      const hook = graph.nodes.find((node) => node.name === "[Symbol.hasInstance]")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: matches.id, callee: hook.id, receiver: "Matcher", arguments: ["candidate"],
        kind: "direct", timing: "inline", executesBody: true,
      }));
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "matches", effect: "InvokeUserCode", kind: "missing" }),
        expect.objectContaining({ functionName: "matches", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "matches", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "matches", effect: "Mutate<typeof Matcher.calls>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caught")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes local constructor bodies, defaults, and instance field initializers", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-constructor-effects-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:effect Random */ function initialize() { crypto.getRandomValues(new Uint8Array(1)); return 1 }
        /* uneffect:effect Console */ function defaults() { console.log("default"); return 0 }
        /* uneffect:effect Throw<RangeError> */ function validate(value: number) { if (value < 0) throw new RangeError("value") }
        class Client {
          stamp = initialize();
          /* uneffect:effect Random | Console | Throw<RangeError> */
          constructor(value = defaults()) { validate(value) }
        }
        class ImplicitClient {
          stamp = initialize();
          note = console.log("implicit field");
        }
        class Base {
          /* uneffect:effect Console */ constructor() { console.log("base") }
        }
        class Derived extends Base {
          stamp = initialize();
        }
        export function create(value: number) { return new Client(value) }
        export function createImplicit() { return new ImplicitClient() }
        export function createDerived() { return new Derived() }
        /* uneffect:effect Random | Console */
        export function caught() { try { return new Client() } catch { return undefined } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const create = graph.nodes.find((node) => node.name === "create")!;
      const constructor = graph.nodes.find((node) => node.kind === "constructor")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: create.id, callee: constructor.id, kind: "direct", timing: "inline", executesBody: true,
      }));
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "create", effect: "Random", kind: "missing" }),
        expect.objectContaining({ functionName: "create", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "createImplicit", effect: "Random", kind: "missing" }),
        expect.objectContaining({ functionName: "createImplicit", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "createDerived", effect: "Random", kind: "missing" }),
        expect.objectContaining({ functionName: "createDerived", effect: "Console", kind: "missing" }),
      ]));
      expect(result.summaries.find((summary) => summary.functionName === "createImplicit"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caught")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes local Symbol.toPrimitive and ordinary coercion hooks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-coercion-effects-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Scalar {
          calls = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.calls> */
          [Symbol.toPrimitive](hint: string) {
            this.calls++; console.log(hint); if (hint.length < 0) throw new RangeError("coerce"); return 1
          }
        }
        class Ordinary {
          /* uneffect:effect Console */ valueOf() { console.log("valueOf"); return 1 }
          /* uneffect:effect Random */ toString() { crypto.getRandomValues(new Uint8Array(1)); return "1" }
        }
        export function add(value: Scalar & number) { return value + 1 }
        export function text(renamed: Scalar) { return \`value=\${renamed}\` }
        export function ordinary(value: Ordinary & number) { return value * 2 }
        export function ordinaryText(value: Ordinary) { return \`value=\${value}\` }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof value.calls> */
        export function caught(value: Scalar & number) { try { return +value } catch { return 0 } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "add", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "add", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "add", effect: "Mutate<typeof value.calls>", kind: "missing" }),
        expect.objectContaining({ functionName: "text", effect: "Mutate<typeof renamed.calls>", kind: "missing" }),
        expect.objectContaining({ functionName: "ordinary", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "ordinary", effect: "Random", kind: "missing" }),
        expect.objectContaining({ functionName: "ordinaryText", effect: "Random", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caught")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes local getter and setter bodies through implicit accessor calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accessor-effects-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Box {
          reads = 0;
          stored = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.reads> */
          get value() { this.reads++; console.log("get"); if (this.reads < 0) throw new RangeError("get"); return this.stored }
          /* uneffect:effect Console | Mutate<typeof this.stored> */
          set value(next: number) { console.log("set"); this.stored = next }
        }
        export function read(box: Box) { return box.value }
        export function write(target: Box, next: number) { target.value = next }
        export function bump(box: Box) { box.value += 1 }
        /* uneffect:effect InvokeUserCode | Console | Mutate<typeof caught.reads> */
        export function caughtRead(caught: Box) { try { return caught.value } catch { return 0 } }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const read = graph.nodes.find((node) => node.name === "read")!;
      const getter = graph.nodes.find((node) => node.name === "value" && node.id.includes(entry)
        && graph.edges.some((edge) => edge.caller === node.id && edge.unresolvedName === "console.log"))!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: read.id, callee: getter.id, kind: "direct", timing: "inline", receiver: "box", executesBody: true,
      }));
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "read", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "read", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "read", effect: "Mutate<typeof box.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "write", effect: "Mutate<typeof target.stored>", kind: "missing" }),
        expect.objectContaining({ functionName: "bump", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "bump", effect: "Mutate<typeof box.reads>", kind: "missing" }),
        expect.objectContaining({ functionName: "bump", effect: "Mutate<typeof box.stored>", kind: "missing" }),
      ]));
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caughtRead")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes a custom iterable generator through implicit Symbol.iterator calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-custom-iterable-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        class Values {
          count = 0;
          /* uneffect:effect Console | Throw<RangeError> | Mutate<typeof this.count> */
          *[Symbol.iterator]() { this.count++; console.log("step"); yield this.count; throw new RangeError("step") }
        }
        export function consume(values: Values) {
          for (const value of values) void value
        }
        export function spread(values: Values) { return [...values] }
        export function destructure(values: Values) { const [first] = values; return first }
        export function from(values: Values) { return Array.from(values) }
        export function promiseAll(values: Values) { return Promise.all(values) }
        /* uneffect:effect Console | Mutate<typeof renamed.count> */
        export function caught(renamed: Values) {
          try { for (const item of renamed) void item } catch {}
        }
        class ManualValues {
          /* uneffect:effect Console */
          [Symbol.iterator]() {
            console.log("acquire")
            return { next() { console.log("opaque step"); return { done: true as const, value: undefined } } }
          }
        }
        export function consumeManual(values: ManualValues) {
          for (const value of values) void value
        }
        export function spreadManual(values: ManualValues) { return [...values] }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const consume = graph.nodes.find((node) => node.name === "consume")!;
      const iterator = graph.nodes.find((node) => node.name === "[Symbol.iterator]")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: consume.id, callee: iterator.id, kind: "direct", timing: "inline", executesBody: true,
      }));
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "consume", effect: "Console", kind: "missing" }),
        expect.objectContaining({ functionName: "consume", effect: "Throw<RangeError>", kind: "missing" }),
        expect.objectContaining({ functionName: "consume", effect: "Mutate<typeof values.count>", kind: "missing" }),
      ]));
      expect(result.summaries.find((summary) => summary.functionName === "consume"))
        .not.toMatchObject({ evidence: "unknown" });
      for (const functionName of ["spread", "destructure", "from"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, effect: "Console", kind: "missing",
        }));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, effect: "Throw<RangeError>", kind: "missing",
        }));
        expect(result.summaries.find((summary) => summary.functionName === functionName))
          .not.toMatchObject({ evidence: "unknown" });
      }
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "promiseAll", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "promiseAll", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics.filter((diagnostic) => diagnostic.functionName === "caught")).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeManual", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeManual"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-generator-consumption" })] });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "spreadManual", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "spreadManual"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-generator-consumption" })] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("includes calls from parameter and destructuring entry initializers", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-default-entry-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:effect Console */ export function report() { console.log("default") }
        /* uneffect:effect Console */ export function direct(value = report()) { return value }
        /* uneffect:effect Console */ export function nested({ value = report() }: { value?: void } = {}) { return value }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const graph = buildProgramCallGraph(program);
      for (const caller of ["direct", "nested"]) {
        const callerId = graph.nodes.find((node) => node.name === caller)?.id;
        const reportId = graph.nodes.find((node) => node.name === "report")?.id;
        expect(graph.edges).toContainEqual(expect.objectContaining({ caller: callerId, callee: reportId, kind: "direct" }));
      }
      expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("classifies callbacks from generic semantics without a legacy operation", () => {
    const fileName = "generic-callback.ts";
    const source = ts.createSourceFile(fileName, `
      function deferred(callback: () => void) { setTimeout(callback, 0) }
      function shadowed(setTimeout: (callback: () => void) => void, callback: () => void) { setTimeout(callback) }
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, onError, fresh) => name === fileName ? source : original(name, version, onError, fresh);
    host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
    host.readFile = (name) => name === fileName ? source.text : ts.sys.readFile(name);
    const program = ts.createProgram([fileName], options, host);
    const builtinRegistry = extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
      symbol: { module: "global", export: "setTimeout" }, evidence: "trusted",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: "timer", cardinality: "0..1",
      }] },
    }] });
    const graph = buildProgramCallGraph(program, { builtinRegistry });
    expect(graph.nodes.find((node) => node.name === "deferred")?.effectParameters)
      .toContainEqual(expect.objectContaining({ index: 0, timing: "deferred" }));
    expect(graph.nodes.find((node) => node.name === "shadowed")?.effectParameters)
      .toContainEqual(expect.objectContaining({ index: 1, timing: "unknown" }));
  });
  it("distinguishes an explicit empty effect bound from an inferred empty inventory", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-empty-effect-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect none */
        /* uneffect:effect none */ export function pure(value: number) { return value + 1 }
        export function merelyInferred(value: number) { return value + 1 }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: false });

      expect(result.diagnostics).toEqual([]);
      expect(result.summaries.find((item) => item.functionName === "pure")).toMatchObject({ effects: [], evidence: "verified" });
      expect(result.summaries.find((item) => item.functionName === "merelyInferred")).toMatchObject({ effects: [], evidence: "inferred" });
      expect(result.summaries.find((item) => item.functionName === "<module>")).toMatchObject({ effects: [], evidence: "verified" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects effects performed inside an explicit empty effect bound", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-empty-effect-violation-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `/* uneffect:effect none */ export function impure() { console.log("unexpected") }`);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: false });

      expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "impure", kind: "missing", effect: "Console" }));
      expect(result.summaries.find((item) => item.functionName === "impure")).toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports an invalid empty module bound and empty iterator-effect bound without throwing", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-invalid-empty-bounds-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect none | Console */
        /* uneffect:effect none */
        /* uneffect:effect_parameter iterator extends none | Console */
        export function consume(iterator: Iterator<number>) { iterator.next() }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: false });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "<module>", kind: "invalid", message: expect.stringContaining("only member") }),
        expect.objectContaining({ functionName: "consume", severity: "error", message: expect.stringContaining("only member") }),
      ]));
      expect(result.summaries.find((item) => item.functionName === "consume")).toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((item) => item.functionName === "<module>")).toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("summarizes direct and imported module-initialization effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-effects-"));
    try {
      const library = join(directory, "library.ts"), entry = join(directory, "entry.ts");
      writeFileSync(library, `
        /* uneffect:effect Console */
        export function report(value: string): void
        export function report(value: number): void
        export function report(value: string | number) { console.log(value) }
      `);
      writeFileSync(entry, `
        /* uneffect:module_effect Console */
        import { report } from "./library.js"
        report("entry")
      `);
      const program = ts.createProgram([library, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>" && item.fileName === entry);

      expect(module).toMatchObject({ evidence: "verified", span: { start: 0, end: expect.any(Number) } });
      expect(module?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind)).toEqual(["Console"]);
      expect(result.diagnostics.filter((item) => item.functionName === "<module>")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("checks module effect upper bounds instead of trusting their text", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-bound-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect Dom */
        console.log("entry")
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "<module>", kind: "missing", effect: "Console" }),
        expect.objectContaining({ functionName: "<module>", kind: "unused", effect: "Dom" }),
      ]));
      expect(result.summaries.find((item) => item.functionName === "<module>")).toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("includes top-level inline callback effects for known callback owners", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-callback-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect Console | Timer */
        function invoke(callback: () => void) { callback() }
        invoke(() => console.log("inline"))
        setTimeout(() => console.log("later"), 0)
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>");

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect).sort()).toEqual(["Console", "Timer"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves immutable local and imported callback identifiers during module initialization", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-callback-identifiers-"));
    try {
      const callbacks = join(directory, "callbacks.ts"), entry = join(directory, "entry.ts");
      writeFileSync(callbacks, `
        /* uneffect:effect Console */
        export function importedCallback() { console.log("imported") }
      `);
      writeFileSync(entry, `
        /* uneffect:module_effect Console | Timer */
        import { importedCallback } from "./callbacks.js"
        const localCallback = () => console.log("local")
        setTimeout(localCallback, 0)
        setTimeout(importedCallback, 0)
      `);
      const program = ts.createProgram([callbacks, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });
      const module = analyzeProgramEffects(program, { requireAnnotations: true }).summaries
        .find((item) => item.functionName === "<module>" && item.fileName === entry);

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect).sort()).toEqual(["Console", "Timer"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps reassigned callback identifiers unknown during module initialization", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-mutable-callback-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        let callback = () => console.log("first")
        callback = () => console.log("second")
        setTimeout(callback, 0)
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>")).toMatchObject({
        evidence: "unknown",
        unknownReasons: expect.arrayContaining([expect.objectContaining({ code: "unresolved-callback" })]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps imported live callback bindings unknown when the exporter reassigns them", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-live-callback-"));
    try {
      const callbacks = join(directory, "callbacks.ts"), entry = join(directory, "entry.ts");
      writeFileSync(callbacks, `
        export function callback() { console.log("first") }
        callback = () => console.log("second")
      `);
      writeFileSync(entry, `
        import { callback } from "./callbacks.js"
        setTimeout(callback, 0)
      `);
      const program = ts.createProgram([callbacks, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries
        .find((item) => item.functionName === "<module>" && item.fileName === entry)).toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps unresolved and dynamic module initialization unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unknown-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        declare const callback: () => void
        callback()
        if (process.env.PLUGIN) await import(process.env.PLUGIN)
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: false });

      expect(result.summaries.find((item) => item.functionName === "<module>" && item.fileName === entry)).toMatchObject({
        evidence: "unknown",
        unknownReasons: expect.arrayContaining([
          expect.objectContaining({ code: "unresolved-call" }),
          expect.objectContaining({ code: "unresolved-dynamic-import" }),
        ]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not verify an unresolved top-level call merely because no dynamic import is present", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unresolved-call-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `declare const callback: () => void\ncallback()`);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>")).toMatchObject({
        evidence: "unknown",
        unknownReasons: [expect.objectContaining({ code: "unresolved-call" })],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes reviewed synchronous collection callbacks at module initialization", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-inline-array-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `export const values = [1, 2].map((value) => { console.log(value); return value + 1 })`);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>")).toMatchObject({
        evidence: "inferred",
        effects: [expect.objectContaining({ kind: "capability", name: "Console" })],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes a conditionally imported local literal module as a may-effect", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-dynamic-local-"));
    try {
      const plugin = join(directory, "plugin.mts"), entry = join(directory, "entry.mts");
      writeFileSync(plugin, `console.log("plugin initialization")`);
      writeFileSync(entry, `
        /* uneffect:module_effect Console */
        declare const enabled: boolean
        if (enabled) await import("./plugin.mjs")
      `);
      const program = ts.createProgram([plugin, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>" && item.fileName === entry);

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect)).toEqual(["Console"]);
      expect(result.diagnostics.filter((item) => item.fileName === entry)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("marks reviewed external module initialization trusted and propagates it locally", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-trusted-external-"));
    try {
      const library = join(directory, "library.ts"), entry = join(directory, "entry.ts");
      writeFileSync(library, `import "node:path"; export const loaded = true`);
      writeFileSync(entry, `import { loaded } from "./library.js"; export { loaded }`);
      const program = ts.createProgram([library, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
      });
      const modules = analyzeProgramEffects(program).summaries.filter((item) => item.functionName === "<module>");

      expect(modules.find((item) => item.fileName === library)).toMatchObject({ evidence: "trusted", effects: [] });
      expect(modules.find((item) => item.fileName === entry)).toMatchObject({ evidence: "trusted", effects: [] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps unreviewed external module initialization unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unreviewed-external-"));
    try {
      const declaration = join(directory, "opaque.d.ts"), entry = join(directory, "entry.ts");
      writeFileSync(declaration, `declare module "opaque-package" { export const value: number }`);
      writeFileSync(entry, `import "opaque-package"; export const loaded = true`);
      const program = ts.createProgram([declaration, entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>"))
        .toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps computed and unresolved external dynamic imports unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-dynamic-unknown-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        declare const specifier: string
        void import(specifier)
        void import("missing-external-package")
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>"))
        .toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not issue proof-grade module evidence for an ill-typed source", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-ill-typed-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `export const count: number = "not-a-number"`);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>")).toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes static side-effect imports through cyclic module evaluation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-cycle-"));
    try {
      const a = join(directory, "a.ts"), b = join(directory, "b.ts");
      writeFileSync(a, `
        /* uneffect:module_effect Console */
        import "./b.js"
        console.log("a")
      `);
      writeFileSync(b, `
        /* uneffect:module_effect Console */
        import "./a.js"
      `);
      const program = ts.createProgram([a, b], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const modules = result.summaries.filter((item) => item.functionName === "<module>");

      expect(modules).toHaveLength(2);
      expect(modules).toEqual(expect.arrayContaining([
        expect.objectContaining({ fileName: a, evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] }),
        expect.objectContaining({ fileName: b, evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("includes executable namespace initialization but ignores ambient namespaces", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-namespace-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect Console */
        declare namespace Types { const label: string }
        export namespace Runtime {
          export const initialized = console.log("namespace")
        }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>");

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect)).toEqual(["Console"]);
      expect(result.diagnostics.filter((item) => item.functionName === "<module>")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("includes class heritage and computed member-name evaluation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-class-evaluation-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect Console | Timer */
        /* uneffect:effect Timer */
        function makeBase() { setTimeout(() => {}, 0); return class {} }
        /* uneffect:effect Console */
        function memberName() { console.log("key"); return "run" }
        export class Service extends makeBase() {
          [memberName()]() {}
        }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>");

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect).sort()).toEqual(["Console", "Timer"]);
      expect(result.diagnostics.filter((item) => item.functionName === "<module>")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("includes implicit invocation of a statically resolved decorator", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-decorator-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        /* uneffect:module_effect Console */
        /* uneffect:effect Console */
        function audited(..._args: any[]) { console.log("decorate") }
        @audited
        export class Service {}
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
        experimentalDecorators: true, noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      const module = result.summaries.find((item) => item.functionName === "<module>");

      expect(module).toMatchObject({ evidence: "verified" });
      expect(module?.effects.map(formatEffect)).toEqual(["Console"]);
      expect(result.diagnostics).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps dynamically produced decorators unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-decorator-factory-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        function decoratorFactory() {
          return (..._args: any[]) => console.log("decorate")
        }
        @decoratorFactory()
        export class Service {}
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
        experimentalDecorators: true, noEmit: true,
      });

      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "<module>"))
        .toMatchObject({ evidence: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves aliases, re-exports, methods, arrows, overloads, and callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-graph-"));
    const a = join(directory, "a.ts"), barrel = join(directory, "barrel.ts"), b = join(directory, "b.ts");
    writeFileSync(a, `
      export function overloaded(x: string): string
      export function overloaded(x: number): number
      export function overloaded(x: string | number) { return x }
      export class Service { run() {} }
      export const arrow = () => overloaded(1)
      export function inline(cb: () => void) { cb() }
      export function deferred(cb: () => void) { setTimeout(cb, 0) }
    `);
    writeFileSync(barrel, `export { overloaded, Service, arrow, inline, deferred } from "./a.js"`);
    writeFileSync(b, `import { overloaded as pick, Service, arrow, inline, deferred } from "./barrel.js"; function main() { pick("x"); new Service().run(); arrow(); inline(() => {}); deferred(() => {}) }`);
    const program = ts.createProgram([a, barrel, b], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    const graph = buildProgramCallGraph(program);
    expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["function", "method", "arrow"]));
    expect(graph.edges.filter((edge) => edge.callee).length).toBeGreaterThanOrEqual(5);
    expect(graph.edges).toContainEqual(expect.objectContaining({ overloadIndex: 0 }));
    expect(graph.nodes.find((node) => node.name === "inline")?.effectParameters).toContainEqual(expect.objectContaining({ timing: "inline" }));
    expect(graph.nodes.find((node) => node.name === "deferred")?.effectParameters).toContainEqual(expect.objectContaining({ timing: "deferred" }));
  });

  it("instantiates callback effects and preserves invocation timing", () => {
    const node = { id: "f", name: "later", kind: "function" as const, fileName: "f.ts", span: { start: 0, end: 1 }, overloads: [], effectParameters: [{ index: 0, name: "cb", timing: "deferred" as const }], iteratorEffectParameters: [] };
    const result = instantiateCallbackEffects(node, new Map([[0, [parseEffectExpression("Console")]]]));
    expect(result).toMatchObject({ evidence: "inferred", suspends: true });
    expect(result.effects).toHaveLength(1);
  });

  it("uses the reviewed synchronous TypeScript Program.emit callback contract", () => {
    const fileName = join(process.cwd(), "virtual-typescript-emit.ts");
    const sourceText = `
      import type ts from "typescript"
      export function capture(program: ts.Program) {
        program.emit(undefined, (_fileName, _text) => {}, undefined, true)
      }
    `;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
    };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, fresh) => name === fileName
      ? ts.createSourceFile(fileName, sourceText, language, true)
      : original(name, language, onError, fresh);
    const program = ts.createProgram([fileName], options, host);
    const graph = buildProgramCallGraph(program);
    const result = analyzeProgramEffects(program, { requireAnnotations: false });

    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "inline" }));
    expect(result.summaries.find((item) => item.functionName === "capture")).toMatchObject({ evidence: "inferred" });
  });

  it("composes reviewed synchronous TypeScript traversal callbacks by symbol identity", () => {
    const fileName = join(process.cwd(), "virtual-typescript-traversal.ts");
    const sourceText = `
      import ts from "typescript"
      export function traverse(node: ts.Node, context: ts.TransformationContext) {
        node.forEachChild((child) => console.log(child.kind))
        ts.forEachChild(node, (child) => console.log(child.kind))
        ts.visitNode(node, (child) => { console.log(child.kind); return child })
        ts.visitEachChild(node, (child) => { console.log(child.kind); return child }, context)
      }
      export function rewrite(node: ts.Node) {
        const result = ts.transform(node, [
          (context) => (root) => ts.visitEachChild(root, (child) => {
            console.log(child.kind)
            return child
          }, context),
        ])
        result.dispose()
      }
    `;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
    };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, fresh) => name === fileName
      ? ts.createSourceFile(fileName, sourceText, language, true)
      : original(name, language, onError, fresh);
    const program = ts.createProgram([fileName], options, host);
    const graph = buildProgramCallGraph(program);
    const result = analyzeProgramEffects(program, { requireAnnotations: false });

    expect(graph.edges.filter((edge) => edge.kind === "callback-argument" && edge.timing === "inline"))
      .toHaveLength(7);
    for (const name of ["traverse", "rewrite"]) {
      expect(result.summaries.find((item) => item.functionName === name)).toMatchObject({
        evidence: "inferred",
        effects: [expect.objectContaining({ kind: "capability", name: "Console" })],
      });
    }
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("derives timing from same-Program user methods without granting builtin identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-typescript-lookalike-"));
    const source = join(directory, "lookalike.ts");
    writeFileSync(source, `
      class FakeNode {
        forEachChild(callback: () => void) { queueMicrotask(callback) }
      }
      const fakeTs = {
        visitNode(_node: unknown, callback: () => void) { queueMicrotask(callback) },
        visitEachChild(_node: unknown, callback: () => void) { queueMicrotask(callback) },
        transform(_node: unknown, callbacks: Array<() => void>) { callbacks.forEach(queueMicrotask) },
      }
      export function inspect(node: FakeNode) {
        node.forEachChild(() => console.log("later"))
        fakeTs.visitNode(node, () => console.log("later"))
        fakeTs.visitEachChild(node, () => console.log("later"))
        fakeTs.transform(node, [() => console.log("later")])
      }
    `);
    const program = ts.createProgram([source], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
    });
    const graph = buildProgramCallGraph(program);
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    rmSync(directory, { recursive: true, force: true });

    expect(graph.edges.filter((edge) => edge.kind === "callback-argument" && edge.timing === "deferred").length)
      .toBeGreaterThanOrEqual(3);
    const inspect = result.summaries.find((item) => item.functionName === "inspect");
    expect(inspect).toMatchObject({ evidence: "inferred" });
    expect(inspect?.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "capability", name: "Timer" }),
      expect.objectContaining({ kind: "capability", name: "Console" }),
    ]));
  });

  it("composes a reviewed TypeScript transform callback array during module initialization", () => {
    const fileName = join(process.cwd(), "virtual-typescript-module-transform.ts");
    const sourceText = `
      import ts from "typescript"
      declare const source: ts.SourceFile
      ts.forEachChild(source, (child) => console.log(child.kind))
      ts.transform(source, [(context) => (root) => {
        console.log(root.kind)
        return ts.visitEachChild(root, (child) => child, context)
      }])
    `;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
    };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, fresh) => name === fileName
      ? ts.createSourceFile(fileName, sourceText, language, true)
      : original(name, language, onError, fresh);
    const program = ts.createProgram([fileName], options, host);
    const result = analyzeProgramEffects(program, { requireAnnotations: false });

    expect(result.summaries.find((item) => item.functionName === "<module>")).toMatchObject({
      evidence: "trusted",
      effects: [expect.objectContaining({ kind: "capability", name: "Console" })],
    });
  });

  it("propagates effects across files, re-exports, methods, overloads, arrows, and callback arguments", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-effects-"));
    const library = join(directory, "library.ts"), barrel = join(directory, "index.ts"), main = join(directory, "main.ts");
    writeFileSync(library, `
      /* uneffect:effect Console */
      export function pick(x: string): string
      export function pick(x: number): number
      export function pick(x: string | number) { console.log(x); return x }
      export class Service { /* uneffect:effect Console */ run() { console.log("run") } }
      /* uneffect:effect Console */ export const arrow = () => console.log("arrow")
      export function invoke(cb: () => void) { cb() }
    `);
    writeFileSync(barrel, `export { pick, Service, arrow, invoke } from "./library.js"`);
    writeFileSync(main, `
      import { pick as choose, Service, arrow, invoke } from "./index.js"
      /* uneffect:effect Console */
      function main() { choose("x"); new Service().run(); arrow(); invoke(() => console.log("callback")) }
    `);
    const program = ts.createProgram([library, barrel, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const result = analyzeProgramEffects(program);
    expect(result.diagnostics.filter((item) => item.functionName === "main")).toEqual([]);
    expect(result.summaries.find((item) => item.functionName === "main")?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind)).toContain("Console");
  });

  it("substitutes a method this-region with the stable call receiver", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-method-receiver-"));
    try {
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        export class State {
          values: number[] = []
          /* uneffect:effect Mutate<typeof this.values> */
          add(value: number) { this.values.push(value) }
        }
        /* uneffect:effect Mutate<typeof state.values> */
        export function update(state: State) { state.add(1) }
        /* uneffect:effect Mutate<typeof state.values> */
        export function updateAlias(state: State) { const alias = state; alias.add(1) }
        export class Wrapper {
          constructor(readonly state: State) {}
          /* uneffect:effect Mutate<typeof this.state.values> */
          update() { this.state.add(1) }
        }
        export class Holder { get state() { return new State() } }
        /* uneffect:effect none */
        export function getterReceiver(holder: Holder) { holder.state.add(1) }
        /* uneffect:effect none */
        export function mutableAlias(state: State) { let alias = state; alias.add(1) }
        /* uneffect:effect none */
        export function extracted(state: State) { const add = state.add; add(1) }
      `);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics.filter((item) => ["add", "update", "updateAlias", "Wrapper.update"].includes(item.functionName))).toEqual([]);
      expect(result.summaries.find((summary) => summary.functionName === "update")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "mutate", region: "state.values" }));
      for (const name of ["getterReceiver", "mutableAlias", "extracted"]) {
        expect(result.summaries.find((summary) => summary.functionName === name)).toMatchObject({
          evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unresolved-mutation-alias" })],
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discharges program-wide throws only across caught synchronous edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-throw-discharge-"));
    try {
      const library = join(directory, "library.ts"), main = join(directory, "main.ts");
      writeFileSync(library, `
        /* uneffect:effect Throw<RangeError> */
        export function dangerous() { throw new RangeError("bad") }
        /* uneffect:effect Throw<SyntaxError> */
        export async function rejects() { throw new SyntaxError("async") }
        export function invoke(callback: () => void) { callback() }
      `);
      writeFileSync(main, `
        import { dangerous, rejects, invoke } from "./library.js"
        export function caughtDirect() { try { dangerous() } catch {} }
        export function uncaughtDirect() { dangerous() }
        export function startsAsync() { rejects() }
        export function caughtInline() { try { invoke(() => { throw new TypeError("inline") }) } catch {} }
        export function deferredIsNotCaught() {
          try { setTimeout(() => { throw new URIError("later") }, 0) } catch {}
        }
      `);
      const program = ts.createProgram([library, main], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], types: ["node"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caughtDirect", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "uncaughtDirect", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "rejects", effect: "Throw<SyntaxError>", kind: "unused",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "startsAsync", effect: "Throw<SyntaxError>", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caughtInline", effect: "Throw<TypeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "deferredIsNotCaught", effect: "Throw<URIError>", kind: "missing",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("discharges imported implicit disposer throws inside a caught using scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-disposer-discharge-"));
    try {
      const library = join(directory, "library.ts"), main = join(directory, "main.ts");
      writeFileSync(library, `
        export class Resource {
          /* uneffect:effect Throw<RangeError> */
          [Symbol.dispose]() { throw new RangeError("dispose") }
        }
      `);
      writeFileSync(main, `
        import { Resource } from "./library.js"
        export function caught() { try { using resource = new Resource() } catch {} }
        export function uncaught() { using resource = new Resource() }
      `);
      const program = ts.createProgram([library, main], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.esnext.disposable.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caught", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "uncaught", effect: "Throw<RangeError>", kind: "missing",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("executes imported generator effects only when the iterator is consumed", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-generator-effects-"));
    try {
      const library = join(directory, "library.ts"), main = join(directory, "main.ts");
      writeFileSync(library, `
        /* uneffect:effect Console | Throw<RangeError> */
        export function* generate() { console.log("step"); throw new RangeError("step") }
        /* uneffect:effect Console */
        export function* logOnly() { console.log("log") }
        /* uneffect:effect Throw<TypeError> */
        export function* failOnly() { throw new TypeError("fail") }
        export function chooseIterator(log: boolean) {
          if (log) return logOnly()
          return failOnly()
        }
        declare function externalIterator(): Generator<string>
        export function choosePartial(log: boolean) {
          if (log) return logOnly()
          return externalIterator()
        }
        /* uneffect:effect Throw<URIError> */
        export function maybeThrowFactory(fail: boolean) {
          if (fail) throw new URIError("factory")
          return generate()
        }
        export function values() { return [1, 2, 3] }
      `);
      writeFileSync(main, `
        import { generate, chooseIterator, choosePartial, maybeThrowFactory, values } from "./library.js"
        export function constructOnly() { generate() }
        export function buildIterator() { return generate() }
        export function consumeNext() { const iterator = generate(); iterator.next() }
        export function consumeAlias() {
          const iterator = generate()
          const forwarded = iterator
          const forwardedAgain = forwarded
          forwardedAgain.next()
        }
        export function consumeLoop() { for (const value of generate()) void value }
        export function consumeArrayFrom() { Array.from(generate()) }
        export function consumeSpread() { void [...generate()] }
        export function consumeStoredArrayFrom() {
          const iterator = generate()
          Array.from(iterator)
        }
        export function consumeDestructure() { const [first] = generate(); void first }
        export function consumeSet() { void new Set(generate()) }
        export function consumeStoredMap() {
          function* entries() { console.log("entry"); yield ["key", "value"] as const }
          const iterator = entries()
          void new Map(iterator)
        }
        export function consumePromiseAll() { void Promise.all(generate()) }
        export function consumePromiseFactory(fail: boolean) { void Promise.all(maybeThrowFactory(fail)) }
        export function shadowedArrayFromDoesNotConsume() {
          const Array = { from(_value: unknown) {} }
          Array.from(generate())
        }
        export function consumeFactory() { for (const value of buildIterator()) void value }
        export function consumeBranchingFactory(log: boolean) {
          for (const value of chooseIterator(log)) void value
        }
        export function consumePartialFactory(log: boolean) {
          for (const value of choosePartial(log)) void value
        }
        export function consumeOpaqueStored() {
          const iterator = choosePartial(false)
          iterator.next()
        }
        export function consumeOpaqueAliasLoop() {
          const iterator = choosePartial(false)
          const forwarded = iterator
          for (const value of forwarded) void value
        }
        export function consumeOpaquePromiseAll(log: boolean) {
          void Promise.all(choosePartial(log))
        }
        export function consumeIteratorParameter(iterator: IteratorObject<unknown>) { iterator.next() }
        export function consumeIterableParameter(iterable: Iterable<unknown>) { return Array.from(iterable) }
        /* uneffect:effect none */
        /* uneffect:effect_parameter iterable extends Console | Throw<Error> */
        export function constrainedIterableParameter(iterable: Iterable<readonly [PropertyKey, unknown]>) { return Object.fromEntries(iterable) }
        /* uneffect:effect Console */
        export function boundedIteratorParameter(iterator: IteratorObject<unknown>) { iterator.next() }
        /* uneffect:effect_parameter iterator extends Console | Throw<Error> */
        export function constrainedIteratorParameter(iterator: IteratorObject<unknown>) { iterator.next() }
        export function consumeKnownConstrainedIteratorParameter() { constrainedIteratorParameter(generate()) }
        export function consumeStoredConstrainedIteratorParameter() { const iterator = generate(); constrainedIteratorParameter(iterator) }
        export function consumeOpaqueConstrainedIteratorParameter() { constrainedIteratorParameter(choosePartial(false)) }
        /* uneffect:effect_parameter iterator extends Console */
        export function narrowIteratorParameter(iterator: IteratorObject<unknown>) { iterator.next() }
        export function consumeKnownNarrowIteratorParameter() { narrowIteratorParameter(generate()) }
        export function consumeStoredNarrowIteratorParameter() { const iterator = generate(); narrowIteratorParameter(iterator) }
        export function forwardNarrowIteratorParameter(iterator: IteratorObject<unknown>) { narrowIteratorParameter(iterator) }
        export function consumeKnownForwardNarrowIteratorParameter() { forwardNarrowIteratorParameter(generate()) }
        /* uneffect:effect_parameter iterator extends Console | Throw<Error> */
        export function incompatibleForwardConstraint(iterator: IteratorObject<unknown>) { narrowIteratorParameter(iterator) }
        /* uneffect:effect_parameter iterator Console */
        export function malformedIteratorConstraint(iterator: IteratorObject<unknown>) { iterator.next() }
        /* uneffect:effect_parameter value extends Console */
        export function nonIteratorConstraint(value: number) { return value }
        export function consumeKnownIteratorParameter() { consumeIteratorParameter(generate()) }
        export function consumePureIteratorParameter() { consumeIteratorParameter([1, 2, 3].values()) }
        export function outerIteratorParameter(iterator: IteratorObject<unknown>) { consumeIteratorParameter(iterator) }
        export function consumeKnownOuterIteratorParameter() { outerIteratorParameter(generate()) }
        export function consumePromiseIteratorParameter(iterator: IteratorObject<unknown>) { void Promise.all(iterator) }
        /* uneffect:effect InvokeUserCode */ /* uneffect:effect_parameter iterator extends Console */
        export function constrainedPromiseIteratorParameter(iterator: IteratorObject<unknown>) { void Promise.all(iterator) }
        export function consumeKnownConstrainedPromiseIteratorParameter() { constrainedPromiseIteratorParameter(generate()) }
        export function outerPromiseIteratorParameter(iterator: IteratorObject<unknown>) { consumePromiseIteratorParameter(iterator) }
        export function consumeKnownPromiseIteratorParameter() { consumePromiseIteratorParameter(generate()) }
        export function consumeKnownOuterPromiseIteratorParameter() { outerPromiseIteratorParameter(generate()) }
        export function consumeIteratorProperty(holder: { iterator: IteratorObject<unknown> }) { holder.iterator.next() }
        export function consumeMixedIteratorParameter(iterator: IteratorObject<unknown>, holder: { iterator: IteratorObject<unknown> }) {
          iterator.next()
          holder.iterator.next()
        }
        export function consumeKnownMixedIteratorParameter(holder: { iterator: IteratorObject<unknown> }) {
          consumeMixedIteratorParameter(generate(), holder)
        }
        export function consumeStandardIterator() {
          const iterator = [1, 2, 3].values()
          const forwarded = iterator
          forwarded.next()
        }
        export function consumeReassignedGenerator() {
          let iterator: IteratorObject<unknown> = [1, 2, 3].values()
          iterator = generate()
          iterator.next()
        }
        export function consumeReassignedPure() {
          let iterator: IteratorObject<unknown> = generate()
          iterator = [1, 2, 3].values()
          iterator.next()
        }
        export function consumeBranchReassignment(useGenerator: boolean) {
          let iterator: IteratorObject<unknown> = [1, 2, 3].values()
          if (useGenerator) iterator = generate()
          iterator.next()
        }
        export function consumeOpaqueReassignment() {
          let iterator: IteratorObject<unknown> = [1, 2, 3].values()
          iterator = choosePartial(false)
          iterator.next()
        }
        export function consumeMutableAliasReassignment() {
          const iterator = generate()
          let forwarded: IteratorObject<unknown> = iterator
          forwarded = [1, 2, 3].values()
          forwarded.next()
        }
        export function consumeConditionalExpression(useGenerator: boolean) {
          const iterator = useGenerator ? generate() : [1, 2, 3].values()
          iterator.next()
        }
        export function consumeObjectSlot() {
          const holder = { iterator: generate() }
          holder.iterator.next()
        }
        export function consumeObjectAlias() {
          const holder = { iterator: generate() }
          const alias = holder
          alias.iterator.next()
        }
        export function consumeReassignedObjectSlot() {
          const holder: { iterator: IteratorObject<unknown> } = { iterator: [1, 2, 3].values() }
          holder.iterator = generate()
          holder.iterator.next()
        }
        export function consumePureObjectSlot() {
          const holder: { iterator: IteratorObject<unknown> } = { iterator: generate() }
          holder.iterator = [1, 2, 3].values()
          holder.iterator.next()
        }
        export function consumeConditionalObjectSlot(flag: boolean) {
          const holder: { iterator: IteratorObject<unknown> } = { iterator: [1, 2, 3].values() }
          if (flag) holder.iterator = generate()
          holder.iterator.next()
        }
        export function consumeBracketObjectSlot() {
          const holder = { iterator: generate() }
          holder["iterator"].next()
        }
        export function consumeDynamicObjectSlot(key: "iterator") {
          const holder = { iterator: generate() }
          holder[key].next()
        }
        export function consumeDynamicObjectWrite(key: "iterator") {
          const holder: { iterator: IteratorObject<unknown> } = { iterator: generate() }
          holder[key] = choosePartial(false)
          holder.iterator.next()
        }
        declare function escapeObject(value: object): void
        export function consumeEscapedObjectSlot() {
          const holder = { iterator: generate() }
          escapeObject(holder)
          holder.iterator.next()
        }
        export function outerPartialFactory(log: boolean) { consumePartialFactory(log) }
        export function consumeArrayFactory() { for (const value of values()) void value }
        /* uneffect:effect Console */
        export function caughtConsumption() { try { generate().next() } catch {} }
      `);
      const program = ts.createProgram([library, main], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const construct = graph.nodes.find((node) => node.name === "constructOnly")!;
      const consumeNext = graph.nodes.find((node) => node.name === "consumeNext")!;
      const consumeIteratorParameter = graph.nodes.find((node) => node.name === "consumeIteratorParameter")!;
      const consumeKnownIteratorParameter = graph.nodes.find((node) => node.name === "consumeKnownIteratorParameter")!;
      const generate = graph.nodes.find((node) => node.name === "generate")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({ caller: construct.id, executesBody: false }));
      expect(graph.edges).toContainEqual(expect.objectContaining({ caller: consumeNext.id, executesBody: true }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: consumeKnownIteratorParameter.id,
        callee: generate.id,
        iteratorEffectInstantiation: { consumer: consumeIteratorParameter.id, parameterIndex: 0 },
      }));
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      expect(result.diagnostics.filter((item) => item.functionName === "constructOnly")).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeNext", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeNext", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeAlias", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeAlias", effect: "Throw<RangeError>", kind: "missing",
      }));
      for (const functionName of ["consumeArrayFrom", "consumeSpread", "consumeStoredArrayFrom", "consumeDestructure", "consumeSet"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, effect: "Console", kind: "missing",
        }));
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, effect: "Throw<RangeError>", kind: "missing",
        }));
      }
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumePromiseAll", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumePromiseAll", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumePromiseFactory", effect: "Throw<URIError>", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumePromiseFactory", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeStoredMap", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeLoop", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeFactory", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeFactory", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeBranchingFactory", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeBranchingFactory", effect: "Throw<TypeError>", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumePartialFactory"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "outerPartialFactory"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumeOpaqueStored"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumeOpaqueAliasLoop"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumeOpaquePromiseAll"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumeIteratorParameter"))
        .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterator" })] });
      expect(result.summaries.find((summary) => summary.functionName === "consumeIterableParameter"))
        .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterable" })] });
      expect(result.summaries.find((summary) => summary.functionName === "constrainedIterableParameter"))
        .toMatchObject({ evidence: "verified", iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterable" })] });
      expect(result.summaries.find((summary) => summary.functionName === "boundedIteratorParameter"))
        .toMatchObject({
          evidence: "unknown",
          iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterator" })],
          unknownReasons: [expect.objectContaining({ code: "unbounded-iterator-effect-parameter" })],
        });
      expect(result.summaries.find((summary) => summary.functionName === "constrainedIteratorParameter"))
        .toMatchObject({ evidence: "verified", iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterator" })] });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeKnownConstrainedIteratorParameter",
        message: expect.stringContaining("outside its declared bound"),
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeStoredConstrainedIteratorParameter",
        message: expect.stringContaining("outside its declared bound"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeOpaqueConstrainedIteratorParameter"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownNarrowIteratorParameter", effect: "Throw<RangeError>", kind: "missing",
        message: expect.stringContaining("iterator effect parameter iterator"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeKnownNarrowIteratorParameter"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeStoredNarrowIteratorParameter", effect: "Throw<RangeError>",
        message: expect.stringContaining("outside its declared bound"),
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownForwardNarrowIteratorParameter", effect: "Throw<RangeError>", kind: "missing",
        message: expect.stringContaining("iterator effect parameter iterator"),
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "incompatibleForwardConstraint", effect: "Throw<Error>", kind: "missing",
        message: expect.stringContaining("not compatible with forwarded constraint"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "incompatibleForwardConstraint"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "malformedIteratorConstraint", kind: "unknown",
        message: expect.stringContaining("expected <parameter> extends <Effect union>"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "malformedIteratorConstraint"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "nonIteratorConstraint", kind: "unknown",
        message: expect.stringContaining("is not a consumed iterator parameter"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeKnownIteratorParameter"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownIteratorParameter", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownIteratorParameter", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumePureIteratorParameter"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumePromiseIteratorParameter"))
        .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0, convertsThrowToRejection: true })] });
      expect(result.summaries.find((summary) => summary.functionName === "constrainedPromiseIteratorParameter"))
        .toMatchObject({ evidence: "verified", iteratorEffectBounds: [expect.objectContaining({ index: 0, name: "iterator" })] });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeKnownConstrainedPromiseIteratorParameter",
        message: expect.stringContaining("outside its declared bound"),
      }));
      expect(result.summaries.find((summary) => summary.functionName === "outerPromiseIteratorParameter"))
        .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0, convertsThrowToRejection: true })] });
      expect(result.summaries.find((summary) => summary.functionName === "consumeKnownPromiseIteratorParameter"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownPromiseIteratorParameter", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeKnownPromiseIteratorParameter", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownOuterPromiseIteratorParameter", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeKnownOuterPromiseIteratorParameter", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeKnownMixedIteratorParameter"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "outerIteratorParameter"))
        .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0, name: "iterator" })] });
      expect(result.summaries.find((summary) => summary.functionName === "consumeKnownOuterIteratorParameter"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeKnownOuterIteratorParameter", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeIteratorProperty"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.summaries.find((summary) => summary.functionName === "consumeStandardIterator"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeReassignedGenerator", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeReassignedGenerator", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeReassignedPure", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeBranchReassignment", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeOpaqueReassignment"))
        .toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumeMutableAliasReassignment", effect: "Console", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "consumeConditionalExpression", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeConditionalExpression"))
        .not.toMatchObject({ evidence: "unknown" });
      for (const functionName of ["consumeObjectSlot", "consumeObjectAlias", "consumeReassignedObjectSlot", "consumeConditionalObjectSlot", "consumeBracketObjectSlot"]) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          functionName, effect: "Console", kind: "missing",
        }));
        expect(result.summaries.find((summary) => summary.functionName === functionName))
          .not.toMatchObject({ evidence: "unknown" });
      }
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "consumePureObjectSlot", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumePureObjectSlot"))
        .not.toMatchObject({ evidence: "unknown" });
      for (const functionName of ["consumeDynamicObjectSlot", "consumeDynamicObjectWrite", "consumeEscapedObjectSlot"]) {
        expect(result.summaries.find((summary) => summary.functionName === functionName))
          .toMatchObject({ evidence: "unknown" });
      }
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "shadowedArrayFromDoesNotConsume", effect: "Console", kind: "missing",
      }));
      expect(result.summaries.find((summary) => summary.functionName === "consumeArrayFactory"))
        .not.toMatchObject({ evidence: "unknown" });
      expect(result.diagnostics.filter((item) => item.functionName === "caughtConsumption")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("classifies Array.from mapping as synchronous inline invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-from-"));
    const source = join(directory, "array.ts");
    writeFileSync(source, `export function make(length: number) { return Array.from({ length }, (_, index) => index) }`);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("classifies Array.fromAsync mapping and iterator completion as Promise reactions", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-from-async-"));
    try {
      const source = join(directory, "array.ts");
      writeFileSync(source, `
        /* uneffect:effect Console | Throw<RangeError> */
        async function* generate() { console.log("step"); yield 1; throw new RangeError("step") }
        /* uneffect:effect Mutate<typeof owner.count> */
        function map(this: { count: number }, value: number, _index: number) { this.count++; return value }
        /* uneffect:effect Console | Mutate<typeof owner.count> */
        export function collect(owner: { count: number }) { return Array.fromAsync(generate(), map, owner) }
        export function shadowed(owner: { count: number }) {
          const Array = { fromAsync(_values: unknown, callback: (value: number) => number) { return callback(1) } }
          return Array.fromAsync(generate(), value => map.call(owner, value, 0))
        }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program);
      const collect = graph.nodes.find((node) => node.name === "collect")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: collect.id, kind: "callback-argument", timing: "deferred",
        arguments: ["", ""], unresolvedMutationArgumentIndices: [0, 1], receiver: "owner",
      }));
      const generate = graph.nodes.find((node) => node.name === "generate")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: collect.id, callee: generate.id, executesBody: true, dischargesThrow: true,
      }));
      const shadowed = graph.nodes.find((node) => node.name === "shadowed")!;
      expect(graph.edges).not.toContainEqual(expect.objectContaining({ caller: shadowed.id, timing: "deferred" }));
      const effects = analyzeProgramEffects(program);
      expect(effects.diagnostics.filter((diagnostic) => diagnostic.functionName === "collect")).toEqual([]);
      expect(effects.summaries.find((summary) => summary.functionName === "collect")).toMatchObject({
        evidence: "verified",
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "Console" }),
          expect.objectContaining({ kind: "mutate", region: "owner.count" }),
        ]),
      });
      expect(effects.summaries.find((summary) => summary.functionName === "collect")?.effects)
        .not.toContainEqual(expect.objectContaining({ kind: "throw", errorType: "RangeError" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats Promise.withResolvers settlement functions as authenticated protocol operations", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-with-resolvers-"));
    try {
      const source = join(directory, "promise.ts");
      writeFileSync(source, `
        /* uneffect:effect none */
        export function complete(value: number) {
          const { promise, resolve, reject } = Promise.withResolvers<number>()
          const done = resolve
          if (value >= 0) done(value)
          else reject(new RangeError("negative"))
          return promise
        }
        export function shadowed() {
          const Promise = { withResolvers() { return { promise: 1, resolve(value: number) { console.log(value) }, reject(_error: Error) {} } } }
          const { promise, resolve } = Promise.withResolvers()
          resolve(promise)
        }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const effects = analyzeProgramEffects(program);
      expect(effects.diagnostics.filter(({ functionName }) => functionName === "complete")).toEqual([]);
      expect(effects.summaries.find(({ functionName }) => functionName === "complete")).toMatchObject({ evidence: "verified", effects: [] });
      expect(effects.summaries.find(({ functionName }) => functionName === "shadowed")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "Console" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("separates Promise.try synchronous invocation from rejection completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-promise-try-"));
    try {
      const source = join(directory, "promise.ts");
      writeFileSync(source, `
        /* uneffect:effect Console | Throw<RangeError> */
        function work(value: number) { console.log(value); if (value < 0) throw new RangeError("negative"); return value }
        /* uneffect:effect Console */
        export function run(value: number) { return Promise.try(work, value) }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      expect(program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      const graph = buildProgramCallGraph(program), run = graph.nodes.find(({ name }) => name === "run")!, work = graph.nodes.find(({ name }) => name === "work")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        caller: run.id, callee: work.id, kind: "callback-argument", timing: "inline",
        arguments: ["value"], dischargesThrow: true,
      }));
      const effects = analyzeProgramEffects(program);
      expect(effects.diagnostics.filter(({ functionName }) => functionName === "run")).toEqual([]);
      expect(effects.summaries.find(({ functionName }) => functionName === "run")?.effects).toEqual([
        expect.objectContaining({ kind: "capability", name: "Console" }),
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("classifies aliased node:fs completion callbacks as deferred by builtin identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-fs-callback-"));
    const source = join(directory, "fs.ts");
    writeFileSync(source, `
      import { readFile as loadFile, watch } from "node:fs"
      /* uneffect:effect FsRead | Console */
      export function load() { loadFile("settings.json", () => console.log("loaded")) }
      /* uneffect:effect FsRead | Console */
      export function watchConfig() { watch("settings.json", () => console.log("changed")) }
      function watchLocal(_path: string, callback: () => void) { callback() }
      export function local() { watchLocal("settings.json", () => console.log("local")) }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true });
    const graph = buildProgramCallGraph(program);
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "deferred" }));
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.diagnostics.filter((item) => item.functionName === "load")).toEqual([]);
    expect(result.diagnostics.filter((item) => item.functionName === "watchConfig")).toEqual([]);
    expect(result.summaries.find((item) => item.functionName === "load")).toMatchObject({ evidence: "verified" });
    rmSync(directory, { recursive: true, force: true });
  });

  it("classifies Effect.catchAll handlers as deferred by package symbol identity", () => {
    const directory = mkdtempSync(join(process.cwd(), ".tmp-uneffect-effect-callback-"));
    const source = join(directory, "effect.ts");
    writeFileSync(source, `
      import { Effect } from "effect"
      export function recovered() { return Effect.catchAll(() => Effect.succeed("ok")) }
      const LocalEffect = { catchAll: (callback: () => unknown) => callback }
      export function unknown() { return LocalEffect.catchAll(() => "ok") }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const graph = buildProgramCallGraph(program);
    rmSync(directory, { recursive: true, force: true });
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "deferred" }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "unknown" }));
  });

  it("does not degrade an inline callback when recursive calls forward it", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-recursive-callback-"));
    const source = join(directory, "recursive.ts");
    writeFileSync(source, `
      export function visit(value: number, map: (value: number) => number): number {
        return value > 0 ? map(value) : visit(1, map)
      }
      export function run() { return visit(0, (value) => value + 1) }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("classifies JSON.stringify replacers as synchronous inline callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-json-replacer-"));
    const source = join(directory, "json.ts");
    writeFileSync(source, `export function encode(value: unknown) { return JSON.stringify(value, (_key, item) => item) }`);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("composes JSON.parse reviver effects as synchronous repeated callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-json-reviver-"));
    try {
      const source = join(directory, "json.ts");
      writeFileSync(source, `
        /* uneffect:effect Console */
        function revive(key: string, value: unknown) { console.log(key); return value }
        /* uneffect:effect Console | Throw<SyntaxError> */
        export function decode(text: string) { return JSON.parse(text, revive) }
        /* uneffect:effect Console */
        export function caught(text: string) { try { return JSON.parse(text, revive) } catch { return undefined } }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      });
      const graph = buildProgramCallGraph(program);
      expect(graph.edges).toContainEqual(expect.objectContaining({
        kind: "callback-argument",
        timing: "inline",
      }));
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics.filter(({ functionName }) => functionName === "decode")).toEqual([]);
      expect(result.summaries.find(({ functionName }) => functionName === "decode")?.effects.map(formatEffect))
        .toEqual(expect.arrayContaining(["Console", "Throw<SyntaxError>"]));
      expect(result.diagnostics.filter(({ functionName }) => functionName === "caught")).toEqual([]);
      expect(result.summaries.find(({ functionName }) => functionName === "caught")?.effects.map(formatEffect))
        .toEqual(["Console"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps common primitive String and Number transforms authority-free", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-primitive-transforms-"));
    try {
      const source = join(directory, "transforms.ts");
      writeFileSync(source, `
        export function normalize(value: string) {
          return value.trim().toLowerCase().replaceAll("_", "-")
        }
        export function inspect(value: string, needle: string) {
          return value.includes(needle) || value.startsWith(needle) || value.endsWith(needle)
        }
        export function finite(value: number) {
          return Number.isFinite(value) && Number.isInteger(value) && !Number.isNaN(value)
        }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts"],
      });
      expect(program.getSemanticDiagnostics()).toEqual([]);
      const result = analyzeProgramEffects(program, { requireAnnotations: false });
      expect(result.summaries.filter(({ functionName }) => ["normalize", "inspect", "finite"].includes(functionName)))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ functionName: "normalize", effects: [], evidence: "inferred" }),
          expect.objectContaining({ functionName: "inspect", effects: [], evidence: "inferred" }),
          expect.objectContaining({ functionName: "finite", effects: [], evidence: "inferred" }),
        ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not project mutation through fresh non-destructive Array results", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-fresh-array-results-"));
    try {
      const source = join(directory, "arrays.ts");
      writeFileSync(source, `
        /* uneffect:effect none */
        export function mapped(values: number[]) { return values.map(value => value + 1).sort() }
        /* uneffect:effect none */
        export function filtered(values: number[]) { return values.filter(Boolean).reverse() }
        /* uneffect:effect none */
        export function flattened(values: number[][]) { return values.flatMap(value => value).splice(0, 1) }
        /* uneffect:effect none */
        export function copied(values: number[]) { return values.slice().fill(0) }
        /* uneffect:effect none */
        export function reversed(values: number[]) { return values.toReversed().sort() }
        /* uneffect:effect none */
        export function spliced(values: number[]) { return values.toSpliced(0, 1).reverse() }
        /* uneffect:effect none */
        export function replaced(values: number[]) { return values.with(0, 1).fill(0) }
        /* uneffect:effect none */
        export function copiedFrom(values: number[]) { return Array.from(values).sort() }
        /* uneffect:effect none */
        export function created(...values: number[]) { return Array.of(...values).reverse() }
        /* uneffect:effect none */
        export function indexed(entries: readonly (readonly [PropertyKey, number])[]) {
          return Object.assign(Object.fromEntries(entries), { extra: 1 })
        }
        /* uneffect:effect none */
        export function mappedEntries(entries: readonly (readonly [string, number])[]) {
          return new Map(entries).set("extra", 1)
        }
        /* uneffect:effect none */
        export function collected(values: readonly number[]) { return new Set(values).add(1) }
        /* uneffect:effect none */
        export function allocated(length: number) { return new Array<number>(length).fill(0) }
        /* uneffect:effect Console */
        function* loggedEntries() {
          console.log("entry")
          yield ["value", 1] as const
        }
        /* uneffect:effect Console */
        export function indexedFromGenerator() {
          return Object.assign(Object.fromEntries(loggedEntries()), { extra: 1 })
        }
        /* uneffect:effect Console */
        export function mapFromGenerator() {
          return new Map(loggedEntries()).set("value", 1)
        }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      });
      expect(program.getSemanticDiagnostics()).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual([]);
      expect(result.summaries.filter(({ functionName }) =>
        ["mapped", "filtered", "flattened", "copied", "reversed", "spliced", "replaced", "copiedFrom", "created", "indexed", "mappedEntries", "collected", "allocated"].includes(functionName)))
        .toEqual(expect.arrayContaining(["mapped", "filtered", "flattened", "copied", "reversed", "spliced", "replaced", "copiedFrom", "created", "indexed", "mappedEntries", "collected", "allocated"]
          .map((functionName) => expect.objectContaining({ functionName, effects: [], evidence: "verified" }))));
      const generated = result.summaries.find(({ functionName }) => functionName === "indexedFromGenerator");
      expect(generated).toEqual(expect.objectContaining({ functionName: "indexedFromGenerator", evidence: "verified" }));
      expect(generated?.effects.map(formatEffect)).toEqual(["Console"]);
      const generatedMap = result.summaries.find(({ functionName }) => functionName === "mapFromGenerator");
      expect(generatedMap).toEqual(expect.objectContaining({ functionName: "mapFromGenerator", evidence: "verified" }));
      expect(generatedMap?.effects.map(formatEffect)).toEqual(["Console"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps concat fresh while composing explicit spreadability and indexed getters", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-concat-hooks-"));
    try {
      const source = join(directory, "concat.ts");
      writeFileSync(source, `
        /* uneffect:effect none */
        export function arrays(left: number[], right: number[]) { return left.concat(right).sort() }
        /* uneffect:effect InvokeUserCode | Console */
        export function hooked() {
          const spreadable = {
            /* uneffect:effect Console */
            get [Symbol.isConcatSpreadable]() { console.log("spread"); return true },
            /* uneffect:effect Console */
            get 0() { console.log("index"); return 1 },
            length: 1,
            join(separator?: string) { return separator ?? "" },
            slice() { return [] as number[] },
          }
          return ([] as number[]).concat(spreadable).sort()
        }
        /* uneffect:effect InvokeUserCode */
        export function proxied(values: number[]) { return values.concat(new Proxy([1], {})).sort() }
      `);
      const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      });
      expect(program.getSemanticDiagnostics()).toEqual([]);
      const result = analyzeProgramEffects(program);
      expect(result.diagnostics).toEqual([]);
      expect(result.summaries.find(({ functionName }) => functionName === "arrays")?.effects).toEqual([]);
      expect(result.summaries.find(({ functionName }) => functionName === "hooked")?.effects.map(formatEffect))
        .toEqual(expect.arrayContaining(["InvokeUserCode", "Console"]));
      expect(result.summaries.find(({ functionName }) => functionName === "proxied")?.effects.map(formatEffect))
        .toEqual(["InvokeUserCode"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
