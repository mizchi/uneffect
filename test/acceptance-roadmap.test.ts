import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as uneffect from "../src/index.js";

type FutureApi = (...args: unknown[]) => unknown;

function futureApi(name: string): FutureApi {
  const candidate = (uneffect as unknown as Record<string, unknown>)[name];
  expect(candidate, `public API ${name} is not implemented`).toBeTypeOf("function");
  return candidate as FutureApi;
}

const files = (entries: Record<string, string>) => entries;

describe("Uneffect end-to-end acceptance roadmap", () => {
  it("refines state updates through non-escaping immutable runtime aliases", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state sent: int
       * init sent = 0
       * action record: sent' = sent + 1
       */
      interface Runtime { sent: number }
      /* uneffect: refinement telemetry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement telemetry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement telemetry@1 action record */
      export function record(runtime: Runtime) {
        const state = runtime
        const current = state
        current.sent++
      }
    `;
    const specification = parseSpecification("receiver-alias.ts", source) as { temporal: unknown };
    expect(validateActions("receiver-alias.ts", source, "telemetry", specification.temporal)).toEqual([]);
  });

  it("specializes a known runtime method through an immutable receiver alias", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state sent: int
       * state attempted: int
       * init sent = 0
       * init attempted = 0
       * action record: sent' = sent + 1, attempted' = attempted + 1
       */
      class Runtime {
        sent = 0
        attempted = 0
        record() { this.attempted++; this.sent++ }
      }
      /* uneffect: refinement telemetry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement telemetry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement telemetry@1 action record */
      export function record(runtime: Runtime) {
        const state = runtime
        state.record()
      }
    `;
    const specification = parseSpecification("receiver-method-alias.ts", source) as { temporal: unknown };
    expect(validateActions("receiver-method-alias.ts", source, "telemetry", specification.temporal)).toEqual([]);
  });

  it("specializes an imported runtime class method only with Program symbol evidence", () => {
    const validateActions = futureApi("validateRefinementActionBodiesInProgram");
    const parseSpecification = futureApi("parseSpec");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accept-imported-runtime-"));
    const runtimeFile = join(directory, "runtime.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import type { Runtime } from "./runtime.js"
      /* uneffect:
       * state sent: int
       * init sent = 0
       * action record: sent' = sent + 1
       */
      /* uneffect: refinement telemetry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement telemetry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement telemetry@1 action record */
      export function record(runtime: Runtime) { const state = runtime; state.record() }
    `;
    try {
      writeFileSync(runtimeFile, `/* uneffect: trust dispatch-sealing application owns the complete class graph */\nexport class Runtime { sent = 0; record() { this.sent++ } }`);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const specification = parseSpecification(mainFile, source) as { temporal: unknown };
      expect(validateActions(program, mainFile, "telemetry", specification.temporal)).toEqual([]);
      writeFileSync(runtimeFile, `
        export class Runtime { sent = 0; record() { this.sent++ } }
        export class DerivedRuntime extends Runtime { record() { this.sent += 2 } }
      `);
      const subclassProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateActions(subclassProgram, mainFile, "telemetry", specification.temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes an imported collection-producing invariant helper with builtin identity evidence", () => {
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgram");
    const parseSpecification = futureApi("parseSpec");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accept-collection-helper-"));
    const helperFile = join(directory, "collections.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import { activeEpochs, activeOwners } from "./collections.js"
      /* uneffect:
       * state owners: Set<int>
       * state epochs: Map<int, int>
       * init owners = Set(1)
       * init epochs = Map([[1, 0]])
       * temporal primaryPresent: owners.contains(1)
       * temporal primaryCurrent: epochs.keys().contains(1) && epochs.get(1) === 0
       * abstraction routing@1 owners = Set(routing.activeOwnerIds)
       * abstraction routing@1 epochs = Map(routing.epochEntries)
       */
      interface Runtime { routing: { activeOwnerIds: number[]; epochEntries: Array<[number, number]> } }
      /* uneffect: refinement routing@1 create */ export function create(initial: { owners: Set<number>; epochs: Map<number, number> }): Runtime { return { routing: { activeOwnerIds: Array.from(initial.owners), epochEntries: Array.from(initial.epochs) } } }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return { owners: new Set(runtime.routing.activeOwnerIds), epochs: new Map(runtime.routing.epochEntries) } }
      /* uneffect: refinement routing@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime) { return activeOwners(runtime).has(1) }
      /* uneffect: refinement routing@1 invariant primaryCurrent */
      export function primaryCurrent(runtime: Runtime) { return activeEpochs(runtime).has(1) && activeEpochs(runtime).get(1) === 0 }
    `;
    try {
      writeFileSync(helperFile, `
        export interface Runtime { routing: { activeOwnerIds: number[]; epochEntries: Array<[number, number]> } }
        export function activeOwners(runtime: Runtime): Set<number> {
          return new Set(runtime.routing.activeOwnerIds)
        }
        export function activeEpochs(runtime: Runtime): Map<number, number> {
          return new Map(runtime.routing.epochEntries)
        }
      `);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const temporal = (parseSpecification(mainFile, source) as { temporal: unknown }).temporal;
      expect(validateInvariants(program, mainFile, "routing", temporal)).toEqual([]);

      writeFileSync(helperFile, `
        export interface Runtime { routing: { activeOwnerIds: number[]; epochEntries: Array<[number, number]> } }
        class Set<T> { constructor(_values: Iterable<T>) {} has(_value: T) { return true } }
        class Map<K, V> { constructor(_values: Iterable<[K, V]>) {} has(_key: K) { return true } get(_key: K): V | undefined { return undefined } }
        export function activeOwners(runtime: Runtime): Set<number> {
          return new Set(runtime.routing.activeOwnerIds)
        }
        export function activeEpochs(runtime: Runtime): Map<number, number> {
          return new Map(runtime.routing.epochEntries)
        }
      `);
      const lookalikeProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(lookalikeProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "primaryPresent" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves imported collection predicate values without trusting mutable callback aliases", () => {
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgram");
    const parseSpecification = futureApi("parseSpec");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accept-predicate-value-"));
    const predicateFile = join(directory, "predicates.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import { isPositive, isPrimary } from "./predicates.js"
      const selectedPrimary = isPrimary
      /* uneffect:
       * state owners: Set<int>
       * init owners = Set(1)
       * temporal allPositive: owners.forall(owner => owner > 0)
       * temporal primaryPresent: owners.contains(1)
       * abstraction routing@1 owners = Set(routing.activeOwnerIds)
       */
      interface Runtime { routing: { activeOwnerIds: number[] } }
      /* uneffect: refinement routing@1 create */ export function create(initial: { owners: Set<number> }): Runtime { return { routing: { activeOwnerIds: Array.from(initial.owners) } } }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return { owners: new Set(runtime.routing.activeOwnerIds) } }
      /* uneffect: refinement routing@1 invariant allPositive */
      export function allPositive(runtime: Runtime) { return runtime.routing.activeOwnerIds.every(isPositive) }
      /* uneffect: refinement routing@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime) { return runtime.routing.activeOwnerIds.some(selectedPrimary) }
    `;
    try {
      writeFileSync(predicateFile, `
        export function isPositive(owner: number) { return owner > 0 }
        export function isPrimary(owner: number) { return owner === 1 }
      `);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, predicateFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const temporal = (parseSpecification(mainFile, source) as { temporal: unknown }).temporal;
      expect(validateInvariants(program, mainFile, "routing", temporal)).toEqual([]);

      writeFileSync(predicateFile, `
        export function isPositive(owner: number) { return owner >= 0 }
        export function isPrimary(owner: number) { return owner === 1 }
      `);
      const wrongProgram = ts.createProgram([mainFile, predicateFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(wrongProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "allPositive" }),
      );
      writeFileSync(predicateFile, `
        export function isPositive(owner: number) { return owner > 0 }
        export function isPrimary(owner: number) { return owner === 1 }
      `);

      const mutable = source
        .replace("interface Runtime", "let selectedPredicate = isPositive\n      interface Runtime")
        .replace("every(isPositive)", "every(selectedPredicate)");
      writeFileSync(mainFile, mutable);
      const mutableProgram = ts.createProgram([mainFile, predicateFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(mutableProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allPositive" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves exported immutable arrow and function-expression predicates", () => {
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgram");
    const parseSpecification = futureApi("parseSpec");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accept-expression-predicate-"));
    const predicateFile = join(directory, "predicates.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import { isPositive, isPrimary } from "./predicates.js"
      const positive = isPositive
      const primary = isPrimary
      /* uneffect:
       * state owners: Set<int>
       * init owners = Set(1)
       * temporal allPositive: owners.forall(owner => owner > 0)
       * temporal primaryPresent: owners.contains(1)
       * abstraction routing@1 owners = Set(activeOwnerIds)
       */
      interface Runtime { activeOwnerIds: number[] }
      /* uneffect: refinement routing@1 create */ export function create(initial: { owners: Set<number> }): Runtime { return { activeOwnerIds: Array.from(initial.owners) } }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return { owners: new Set(runtime.activeOwnerIds) } }
      /* uneffect: refinement routing@1 invariant allPositive */
      export function allPositive(runtime: Runtime) { return runtime.activeOwnerIds.every(positive) }
      /* uneffect: refinement routing@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime) { return runtime.activeOwnerIds.some(primary) }
    `;
    try {
      writeFileSync(predicateFile, `
        export const isPositive = (owner: number) => owner > 0
        export const isPrimary = function (owner: number) { return owner === 1 }
      `);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, predicateFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const temporal = (parseSpecification(mainFile, source) as { temporal: unknown }).temporal;
      expect(validateInvariants(program, mainFile, "routing", temporal)).toEqual([]);

      writeFileSync(predicateFile, `
        export let isPositive = (owner: number) => owner > 0
        export const isPrimary = function (owner: number) { return owner === 1 }
      `);
      const mutableExportProgram = ts.createProgram([mainFile, predicateFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(mutableExportProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allPositive" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves function-valued properties only from a builtin-frozen predicate registry", () => {
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgram");
    const parseSpecification = futureApi("parseSpec");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-accept-frozen-predicates-"));
    const registryFile = join(directory, "registry.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import { predicates } from "./registry.js"
      /* uneffect:
       * state owners: Set<int>
       * init owners = Set(1)
       * temporal allPositive: owners.forall(owner => owner > 0)
       * temporal primaryPresent: owners.contains(1)
       * abstraction routing@1 owners = Set(activeOwnerIds)
       */
      interface Runtime { activeOwnerIds: number[] }
      /* uneffect: refinement routing@1 create */ export function create(initial: { owners: Set<number> }): Runtime { return { activeOwnerIds: Array.from(initial.owners) } }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return { owners: new Set(runtime.activeOwnerIds) } }
      /* uneffect: refinement routing@1 invariant allPositive */
      export function allPositive(runtime: Runtime) { return runtime.activeOwnerIds.every(predicates.positive) }
      /* uneffect: refinement routing@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime) { return runtime.activeOwnerIds.some(predicates.primary) }
    `;
    const frozenRegistry = `
      export const predicates = Object.freeze({
        positive: (owner: number) => owner > 0,
        primary: function (owner: number) { return owner === 1 },
      })
    `;
    try {
      writeFileSync(registryFile, frozenRegistry);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, registryFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const temporal = (parseSpecification(mainFile, source) as { temporal: unknown }).temporal;
      expect(validateInvariants(program, mainFile, "routing", temporal)).toEqual([]);

      writeFileSync(registryFile, frozenRegistry.replace("Object.freeze({", "({"));
      const unfrozenProgram = ts.createProgram([mainFile, registryFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(unfrozenProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allPositive" }),
      );

      writeFileSync(registryFile, `
        const Object = { freeze<T>(value: T): T { return value } }
        ${frozenRegistry}
      `);
      const lookalikeProgram = ts.createProgram([mainFile, registryFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateInvariants(lookalikeProgram, mainFile, "routing", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allPositive" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes a labeled block exit with mandatory cleanup and outer continuation", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state delivered: int
       * state finalized: int
       * state audited: int
       * state skip: bool
       * init delivered = 0
       * init finalized = 0
       * init audited = 0
       * init skip = false
       * action deliver: delivered' = skip ? delivered : delivered + 1, finalized' = finalized + 1, audited' = audited + 1
       */
      interface Runtime { delivered: number; finalized: number; audited: number; skip: boolean }
      /* uneffect: refinement telemetry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement telemetry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement telemetry@1 action deliver */
      export function deliver(runtime: Runtime) {
        attempt: {
          try {
            if (runtime.skip) break attempt
            runtime.delivered++
          } finally {
            runtime.finalized++
          }
        }
        runtime.audited++
      }
    `;
    const specification = parseSpecification("labeled-delivery.ts", source) as { temporal: unknown };
    expect(validateActions("labeled-delivery.ts", source, "telemetry", specification.temporal)).toEqual([]);
  });

  it("preserves outer labeled loop transfers through an inner loop and finally", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const continueSource = `
      /* uneffect:
       * state visited: int
       * state cleaned: int
       * state audited: int
       * state stop: int
       * init visited = 0
       * init cleaned = 0
       * init audited = 0
       * init stop = 0
       * action scan: visited' = stop === 1 || stop === 2 || stop === 3 ? visited + 5 : visited + 6, cleaned' = cleaned + 3, audited' = stop === 1 || stop === 2 || stop === 3 ? audited + 2 : audited + 3
       */
      interface Runtime { visited: number; cleaned: number; audited: number; stop: number }
      /* uneffect: refinement scan@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement scan@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement scan@1 action scan */
      export function scan(runtime: Runtime) {
        outer: for (let batch = 0; batch < 3; batch++) {
          try {
            for (let item = 0; item < 2; item++) {
              runtime.visited++
              if (runtime.stop === batch + 1) continue outer
            }
          } finally {
            runtime.cleaned++
          }
          runtime.audited++
        }
      }
    `;
    const continueTemporal = (parseSpecification("outer-continue.ts", continueSource) as { temporal: unknown }).temporal;
    await expect(validateActions("outer-continue.ts", continueSource, "scan", continueTemporal)).resolves.toEqual([]);

    const breakSource = continueSource
      .replace(
        "visited' = stop === 1 || stop === 2 || stop === 3 ? visited + 5 : visited + 6, cleaned' = cleaned + 3, audited' = stop === 1 || stop === 2 || stop === 3 ? audited + 2 : audited + 3",
        "visited' = stop === 1 ? visited + 1 : stop === 2 ? visited + 3 : stop === 3 ? visited + 5 : visited + 6, cleaned' = stop === 1 ? cleaned + 1 : stop === 2 ? cleaned + 2 : cleaned + 3, audited' = stop === 1 ? audited : stop === 2 ? audited + 1 : stop === 3 ? audited + 2 : audited + 3",
      )
      .replace("continue outer", "break outer");
    const breakTemporal = (parseSpecification("outer-break.ts", breakSource) as { temporal: unknown }).temporal;
    await expect(validateActions("outer-break.ts", breakSource, "scan", breakTemporal)).resolves.toEqual([]);

    const unknownTarget = continueSource.replace("continue outer", "continue missing");
    await expect(validateActions("unknown-loop-label.ts", unknownTarget, "scan", continueTemporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "scan" }),
    );

    const overBudget = continueSource
      .replace("batch < 3", "batch < 17")
      .replace("item < 2", "item < 16");
    await expect(validateActions("over-budget-nested-loop.ts", overBudget, "scan", continueTemporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "scan" }),
    );
  });

  it("summarizes a state-dependent affine countdown loop without finite expansion", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * state audited: int
       * init pending = 0
       * init processed = 0
       * init audited = 0
       * action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? pending : 0), audited' = audited + 1
       */
      interface Runtime { pending: number; processed: number; audited: number }
      /* uneffect: refinement drain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement drain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement drain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          runtime.processed++
        }
        runtime.audited++
      }
    `;
    const temporal = (parseSpecification("affine-countdown.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("affine-countdown.ts", source, "drain", temporal)).resolves.toEqual([]);

    const wrongCoupling = source.replace("processed++", "processed += 2");
    await expect(validateActions("affine-countdown-wrong.ts", wrongCoupling, "drain", temporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "drain", target: "processed" }),
    );

    const unsupportedExit = source.replace("runtime.processed++", "if (runtime.processed > 10) break\n          runtime.processed++");
    await expect(validateActions("affine-countdown-break.ts", unsupportedExit, "drain", temporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
    );
  });

  it("summarizes a triangular loop-carried recurrence without finite expansion", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * init pending = 0
       * init weighted = 0
       * action drainWeighted: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? pending * (pending - 1) / 2 : 0)
       */
      interface Runtime { pending: number; weighted: number }
      /* uneffect: refinement triangularDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement triangularDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement triangularDrain@1 action drainWeighted */
      export function drainWeighted(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("triangular-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("triangular-drain.ts", source, "triangularDrain", temporal)).resolves.toEqual([]);

    const changedOrder = source.replace(
      "runtime.pending--\n          runtime.weighted += runtime.pending",
      "runtime.weighted += runtime.pending\n          runtime.pending--",
    );
    await expect(validateActions("triangular-drain-order.ts", changedOrder, "triangularDrain", temporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "drainWeighted", target: "weighted" }),
    );

    const nonlinear = source.replace("runtime.weighted += runtime.pending", "runtime.weighted += runtime.weighted");
    await expect(validateActions("triangular-drain-nonlinear.ts", nonlinear, "triangularDrain", temporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "drainWeighted" }),
    );
  });

  it("summarizes a loop-invariant conditional affine recurrence", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * state priority: bool
       * init pending = 0
       * init weighted = 0
       * init priority = false
       * action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (priority ? pending * (pending - 1) / 2 : 0) : 0)
       */
      interface Runtime { pending: number; weighted: number; priority: boolean }
      /* uneffect: refinement conditionalDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          if (runtime.priority) runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("conditional-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("conditional-drain.ts", source, "conditionalDrain", temporal)).resolves.toEqual([]);

    const mutatingGuard = source.replace(
      "if (runtime.priority) runtime.weighted += runtime.pending",
      "if (runtime.priority) runtime.weighted += runtime.pending\n          runtime.priority = false",
    );
    await expect(validateActions(
      "conditional-drain-mutating-guard.ts",
      mutatingGuard,
      "conditionalDrain",
      temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body",
      modelName: "drain",
    }));
  });

  it("summarizes a bounded tree of loop-invariant affine branches", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * state priority: bool
       * state sampled: bool
       * init pending = 0
       * init weighted = 0
       * init priority = false
       * init sampled = false
       * action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (priority ? pending * (pending - 1) / 2 : (sampled ? pending : 0)) : 0)
       */
      interface Runtime { pending: number; weighted: number; priority: boolean; sampled: boolean }
      /* uneffect: refinement tieredDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement tieredDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement tieredDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          if (runtime.priority) runtime.weighted += runtime.pending
          else if (runtime.sampled) runtime.weighted++
        }
      }
    `;
    const temporal = (parseSpecification("tiered-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("tiered-drain.ts", source, "tieredDrain", temporal)).resolves.toEqual([]);

    const mutableSample = source.replace(
      "else if (runtime.sampled) runtime.weighted++",
      "else if (runtime.sampled) runtime.weighted++\n          runtime.sampled = false",
    );
    await expect(validateActions(
      "tiered-drain-mutable-sample.ts", mutableSample, "tieredDrain", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("consumes continue after a guaranteed affine ranking step", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * state priority: bool
       * init pending = 0
       * init weighted = 0
       * init priority = false
       * action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (!priority ? 0 : pending * (pending - 1) / 2) : 0)
       */
      interface Runtime { pending: number; weighted: number; priority: boolean }
      /* uneffect: refinement continueDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement continueDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement continueDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          if (!runtime.priority) continue
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("continue-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("continue-drain.ts", source, "continueDrain", temporal)).resolves.toEqual([]);

    const skippedStep = source.replace(
      "runtime.pending--\n          if (!runtime.priority) continue",
      "if (!runtime.priority) continue\n          runtime.pending--",
    );
    await expect(validateActions(
      "continue-drain-skipped-step.ts", skippedStep, "continueDrain", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("splits an affine loop at a loop-invariant early break", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * state paused: bool
       * init pending = 0
       * init weighted = 0
       * init paused = false
       * action drain: pending' = pending > 0 ? (paused ? pending : 0) : pending, weighted' = weighted + (pending > 0 ? (paused ? 0 : pending * (pending - 1) / 2) : 0)
       */
      interface Runtime { pending: number; weighted: number; paused: boolean }
      /* uneffect: refinement breakDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement breakDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement breakDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.paused) break
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("break-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("break-drain.ts", source, "breakDrain", temporal)).resolves.toEqual([]);

    const counterDependentBreak = source.replace(
      "if (runtime.paused) break",
      "if (runtime.pending === 2) break",
    );
    await expect(validateActions(
      "break-drain-counter-dependent.ts", counterDependentBreak, "breakDrain", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("composes one state update performed by a loop-invariant early break", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state weighted: int
       * state deferred: int
       * state paused: bool
       * init pending = 0
       * init weighted = 0
       * init deferred = 0
       * init paused = false
       * action drain: pending' = pending > 0 ? (paused ? pending : 0) : pending, weighted' = weighted + (pending > 0 ? (paused ? 0 : pending * (pending - 1) / 2) : 0), deferred' = deferred + (pending > 0 ? (paused ? pending : 0) : 0)
       */
      interface Runtime { pending: number; weighted: number; deferred: number; paused: boolean }
      /* uneffect: refinement deferredDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement deferredDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement deferredDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.paused) {
            runtime.deferred += runtime.pending
            break
          }
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("deferred-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("deferred-drain.ts", source, "deferredDrain", temporal)).resolves.toEqual([]);

    const coupledBreakUpdate = source.replace(
      "runtime.deferred += runtime.pending\n            break",
      "runtime.deferred += runtime.weighted\n            break",
    );
    await expect(validateActions(
      "deferred-drain-coupled-update.ts", coupledBreakUpdate, "deferredDrain", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("composes a bounded set of independent affine early-break updates", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state deferred: int
       * state deferredWeight: int
       * state paused: bool
       * init pending = 0
       * init deferred = 0
       * init deferredWeight = 0
       * init paused = false
       * action drain: pending' = pending > 0 ? (paused ? pending : 0) : pending, deferred' = deferred + (pending > 0 ? (paused ? pending : 0) : 0), deferredWeight' = deferredWeight + (pending > 0 ? (paused ? 2 * pending : 0) : 0)
       */
      interface Runtime { pending: number; deferred: number; deferredWeight: number; paused: boolean }
      /* uneffect: refinement boundedBreakUpdates@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement boundedBreakUpdates@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement boundedBreakUpdates@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.paused) {
            runtime.deferred += runtime.pending
            runtime.deferredWeight += 2 * runtime.pending
            break
          }
          runtime.pending--
        }
      }
    `;
    const temporal = (parseSpecification("bounded-break-updates.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "bounded-break-updates.ts", source, "boundedBreakUpdates", temporal,
    )).resolves.toEqual([]);
  });

  it("joins a caught failure into a ranking finally before breaking the loop", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * state failed: int
       * state audited: int
       * state fatal: bool
       * init pending = 0
       * init processed = 0
       * init failed = 0
       * init audited = 0
       * init fatal = false
       * action drain: pending' = pending > 0 ? (fatal ? pending - 1 : 0) : pending, processed' = processed + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (fatal ? pending : 0) : 0), audited' = audited + (pending > 0 ? (fatal ? 1 : pending) : 0)
       */
      interface Runtime { pending: number; processed: number; failed: number; audited: number; fatal: boolean }
      /* uneffect: refinement caughtBreak@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtBreak@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtBreak@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            if (runtime.fatal) throw runtime.pending
            runtime.processed += runtime.pending
          } catch (amount) {
            runtime.failed += amount
            break
          } finally {
            runtime.pending--
            runtime.audited++
          }
        }
      }
    `;
    const temporal = (parseSpecification("caught-break.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("caught-break.ts", source, "caughtBreak", temporal)).resolves.toEqual([]);
  });

  it("joins caught break and continue outcomes behind invariant policy", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state delivered: int
       * state failed: int
       * state retried: int
       * state attempts: int
       * state fatal: bool
       * state stopOnFailure: bool
       * init pending = 0
       * init delivered = 0
       * init failed = 0
       * init retried = 0
       * init attempts = 0
       * init fatal = false
       * init stopOnFailure = false
       * action drain: pending' = pending > 0 ? (fatal && stopOnFailure ? pending - 1 : 0) : pending, delivered' = delivered + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (fatal ? (stopOnFailure ? pending : pending * (pending + 1) / 2) : 0) : 0), retried' = retried + (pending > 0 ? (fatal && !stopOnFailure ? pending * (pending + 1) / 2 : 0) : 0), attempts' = attempts + (pending > 0 ? (fatal && stopOnFailure ? 1 : pending) : 0)
       */
      interface Runtime { pending: number; delivered: number; failed: number; retried: number; attempts: number; fatal: boolean; stopOnFailure: boolean }
      /* uneffect: refinement caughtPolicy@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtPolicy@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtPolicy@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            if (runtime.fatal) throw runtime.pending
            runtime.delivered += runtime.pending
          } catch (amount) {
            runtime.failed += amount
            if (runtime.stopOnFailure) break
            runtime.retried += amount
            continue
          } finally {
            runtime.pending--
            runtime.attempts++
          }
        }
      }
    `;
    const temporal = (parseSpecification("caught-policy.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("caught-policy.ts", source, "caughtPolicy", temporal)).resolves.toEqual([]);
  });

  it("keeps disjunctive stop-policy updates path-wise affine", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * state stoppedWeight: int
       * state fatal: bool
       * state circuitOpen: bool
       * init pending = 0
       * init processed = 0
       * init stoppedWeight = 0
       * init fatal = false
       * init circuitOpen = false
       * action drain: pending' = pending > 0 ? (fatal || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? (fatal || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (fatal ? pending : (circuitOpen ? 2 * pending : 0)) : 0)
       */
      interface Runtime { pending: number; processed: number; stoppedWeight: number; fatal: boolean; circuitOpen: boolean }
      /* uneffect: refinement disjunctiveStop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement disjunctiveStop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement disjunctiveStop@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.fatal) {
            runtime.stoppedWeight += runtime.pending
            break
          }
          if (runtime.circuitOpen) {
            runtime.stoppedWeight += 2 * runtime.pending
            break
          }
          runtime.pending--
          runtime.processed += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("disjunctive-stop.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "disjunctive-stop.ts", source, "disjunctiveStop", temporal,
    )).resolves.toEqual([]);
  });

  it("keeps nested Boolean stop-policy updates aligned with their completion tree", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * state stoppedWeight: int
       * state urgent: bool
       * state sampled: bool
       * state circuitOpen: bool
       * init pending = 0
       * init processed = 0
       * init stoppedWeight = 0
       * init urgent = false
       * init sampled = false
       * init circuitOpen = false
       * action drain: pending' = pending > 0 ? ((urgent && sampled) || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? ((urgent && sampled) || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (urgent ? (sampled ? pending : (circuitOpen ? 2 * pending : 0)) : (circuitOpen ? 2 * pending : 0)) : 0)
       */
      interface Runtime { pending: number; processed: number; stoppedWeight: number; urgent: boolean; sampled: boolean; circuitOpen: boolean }
      /* uneffect: refinement nestedStop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement nestedStop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement nestedStop@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.urgent) {
            if (runtime.sampled) {
              runtime.stoppedWeight += runtime.pending
              break
            }
          }
          if (runtime.circuitOpen) {
            runtime.stoppedWeight += 2 * runtime.pending
            break
          }
          runtime.pending--
          runtime.processed += runtime.pending
        }
      }
    `;
    const temporal = (parseSpecification("nested-stop.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "nested-stop.ts", source, "nestedStop", temporal,
    )).resolves.toEqual([]);
  });

  it("carries a mutable local through sequential control-flow joins", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * state audited: int
       * state urgent: bool
       * state sampled: bool
       * init total = 0
       * init audited = 0
       * init urgent = false
       * init sampled = false
       * action record: total' = total + (sampled ? (urgent ? 5 : 4) : (urgent ? 2 : 1)), audited' = audited + 1
       */
      interface Runtime { total: number; audited: number; urgent: boolean; sampled: boolean }
      /* uneffect: refinement localJoin@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement localJoin@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement localJoin@1 action record */
      export function record(runtime: Runtime) {
        let weight = 1
        if (runtime.urgent) weight = 2
        if (runtime.sampled) weight += 3
        runtime.total += weight
        runtime.audited++
      }
    `;
    const temporal = (parseSpecification("local-join.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "local-join.ts", source, "localJoin", temporal,
    )).resolves.toEqual([]);
  });

  it("carries the normal predecessor local environment past an abrupt branch", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state priority: bool
       * init billed = 0
       * init audited = 0
       * init priority = false
       * action record: billed' = priority ? billed : billed + 4, audited' = priority ? audited : audited + 1
       */
      interface Runtime { billed: number; audited: number; priority: boolean }
      /* uneffect: refinement abruptLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement abruptLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement abruptLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        if (runtime.priority) {
          units = 2
          return
        }
        units += 3
        runtime.billed += units
        runtime.audited++
      }
    `;
    const temporal = (parseSpecification("abrupt-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "abrupt-local.ts", source, "abruptLocal", temporal,
    )).resolves.toEqual([]);
  });

  it("carries distinct mutable-local snapshots through typed throw and normal edges", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * action record: billed' = billed + (failed ? 4 : 3), audited' = audited + 1
       */
      interface Runtime { billed: number; audited: number; failed: boolean }
      /* uneffect: refinement caughtLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.failed) {
            units = 2
            throw units
          }
          units = 3
        } catch (amount) {
          runtime.billed += units + amount
          runtime.audited++
          return
        }
        runtime.billed += units
        runtime.audited++
      }
    `;
    const temporal = (parseSpecification("caught-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "caught-local.ts", source, "caughtLocal", temporal,
    )).resolves.toEqual([]);
  });

  it("runs mandatory finally with the mutable-local snapshot owned by each completion edge", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state stopped: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init stopped = false
       * action record: billed' = stopped ? billed : billed + (failed ? 6 : 4), audited' = audited + (stopped ? 2 : (failed ? 3 : 4))
       */
      interface Runtime { billed: number; audited: number; failed: boolean; stopped: boolean }
      /* uneffect: refinement finallyLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement finallyLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement finallyLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.stopped) {
            units = 2
            return
          }
          if (runtime.failed) {
            units = 3
            throw units
          }
          units = 4
        } catch (amount) {
          runtime.billed += units + amount
          return
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification("finally-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "finally-local.ts", source, "finallyLocal", temporal,
    )).resolves.toEqual([]);
  });

  it("owns mutable-local snapshots across scalar switch fallthrough and completion edges", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state kind: int
       * init billed = 0
       * init audited = 0
       * init kind = 0
       * action record: billed' = kind === 1 ? billed : billed + (kind === 2 ? 8 : (kind === 3 ? 6 : 2)), audited' = audited + (kind === 1 ? 3 : (kind === 2 ? 4 : (kind === 3 ? 6 : 2)))
       */
      interface Runtime { billed: number; audited: number; kind: number }
      /* uneffect: refinement switchLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement switchLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement switchLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          switch (runtime.kind) {
            case 0:
              units = 2
              break
            case 1:
              units = 3
              return
            case 2:
              units = 4
              throw units
            case 3:
              units = 5
            default:
              units += 1
              break
          }
        } catch (amount) {
          runtime.billed += units + amount
          return
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification("switch-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "switch-local.ts", source, "switchLocal", temporal,
    )).resolves.toEqual([]);
  });

  it("carries mutable-local snapshots across bounded iterations and abrupt exits", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state mode: int
       * init billed = 0
       * init audited = 0
       * init mode = 0
       * action record: billed' = mode === 3 ? billed : billed + (mode === 4 ? 8 : (mode === 2 ? 4 : (mode === 1 ? 13 : 14))), audited' = audited + ((mode === 2 || mode === 3 || mode === 4) ? 6 : (mode === 1 ? 27 : 30))
       */
      interface Runtime { billed: number; audited: number; mode: number }
      /* uneffect: refinement finiteLoopLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement finiteLoopLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement finiteLoopLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 0
        try {
          for (const step of [1, 2, 3, 4] as const) {
            try {
              units += step
              if (runtime.mode === 1 && step === 2) continue
              if (runtime.mode === 2 && step === 2) break
              if (runtime.mode === 3 && step === 2) return
              if (runtime.mode === 4 && step === 2) throw units
              units += 1
            } finally {
              runtime.audited += units
            }
          }
        } catch (amount) {
          runtime.billed += units + amount
          return
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification("finite-loop-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "finite-loop-local.ts", source, "finiteLoopLocal", temporal,
    )).resolves.toEqual([]);

    const wrongAccumulation = source.replace("units += 1", "units += 2");
    await expect(validateActions(
      "finite-loop-local-wrong-accumulation.ts", wrongAccumulation, "finiteLoopLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const unsupported = [
      ["finite-loop-local-dynamic.ts", source.replace(
        "for (const step of [1, 2, 3, 4] as const)",
        "for (const step of runtime.steps)",
      ).replace("mode: number }", "mode: number; steps: number[] }")],
      ["finite-loop-local-over-budget.ts", source.replace(
        "[1, 2, 3, 4] as const",
        `[${Array.from({ length: 65 }, (_, index) => index + 1).join(", ")}] as const`,
      )],
    ] as const;
    for (const [fileName, changed] of unsupported) {
      expect(validateActionsStatically(
        fileName, changed, "finiteLoopLocal", temporal,
      ), fileName).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "record",
      }));
    }

    const nestedBlock = source.replace("units += step", "{ units += step }");
    await expect(validateActions(
      "finite-loop-local-nested-block.ts", nestedBlock, "finiteLoopLocal", temporal,
    )).resolves.toEqual([]);

    const ownedLoopLabel = source
      .replace("for (const step of", "outer: for (const step of")
      .replace("continue\n", "continue outer\n");
    await expect(validateActions(
      "finite-loop-local-labeled.ts", ownedLoopLabel, "finiteLoopLocal", temporal,
    )).resolves.toEqual([]);

    const ownedAscendingLabel = source
      .replace(
        "for (const step of [1, 2, 3, 4] as const)",
        "outer: for (let step = 1; step < 5; step++)",
      )
      .replace("continue\n", "continue outer\n");
    await expect(validateActions(
      "finite-loop-local-ascending-label.ts", ownedAscendingLabel, "finiteLoopLocal", temporal,
    )).resolves.toEqual([]);

    const canonicalWhile = `
      /* uneffect:
       * state total: int
       * init total = 0
       * action record: total' = total + 6
       */
      interface Runtime { total: number }
      /* uneffect: refinement finiteWhileLocal@1 create */ export function createWhile(initial: Runtime) { return initial }
      /* uneffect: refinement finiteWhileLocal@1 observe */ export function observeWhile(runtime: Runtime) { return runtime }
      /* uneffect: refinement finiteWhileLocal@1 action record */
      export function recordWhile(runtime: Runtime) {
        let units = 0
        let index = 0
        while (index < 3) {
          units += index + 1
          index++
        }
        runtime.total += units
      }
    `;
    const whileTemporal = (parseSpecification(
      "finite-while-local.ts", canonicalWhile,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "finite-while-local.ts", canonicalWhile, "finiteWhileLocal", whileTemporal,
    )).resolves.toEqual([]);
  });

  it("projects outer mutable locals through a standalone lexical block", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * state stopped: bool
       * init total = 0
       * init stopped = false
       * action record: total' = stopped ? total : total + 5
       */
      interface Runtime { total: number; stopped: boolean }
      /* uneffect: refinement lexicalLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement lexicalLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement lexicalLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        {
          const increment = 2
          units += increment
          if (runtime.stopped) return
          units += 2
        }
        runtime.total += units
      }
    `;
    const temporal = (parseSpecification("lexical-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "lexical-local.ts", source, "lexicalLocal", temporal,
    )).resolves.toEqual([]);

    const wrongSuffix = source.replace("units += 2\n        }", "units += 3\n        }");
    await expect(validateActions(
      "lexical-local-wrong-suffix.ts", wrongSuffix, "lexicalLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    for (const [fileName, changed] of [
      ["lexical-local-shadow.ts", source.replace("const increment = 2", "let units = 2")],
      ["lexical-local-escape.ts", source.replace("runtime.total += units", "runtime.total += increment")],
    ] as const) {
      expect(validateActionsStatically(
        fileName, changed, "lexicalLocal", temporal,
      ), fileName).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "record",
      }));
    }
  });

  it("carries outer mutable locals through an owned labeled-block exit", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * state stopped: bool
       * init total = 0
       * init stopped = false
       * action record: total' = stopped ? total + 3 : total + 5
       */
      interface Runtime { total: number; stopped: boolean }
      /* uneffect: refinement labeledLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement labeledLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement labeledLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        attempt: {
          units += 2
          if (runtime.stopped) break attempt
          units += 2
        }
        runtime.total += units
      }
    `;
    const temporal = (parseSpecification("labeled-local.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "labeled-local.ts", source, "labeledLocal", temporal,
    )).resolves.toEqual([]);

    const wrongSuffix = source.replace("units += 2\n        }", "units += 3\n        }");
    await expect(validateActions(
      "labeled-local-wrong-suffix.ts", wrongSuffix, "labeledLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    for (const [fileName, changed] of [
      ["labeled-local-nested-capture.ts", source.replace(
        "if (runtime.stopped) break attempt",
        "nested: { if (runtime.stopped) break attempt }",
      )],
      ["labeled-local-unknown-target.ts", source.replace("break attempt", "break missing")],
      ["labeled-local-real-return.ts", source.replace("break attempt", "return")],
    ] as const) {
      expect(validateActionsStatically(
        fileName, changed, "labeledLocal", temporal,
      ), fileName).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "record",
      }));
    }
  });

  it("carries a catch-side mutable-local update into the common continuation", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * state failed: bool
       * init total = 0
       * init failed = false
       * action record: total' = failed ? total + 4 : total + 2
       */
      interface Runtime { total: number; failed: boolean }
      /* uneffect: refinement catchLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement catchLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement catchLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.failed) {
            units += 2
            throw 1
          }
          units += 1
        } catch (reason) {
          units += reason
        }
        runtime.total += units
      }
    `;
    const temporal = (parseSpecification("catch-local-mutation.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "catch-local-mutation.ts", source, "catchLocal", temporal,
    )).resolves.toEqual([]);

    const wrongRecovery = source.replace("units += reason", "units += reason + 1");
    await expect(validateActions(
      "catch-local-wrong-recovery.ts", wrongRecovery, "catchLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const rethrow = source.replace("units += reason\n        }", "units += reason\n          throw reason\n        }");
    expect(validateActionsStatically(
      "catch-local-rethrow.ts", rethrow, "catchLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));
  });

  it("applies a mandatory-finally local mutation to every incoming completion edge", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state mode: int
       * init billed = 0
       * init audited = 0
       * init mode = 0
       * action record: billed' = mode === 1 ? billed : billed + (mode === 2 ? 5 : 6), audited' = audited + (mode === 1 ? 3 : (mode === 2 ? 5 : 6))
       */
      interface Runtime { billed: number; audited: number; mode: number }
      /* uneffect: refinement finallyMutation@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement finallyMutation@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement finallyMutation@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.mode === 1) {
            units += 1
            return
          }
          if (runtime.mode === 2) {
            units += 3
            throw units
          }
          units += 4
        } catch (amount) {
          units = amount
        } finally {
          units += 1
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification("finally-local-mutation.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "finally-local-mutation.ts", source, "finallyMutation", temporal,
    )).resolves.toEqual([]);

    const wrongFinalization = source.replace("units += 1\n          runtime.audited", "units += 2\n          runtime.audited");
    await expect(validateActions(
      "finally-local-wrong-finalization.ts", wrongFinalization, "finallyMutation", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const nestedSource = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state stopped: bool
       * init billed = 0
       * init audited = 0
       * init stopped = false
       * action record: billed' = stopped ? billed : billed + 4, audited' = audited + (stopped ? 3 : 4)
       */
      interface Runtime { billed: number; audited: number; stopped: boolean }
      /* uneffect: refinement nestedFinallyMutation@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement nestedFinallyMutation@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement nestedFinallyMutation@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          try {
            if (runtime.stopped) {
              units += 1
              return
            }
            units += 2
          } finally {
            units += 1
          }
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const nestedTemporal = (parseSpecification(
      "nested-finally-local-mutation.ts", nestedSource,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "nested-finally-local-mutation.ts", nestedSource, "nestedFinallyMutation", nestedTemporal,
    )).resolves.toEqual([]);

    const opaqueFinallyThrow = source.replace(
      "runtime.audited += units",
      "runtime.audited += units\n          if (runtime.mode === 2) throw new Error('failed')",
    );
    expect(validateActionsStatically(
      "finally-local-abrupt.ts", opaqueFinallyThrow, "finallyMutation", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("carries a catch-side mutable-local update onto a direct-return edge", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * action record: billed' = failed ? billed : billed + 2, audited' = audited + (failed ? 4 : 2)
       */
      interface Runtime { billed: number; audited: number; failed: boolean }
      /* uneffect: refinement catchReturnLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement catchReturnLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement catchReturnLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.failed) {
            units += 2
            throw 1
          }
          units += 1
        } catch (reason) {
          units += reason
          return
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "catch-return-local.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "catch-return-local.ts", source, "catchReturnLocal", temporal,
    )).resolves.toEqual([]);

    const wrongReturnSnapshot = source.replace("units += reason", "units += reason + 1");
    await expect(validateActions(
      "catch-return-local-wrong.ts", wrongReturnSnapshot, "catchReturnLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const rethrow = source.replace("return\n        } finally", "throw reason\n        } finally");
    expect(validateActionsStatically(
      "catch-return-local-rethrow.ts", rethrow, "catchReturnLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));
  });

  it("carries a catch-side mutable-local update and payload onto a rethrow edge", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state recovered: int
       * state audited: int
       * state failed: bool
       * init recovered = 0
       * init audited = 0
       * init failed = false
       * action record: recovered' = recovered + (failed ? 8 : 2), audited' = audited + (failed ? 4 : 2)
       */
      interface Runtime { recovered: number; audited: number; failed: boolean }
      /* uneffect: refinement catchRethrowLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement catchRethrowLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement catchRethrowLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } catch (reason) {
            units += reason
            throw units
          } finally {
            runtime.audited += units
          }
        } catch (amount) {
          runtime.recovered += units + amount
          return
        }
        runtime.recovered += units
      }
    `;
    const temporal = (parseSpecification(
      "catch-rethrow-local.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "catch-rethrow-local.ts", source, "catchRethrowLocal", temporal,
    )).resolves.toEqual([]);

    const wrongRethrowSnapshot = source.replace("units += reason", "units += reason + 1");
    await expect(validateActions(
      "catch-rethrow-local-wrong.ts", wrongRethrowSnapshot, "catchRethrowLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const opaqueRethrow = source.replace("throw units\n          } finally", "throw new Error('failed')\n          } finally");
    expect(validateActionsStatically(
      "catch-rethrow-local-opaque.ts", opaqueRethrow, "catchRethrowLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("keeps conditional catch-return and normal snapshots distinct", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state stop: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init stop = false
       * action record: billed' = failed && stop ? billed : billed + (failed ? 6 : 2), audited' = audited + (failed ? (stop ? 4 : 6) : 2)
       */
      interface Runtime { billed: number; audited: number; failed: boolean; stop: boolean }
      /* uneffect: refinement conditionalCatchReturn@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalCatchReturn@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalCatchReturn@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.failed) {
            units += 2
            throw 1
          }
          units += 1
        } catch (reason) {
          units += reason
          if (runtime.stop) return
          units += 2
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-catch-return.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-catch-return.ts", source, "conditionalCatchReturn", temporal,
    )).resolves.toEqual([]);

    const wrongNormalSnapshot = source.replace("units += 2\n        } finally", "units += 3\n        } finally");
    await expect(validateActions(
      "conditional-catch-return-wrong.ts", wrongNormalSnapshot, "conditionalCatchReturn", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const conditionalRethrow = source.replace(
      "if (runtime.stop) return",
      "if (runtime.stop) throw units",
    );
    expect(validateActionsStatically(
      "conditional-catch-rethrow.ts", conditionalRethrow, "conditionalCatchReturn", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));
  });

  it("keeps conditional catch-rethrow payload and normal snapshots distinct", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state recovered: int
       * state audited: int
       * state failed: bool
       * state escalate: bool
       * init recovered = 0
       * init audited = 0
       * init failed = false
       * init escalate = false
       * action record: recovered' = recovered + (failed ? (escalate ? 8 : 6) : 2), audited' = audited + (failed ? (escalate ? 4 : 6) : 2)
       */
      interface Runtime { recovered: number; audited: number; failed: boolean; escalate: boolean }
      /* uneffect: refinement conditionalCatchRethrow@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalCatchRethrow@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalCatchRethrow@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } catch (reason) {
            units += reason
            if (runtime.escalate) throw units
            units += 2
          } finally {
            runtime.audited += units
          }
        } catch (amount) {
          runtime.recovered += units + amount
          return
        }
        runtime.recovered += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-catch-rethrow.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-catch-rethrow.ts", source, "conditionalCatchRethrow", temporal,
    )).resolves.toEqual([]);

    const wrongNormalSnapshot = source.replace("units += 2\n          } finally", "units += 3\n          } finally");
    await expect(validateActions(
      "conditional-catch-rethrow-wrong.ts", wrongNormalSnapshot, "conditionalCatchRethrow", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const opaqueRethrow = source.replace(
      "if (runtime.escalate) throw units",
      "if (runtime.escalate) throw new Error('escalated')",
    );
    expect(validateActionsStatically(
      "conditional-catch-rethrow-opaque.ts", opaqueRethrow, "conditionalCatchRethrow", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("carries a conditional catch break snapshot through finally into a bounded-loop exit", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state stop: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init stop = false
       * action record: billed' = billed + (failed ? (stop ? 4 : 7) : 3), audited' = audited + (failed ? (stop ? 4 : 6) : 2)
       */
      interface Runtime { billed: number; audited: number; failed: boolean; stop: boolean }
      /* uneffect: refinement catchBreakLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement catchBreakLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement catchBreakLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        for (let attempt = 0; attempt < 1; attempt++) {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } catch (reason) {
            units += reason
            if (runtime.stop) break
            units += 2
          } finally {
            runtime.audited += units
          }
          units += 1
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-catch-break.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-catch-break.ts", source, "catchBreakLocal", temporal,
    )).resolves.toEqual([]);

    const wrongNormalSnapshot = source.replace("units += 2\n          } finally", "units += 3\n          } finally");
    await expect(validateActions(
      "conditional-catch-break-wrong.ts", wrongNormalSnapshot, "catchBreakLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const unknownLabeledBreak = source.replace("if (runtime.stop) break", "if (runtime.stop) break outer");
    expect(validateActionsStatically(
      "conditional-catch-unknown-break.ts", unknownLabeledBreak, "catchBreakLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("carries a conditional catch continue snapshot through finally into the next bounded iteration", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state retry: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init retry = false
       * action record: billed' = billed + (failed ? (retry ? 7 : 13) : 5), audited' = audited + (failed ? (retry ? 11 : 18) : 6)
       */
      interface Runtime { billed: number; audited: number; failed: boolean; retry: boolean }
      /* uneffect: refinement catchContinueLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement catchContinueLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement catchContinueLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } catch (reason) {
            units += reason
            if (runtime.retry) continue
            units += 2
          } finally {
            runtime.audited += units
          }
          units += 1
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-catch-continue.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-catch-continue.ts", source, "catchContinueLocal", temporal,
    )).resolves.toEqual([]);

    const wrongRetrySnapshot = source.replace("units += reason", "units += reason + 1");
    await expect(validateActions(
      "conditional-catch-continue-wrong.ts", wrongRetrySnapshot, "catchContinueLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const ownedLabeledContinue = source
      .replace("for (let attempt", "attempts: for (let attempt")
      .replace("if (runtime.retry) continue", "if (runtime.retry) continue attempts");
    await expect(validateActions(
      "conditional-catch-owned-continue.ts", ownedLabeledContinue, "catchContinueLocal", temporal,
    )).resolves.toEqual([]);

    const unknownLabeledContinue = source.replace(
      "if (runtime.retry) continue", "if (runtime.retry) continue outer",
    );
    expect(validateActionsStatically(
      "conditional-catch-unknown-continue.ts", unknownLabeledContinue, "catchContinueLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("keeps a conditional finally-return snapshot separate while overriding prior completion", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state stop: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init stop = false
       * action record: billed' = failed || stop ? billed : billed + 3, audited' = audited + (failed ? 4 : 3)
       */
      interface Runtime { billed: number; audited: number; failed: boolean; stop: boolean }
      /* uneffect: refinement conditionalFinallyReturn@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalFinallyReturn@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalFinallyReturn@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } finally {
            units += 1
            if (runtime.stop) return
          }
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-finally-return.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-finally-return.ts", source, "conditionalFinallyReturn", temporal,
    )).resolves.toEqual([]);

    const wrongFinallySnapshot = source.replace("units += 1\n            if", "units += 2\n            if");
    await expect(validateActions(
      "conditional-finally-return-wrong.ts", wrongFinallySnapshot, "conditionalFinallyReturn", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "audited",
    }));

    const opaqueFinallyThrow = source.replace(
      "if (runtime.stop) return", "if (runtime.stop) throw new Error('stopped')",
    );
    expect(validateActionsStatically(
      "conditional-finally-throw.ts", opaqueFinallyThrow, "conditionalFinallyReturn", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("carries a conditional finally-throw payload with its overriding mutable-local snapshot", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state recovered: int
       * state failed: bool
       * state escalate: bool
       * init recovered = 0
       * init failed = false
       * init escalate = false
       * action record: recovered' = recovered + (failed ? (escalate ? 8 : 5) : (escalate ? 6 : 3))
       */
      interface Runtime { recovered: number; failed: boolean; escalate: boolean }
      /* uneffect: refinement conditionalFinallyThrow@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalFinallyThrow@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalFinallyThrow@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } finally {
            units += 1
            if (runtime.escalate) throw units
          }
        } catch (amount) {
          runtime.recovered += units + amount
          return
        }
        runtime.recovered += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-finally-throw.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-finally-throw.ts", source, "conditionalFinallyThrow", temporal,
    )).resolves.toEqual([]);

    const wrongFinallySnapshot = source.replace("units += 1\n            if", "units += 2\n            if");
    await expect(validateActions(
      "conditional-finally-throw-wrong.ts", wrongFinallySnapshot, "conditionalFinallyThrow", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "recovered",
    }));

    const opaqueFinallyThrow = source.replace(
      "if (runtime.escalate) throw units",
      "if (runtime.escalate) throw new Error('escalated')",
    );
    expect(validateActionsStatically(
      "conditional-finally-throw-opaque.ts", opaqueFinallyThrow, "conditionalFinallyThrow", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("consumes a conditional finally-break snapshot after it overrides prior completion", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state stop: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init stop = false
       * action record: billed' = failed ? (stop ? billed + 4 : billed) : billed + (stop ? 3 : 4), audited' = audited + (failed ? 4 : 3)
       */
      interface Runtime { billed: number; audited: number; failed: boolean; stop: boolean }
      /* uneffect: refinement conditionalFinallyBreak@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalFinallyBreak@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalFinallyBreak@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        for (let attempt = 0; attempt < 1; attempt++) {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } finally {
            units += 1
            runtime.audited += units
            if (runtime.stop) break
          }
          units += 1
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-finally-break.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-finally-break.ts", source, "conditionalFinallyBreak", temporal,
    )).resolves.toEqual([]);

    const wrongFinallySnapshot = source.replace("units += 1\n            runtime.audited", "units += 2\n            runtime.audited");
    await expect(validateActions(
      "conditional-finally-break-wrong.ts", wrongFinallySnapshot, "conditionalFinallyBreak", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const ownedLabeledBreak = source
      .replace("for (let attempt", "attempts: for (let attempt")
      .replace("if (runtime.stop) break", "if (runtime.stop) break attempts");
    await expect(validateActions(
      "conditional-finally-owned-break.ts", ownedLabeledBreak, "conditionalFinallyBreak", temporal,
    )).resolves.toEqual([]);

    const unknownFinallyBreak = source.replace("if (runtime.stop) break", "if (runtime.stop) break outer");
    expect(validateActionsStatically(
      "conditional-finally-unknown-break.ts", unknownFinallyBreak, "conditionalFinallyBreak", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("advances from a conditional finally-continue snapshot after overriding prior completion", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const validateActionsStatically = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state billed: int
       * state audited: int
       * state failed: bool
       * state retry: bool
       * init billed = 0
       * init audited = 0
       * init failed = false
       * init retry = false
       * action record: billed' = failed ? (retry ? billed + 7 : billed) : billed + (retry ? 5 : 7), audited' = audited + (failed ? (retry ? 11 : 4) : (retry ? 8 : 9))
       */
      interface Runtime { billed: number; audited: number; failed: boolean; retry: boolean }
      /* uneffect: refinement conditionalFinallyContinue@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement conditionalFinallyContinue@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement conditionalFinallyContinue@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (runtime.failed) {
              units += 2
              throw 1
            }
            units += 1
          } finally {
            units += 1
            runtime.audited += units
            if (runtime.retry) continue
          }
          units += 1
        }
        runtime.billed += units
      }
    `;
    const temporal = (parseSpecification(
      "conditional-finally-continue.ts", source,
    ) as { temporal: unknown }).temporal;
    await expect(validateActions(
      "conditional-finally-continue.ts", source, "conditionalFinallyContinue", temporal,
    )).resolves.toEqual([]);

    const wrongFinallySnapshot = source.replace("units += 1\n            runtime.audited", "units += 2\n            runtime.audited");
    await expect(validateActions(
      "conditional-finally-continue-wrong.ts", wrongFinallySnapshot, "conditionalFinallyContinue", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const ownedLabeledContinue = source
      .replace("for (let attempt", "attempts: for (let attempt")
      .replace("if (runtime.retry) continue", "if (runtime.retry) continue attempts");
    await expect(validateActions(
      "conditional-finally-owned-continue.ts", ownedLabeledContinue, "conditionalFinallyContinue", temporal,
    )).resolves.toEqual([]);

    const unknownLabeledContinue = source.replace(
      "if (runtime.retry) continue", "if (runtime.retry) continue outer",
    );
    expect(validateActionsStatically(
      "conditional-finally-unknown-continue.ts", unknownLabeledContinue, "conditionalFinallyContinue", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("composes an affine countdown summary from the symbolic state at loop entry", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * state audited: int
       * init pending = 0
       * init processed = 0
       * init audited = 0
       * action refillAndDrain: pending' = pending + 1 > 0 ? 0 : pending + 1, processed' = processed + (pending + 1 > 0 ? pending + 1 : 0), audited' = audited + 1
       */
      interface Runtime { pending: number; processed: number; audited: number }
      /* uneffect: refinement affineEntry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement affineEntry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement affineEntry@1 action refillAndDrain */
      export function refillAndDrain(runtime: Runtime) {
        runtime.pending++
        while (runtime.pending > 0) {
          runtime.pending--
          runtime.processed++
        }
        runtime.audited++
      }
    `;
    const temporal = (parseSpecification("affine-entry.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("affine-entry.ts", source, "affineEntry", temporal)).resolves.toEqual([]);
  });

  it("summarizes an inclusive constant-lower-bound countdown from symbolic entry state", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * init pending = 0
       * init processed = 0
       * action retainTwo: pending' = pending + 2 >= 3 ? 2 : pending + 2, processed' = processed + (pending + 2 >= 3 ? pending : 0)
       */
      interface Runtime { pending: number; processed: number }
      /* uneffect: refinement boundedFloor@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement boundedFloor@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement boundedFloor@1 action retainTwo */
      export function retainTwo(runtime: Runtime) {
        runtime.pending += 2
        while (runtime.pending >= 3) {
          runtime.pending--
          runtime.processed++
        }
      }
    `;
    const temporal = (parseSpecification("bounded-floor.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("bounded-floor.ts", source, "boundedFloor", temporal)).resolves.toEqual([]);
  });

  it("summarizes a positive constant-step countdown with an exact integral quotient", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state pending: int
       * state processed: int
       * init pending = 0
       * init processed = 0
       * action drainPairs: pending' = pending + 2 >= 3 ? pending + 2 - 2 * ((pending - pending % 2) / 2 + (pending % 2 > 0 ? 1 : 0)) : pending + 2, processed' = processed + (pending + 2 >= 3 ? (pending - pending % 2) / 2 + (pending % 2 > 0 ? 1 : 0) : 0)
       */
      interface Runtime { pending: number; processed: number }
      /* uneffect: refinement pairDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement pairDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement pairDrain@1 action drainPairs */
      export function drainPairs(runtime: Runtime) {
        runtime.pending += 2
        while (runtime.pending >= 3) {
          runtime.pending -= 2
          runtime.processed++
        }
      }
    `;
    const temporal = (parseSpecification("pair-drain.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("pair-drain.ts", source, "pairDrain", temporal)).resolves.toEqual([]);
  });

  it("summarizes a positive constant-step scale-up loop with exact overshoot", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state active: int
       * state starts: int
       * init active = 0
       * init starts = 0
       * action scaleUp: active' = active < 5 ? active + 2 * ((5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0)) : active, starts' = starts + (active < 5 ? (5 - active - (5 - active) % 2) / 2 + ((5 - active) % 2 > 0 ? 1 : 0) : 0)
       */
      interface Pool { active: number; starts: number }
      /* uneffect: refinement workerScale@1 create */ export function create(initial: Pool) { return initial }
      /* uneffect: refinement workerScale@1 observe */ export function observe(pool: Pool) { return pool }
      /* uneffect: refinement workerScale@1 action scaleUp */
      export function scaleUp(pool: Pool) {
        while (pool.active < 5) {
          pool.active += 2
          pool.starts++
        }
      }
    `;
    const temporal = (parseSpecification("worker-scale.ts", source) as { temporal: unknown }).temporal;
    await expect(validateActions("worker-scale.ts", source, "workerScale", temporal)).resolves.toEqual([]);
  });

  it("drops unreachable statements after unconditional return and throw", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state attempted: int
       * state recovered: int
       * state unreachable: int
       * init attempted = 0
       * init recovered = 0
       * init unreachable = 0
       * action recover: attempted' = attempted + 1, recovered' = recovered + 1
       */
      interface Runtime { attempted: number; recovered: number; unreachable: number }
      /* uneffect: refinement recovery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement recovery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement recovery@1 action recover */
      export function recover(runtime: Runtime) {
        try {
          runtime.attempted++
          throw false
          runtime.unreachable += 100
        } catch {
          runtime.recovered++
          return
          runtime.unreachable += 10
        }
        runtime.unreachable++
      }
    `;
    const specification = parseSpecification("unreachable-recovery.ts", source) as { temporal: unknown };
    expect(validateActions("unreachable-recovery.ts", source, "recovery", specification.temporal)).toEqual([]);
  });

  it("composes a lexical block completion while keeping aliases block-scoped", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state started: int
       * state finished: int
       * state audited: int
       * state cancel: bool
       * init started = 0
       * init finished = 0
       * init audited = 0
       * init cancel = false
       * action execute: started' = started + 1, finished' = cancel ? finished : finished + 1, audited' = cancel ? audited : audited + 1
       */
      interface Runtime { started: number; finished: number; audited: number; cancel: boolean }
      /* uneffect: refinement lexical@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement lexical@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement lexical@1 action execute */
      export function execute(runtime: Runtime) {
        {
          const state = runtime
          state.started++
          if (state.cancel) return
          state.finished++
        }
        runtime.audited++
      }
    `;
    const specification = parseSpecification("lexical-completion.ts", source) as { temporal: unknown };
    expect(validateActions("lexical-completion.ts", source, "lexical", specification.temporal)).toEqual([]);
  });

  it("refines finite TypeScript iteration with abrupt completion and finally cleanup", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * state settled: int
       * state stop: int
       * init total = 0
       * init settled = 0
       * init stop = 0
       * action applyBatch: total' = stop === 1 ? total + 1 : stop === 2 ? total + 1 + 2 : total + 1 + 2 + 3, settled' = stop === 1 ? settled + 1 : stop === 2 ? settled + 1 + 1 : settled + 1 + 1 + 1
       */
      interface Runtime { total: number; settled: number; stop: number }
      /* uneffect: refinement batch@1 create */
      export function create(initial: Runtime) { return initial }
      /* uneffect: refinement batch@1 observe */
      export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement batch@1 action applyBatch */
      export function applyBatch(runtime: Runtime) {
        for (const delta of [1, 2, 3] as const) {
          try {
            runtime.total += delta
            if (runtime.stop === delta) return
          } finally {
            runtime.settled++
          }
        }
      }
    `;
    const specification = parseSpecification("finite-batch.ts", source) as { temporal: unknown };
    expect(validateActions("finite-batch.ts", source, "batch", specification.temporal)).toEqual([]);
  });

  it("generates shrinking property tests from refined TypeScript boundaries and replays counterexamples", async () => {
    const generatePropertyTests = futureApi("generateUneffectPropertyTests");
    const result = await generatePropertyTests({ files: files({
      "src/divide.ts": `
        import type { Int, Nat } from "@mizchi/uneffect"
        /* uneffect: requires denominator > 0 */
        /* uneffect: ensures result * denominator <= numerator */
        export function quotient(numerator: Nat, denominator: Int): Int {
          return Math.floor(numerator / denominator) as Int
        }
      `,
    }), backend: "quickcheck", shrinking: true }) as { generatedFiles: Record<string, string>; boundaries: Array<{ functionName: string; generators: string[]; shrinkers: string[] }> };
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      functionName: "quotient", generators: ["Nat", "Int"], shrinkers: ["Nat", "Int"],
    }));
    expect(result.generatedFiles["src/divide.uneffect.test.ts"]).toContain("shrink");
  });

  it("reports annotation drift when implementation effects exceed or no longer use the declared upper bound", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ mode: "strict", files: files({
      "src/io.ts": `
        /* uneffect: effect Console | FsRead<"$CWD/config/**"> */
        export async function load() {
          await fetch("https://api.example.com/data")
        }
      `,
    }) }) as { diagnostics: Array<{ code: string; effect: string }> };
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-effect", effect: expect.stringContaining("Fetch") }));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unused-effect", effect: "Console" }),
      expect.objectContaining({ code: "unused-effect", effect: expect.stringContaining("FsRead") }),
    ]));
  });

  it("adopts ordinary TypeScript gradually without changing its emitted JavaScript", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({
      files: files({ "src/plain.ts": `export function add(a: number, b: number) { return a + b }` }),
      mode: "gradual",
    }) as { diagnostics: unknown[]; emittedFiles: Record<string, string>; coverage: { annotatedFunctions: number } };
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage.annotatedFunctions).toBe(0);
    expect(result.emittedFiles["src/plain.js"]).toContain("return a + b");
    expect(result.emittedFiles["src/plain.js"]).not.toContain("uneffect");
  });

  it("separates replayable React render from event, Effect, and cleanup capabilities", () => {
    const analyzeReact = futureApi("analyzeReactSemantics");
    const generateReactLifecycle = futureApi("generateReactLifecycleQuint");
    const generateReactActionQueue = futureApi("generateReactActionQueueQuint");
    const generateActionErrorBoundary = futureApi("generateReactActionErrorBoundaryQuintFromAnalysis");
    const generateReactTransition = futureApi("generateReactTransitionQuint");
    const generateTransitionSuspense = futureApi("generateReactTransitionSuspenseQuintFromAnalysis");
    const generateSuspenseFallback = futureApi("generateReactSuspenseFallbackQuintFromAnalysis");
    const generateSuspenseBoundary = futureApi("generateReactSuspenseBoundaryQuint");
    const generateExtractedSuspenseBoundary = futureApi("generateReactSuspenseBoundaryQuintFromAnalysis");
    const generateNestedSuspense = futureApi("generateReactNestedSuspenseQuintFromAnalysis");
    const generateSuspenseTree = futureApi("generateReactSuspenseTreeQuintFromAnalysis");
    const analyzeReactProgram = futureApi("analyzeReactProgram");
    const generateSuspenseTreeFromProgram = futureApi("generateReactSuspenseTreeQuintFromProgram");
    const result = analyzeReact("src/feed.tsx", `
      import { memo, startTransition, useActionState, useEffect, useEffectEvent, useImperativeHandle, useInsertionEffect, useOptimistic, useRef, useState, useSyncExternalStore, useTransition } from "react"
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void; ref?: unknown }; form: { action?: unknown; children?: unknown } } }
      /* uneffect: react acquire Subscription */
      declare function subscribe(): void
      /* uneffect: react release Subscription */
      declare function unsubscribe(): void
      /* uneffect: effect StyleWrite */
      declare function insertFeedStyles(): void
      /* uneffect: effect StyleWrite */
      declare function removeFeedStyles(): void
      interface TopicStatusSubscription { readonly topic: string }
      /* uneffect: react acquire TopicStatusSubscription result */
      declare function openTopicStatus(notify: () => void): TopicStatusSubscription
      /* uneffect: react release TopicStatusSubscription parameter 0 */
      declare function closeTopicStatus(subscription: TopicStatusSubscription): void
      /* uneffect: effect TopicStatusRead */
      declare function readTopicStatus(): boolean
      /* uneffect: effect HandlePrepare */
      declare function prepareFeedHandle(): void
      /* uneffect: effect TopicSave */
      declare function saveTopic(topic: string): Promise<void>
      function subscribeTopicStatus(notify: () => void) {
        const subscription = openTopicStatus(notify)
        return () => closeTopicStatus(subscription)
      }
      function getTopicStatusSnapshot() { return readTopicStatus() }
      /* uneffect: react hook */
      function useTopicStatus() {
        return useSyncExternalStore(subscribeTopicStatus, getTopicStatusSnapshot)
      }
      /* uneffect: react hook */
      function useSubscription(topic: string) {
        const reportConnected = useEffectEvent(() => console.log(topic))
        useEffect(() => {
          reportConnected()
          subscribe()
          return () => unsubscribe()
        }, [topic])
      }
      function FeedView({ topic, ref }: { topic: string; ref: unknown }) {
        const renderCache = useRef<{ topic: string } | null>(null)
        const cacheAlias = renderCache
        if (cacheAlias.current === null) {
          cacheAlias.current = { topic }
        }
        const [savedTopic, saveTopicAction] = useActionState(async (previous: string) => {
          await saveTopic(topic)
          return previous === topic ? previous : topic
        }, topic)
        const [optimisticTopic] = useOptimistic(savedTopic, (_previous, next: string) => next)
        const [, setRefreshTopic] = useState(topic)
        const [, beginRefresh] = useTransition()
        useTopicStatus()
        useSubscription(topic)
        useImperativeHandle(ref, () => {
          prepareFeedHandle()
          return { refresh() { fetch(\`/topics/\${topic}/refresh\`) } }
        }, [topic])
        useInsertionEffect(() => {
          insertFeedStyles()
          return () => removeFeedStyles()
        }, [])
        const refresh = () => fetch(\`/topics/\${topic}\`)
        const attachButton = (node: Element | null) => {
          console.log(node)
          return () => console.log("detach")
        }
        const buttonRef = attachButton
        const handleClick = () => beginRefresh(async () => {
          await Promise.resolve()
          startTransition(() => { setRefreshTopic(topic); refresh() })
        })
        return <form action={saveTopicAction}><button
          ref={buttonRef}
          onClick={handleClick}
        />{optimisticTopic}</form>
      }
      /* uneffect: react component */
      export const Feed = memo(FeedView)
      function Legacy() { console.log("not opted in"); return null }
    `) as { diagnostics: unknown[]; components: Array<{ name: string; phases: Array<{ phase: string; effects: string[] }> }> };
    expect(result.diagnostics).toEqual([]);
    expect(result.components.map((component) => component.name)).toEqual(["Feed"]);
    expect(result.components[0]!.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "render", effects: [] }),
      expect.objectContaining({ phase: "memo-compare", effects: [] }),
      expect.objectContaining({ phase: "action", effects: ["TopicSave"] }),
      expect.objectContaining({ phase: "optimistic-reducer", effects: [] }),
      expect.objectContaining({ phase: "event", effects: ["Fetch"] }),
      expect.objectContaining({ phase: "ref-callback", effects: ["Console"] }),
      expect.objectContaining({ phase: "insertion-effect", effects: ["StyleWrite"] }),
      expect.objectContaining({ phase: "external-store-snapshot", effects: ["TopicStatusRead"] }),
      expect.objectContaining({ phase: "external-store-subscribe", effects: ["Acquire<TopicStatusSubscription>"] }),
      expect.objectContaining({ phase: "imperative-handle", effects: ["HandlePrepare"] }),
      expect.objectContaining({ phase: "imperative-handle-method", effects: ["Fetch"] }),
      expect.objectContaining({ phase: "passive-effect" }),
      expect.objectContaining({ phase: "cleanup" }),
    ]));
    const actionQueueQuint = generateReactActionQueue("feed_actions", { maxQueuedActions: 3 }) as string;
    expect(actionQueueQuint).toContain("val reactActionQueueSafe");
    expect(actionQueueQuint).toContain("cancelled == 1 implies active == 0 and pending == 0");
    const failingAction = analyzeReact("src/checkout.tsx", `
      import { useActionState } from "react"
      /* uneffect: react component */
      function Checkout() {
        const [, submit] = useActionState(async (previous: number, quantity: number) => {
          if (!Number.isFinite(quantity)) throw new Error("invalid quantity")
          return previous + quantity
        }, 0)
        return <form action={submit} />
      }
      /* uneffect: react component */ function CheckoutError() { return <p>Action failed</p> }
    `) as typeof result;
    expect(failingAction.components.find(({ name }) => name === "Checkout")!.phases).toContainEqual({
      phase: "action", effects: ["Throw<Error>"],
    });
    const actionErrorQuint = generateActionErrorBoundary("checkout_error", failingAction, "Checkout", "CheckoutError", {
      maxQueuedActions: 3,
    }) as string;
    expect(actionErrorQuint).toContain("action fail_action_and_cancel_tail");
    expect(actionErrorQuint).toContain("action rethrow_from_use_action_state");
    expect(actionErrorQuint).toContain("action commit_error_fallback");
    expect(actionErrorQuint).toContain("failure_stage >= 1 implies pending == 0 and cancelled == queued - settled - 1");
    const transitionQuint = generateReactTransition("feed_transition", { maxActions: 3 }) as string;
    expect(transitionQuint).toContain("val reactTransitionSafe");
    expect(transitionQuint).toContain("action interrupt_render");
    const lifecycleQuint = generateReactLifecycle("feed_lifecycle", result.components[0]) as string;
    expect(lifecycleQuint).toContain("val reactLifecycleSafe");
    expect(lifecycleQuint).toContain("action cleanup_0_strict_replay");
    const interruptedQuint = generateReactLifecycle("feed_interrupted", result.components[0], "concurrentInterruption") as string;
    expect(interruptedQuint).toContain("action discard_render_0");
    expect(interruptedQuint).toContain("setup_0 >= 1 implies commit_generation_0 == 1");
    const dependencyQuint = generateReactLifecycle("feed_dependency", result.components[0], "dependencyChange") as string;
    expect(dependencyQuint).toContain("setup_0 >= 2 implies commit_generation_1 == 1");
    const suspenseQuint = generateReactLifecycle("feed_suspense", result.components[0], "suspenseRetry") as string;
    expect(suspenseQuint).toContain("action resolve_suspension_0");
    expect(suspenseQuint).toContain("commit_generation_0 == 1 implies resolved_suspension_0 == 1");
    const repeatedSuspenseQuint = generateReactLifecycle("feed_repeated_suspense", result.components[0], "repeatedSuspenseRetry") as string;
    expect(repeatedSuspenseQuint).toContain("suspension_1 == 1 implies resolved_suspension_0 == 1");
    expect(repeatedSuspenseQuint).toContain("commit_generation_0 == 1 implies resolved_suspension_1 == 1");
    const fallback = analyzeReact("src/feed-spinner.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function FeedSpinner() { useEffect(() => { console.log("show"); return () => console.log("hide") }, []); return null }
    `) as typeof result;
    const boundaryQuint = generateSuspenseBoundary("feed_boundary", result.components[0], fallback.components[0]) as string;
    expect(boundaryQuint).toContain("action commit_fallback");
    expect(boundaryQuint).toMatch(/primary_setup_\d+ == 1 implies fallback_cleanup_0 == 1/u);
    const extracted = analyzeReact("src/extracted-boundary.tsx", `
      import { Suspense, useEffect } from "react"
      /* uneffect: react component */ function Primary() { useEffect(() => () => console.log("hide"), []); return null }
      /* uneffect: react component */ function Fallback() { useEffect(() => () => console.log("hide"), []); return null }
      function App() { return <Suspense fallback={<Fallback />}><Primary /></Suspense> }
    `) as typeof result;
    const extractedBoundaryQuint = generateExtractedSuspenseBoundary("extracted_boundary", extracted) as string;
    expect(extractedBoundaryQuint).toContain("component: Primary");
    expect(extractedBoundaryQuint).toContain("component: Fallback");
    const transitionSuspenseQuint = generateTransitionSuspense("feed_transition_visibility", extracted) as string;
    expect(transitionSuspenseQuint).toContain("val reactTransitionSuspenseSafe");
    expect(transitionSuspenseQuint).toContain("pending == 1 implies content_visible == 1 and fallback_visible == 0");
    const mountedFallbackQuint = generateSuspenseFallback("feed_new_boundary", extracted, {
      scenario: "newlyMountedTransition",
    }) as string;
    expect(mountedFallbackQuint).toContain("scenario: newlyMountedTransition");
    expect(mountedFallbackQuint).toContain("action commit_fallback_after_suspension");
    expect(mountedFallbackQuint).toContain("fallback_visible == 1 implies suspended == 1 and committed == 0");
    const urgentFallbackQuint = generateSuspenseFallback("feed_urgent_boundary", extracted, {
      scenario: "urgentUpdate",
    }) as string;
    expect(urgentFallbackQuint).toContain("scenario: urgentUpdate");
    expect(urgentFallbackQuint).toContain("initial content: visible");
    const nested = analyzeReact("src/nested-boundary.tsx", `
      import { Suspense } from "react"
      /* uneffect: react component */ function Primary() { return null }
      /* uneffect: react component */ function InnerFallback() { return null }
      /* uneffect: react component */ function OuterFallback() { return null }
      function App() {
        return <Suspense fallback={<OuterFallback />}>
          <Suspense fallback={<InnerFallback />}><Primary /></Suspense>
        </Suspense>
      }
    `) as typeof result & { suspenseBoundaries: Array<{ parentBoundary?: string; primaryBoundary?: string }> };
    expect(nested.suspenseBoundaries).toHaveLength(2);
    const nestedQuint = generateNestedSuspense("nested_boundary", nested) as string;
    expect(nestedQuint).toContain("action commit_fallback_1");
    expect(nestedQuint).not.toContain("action commit_fallback_0");
    expect(nestedQuint).toContain("fallback_committed_0 == 0");
    const tree = analyzeReact("src/suspense-tree.tsx", `
      import { Suspense } from "react"
      /* uneffect: react component */ function A() { return null }
      /* uneffect: react component */ function B() { return null }
      /* uneffect: react component */ function Fallback() { return null }
      function App() { return <Suspense fallback={<Fallback />}><><A /><B /></></Suspense> }
    `) as typeof result;
    const treeQuint = generateSuspenseTree("fragment_tree", tree) as string;
    expect(treeQuint).toContain("leaf 0: A; owner boundary 0");
    expect(treeQuint).toContain("leaf 1: B; owner boundary 0");
    expect(treeQuint).toContain("val suspenseTreeSafe");
    const causalFile = "causal-suspense.tsx";
    const causalSource = `
      import { Suspense, use } from "react"
      const data = Promise.resolve("ready")
      const legacy = Promise.resolve("legacy")
      /* uneffect: react component */ function Data() { return <p>{use(data)}</p> }
      /* uneffect: react component */ function LegacyData() { throw legacy }
      /* uneffect: react component */ function Broken() { throw new Error("broken") }
      /* uneffect: react component */ function Static() { return <nav>Static</nav> }
      /* uneffect: react component */ function Fallback() { return <p>Loading</p> }
      function App() { return <Suspense fallback={<Fallback />}><><Static /><Broken /><Data /><LegacyData /></></Suspense> }
    `;
    const causalOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.Preserve, noEmit: true };
    const causalHost = ts.createCompilerHost(causalOptions);
    const originalGetSourceFile = causalHost.getSourceFile.bind(causalHost);
    causalHost.getSourceFile = (fileName, languageVersion, onError, fresh) => fileName === causalFile
      ? ts.createSourceFile(fileName, causalSource, languageVersion, true, ts.ScriptKind.TSX)
      : originalGetSourceFile(fileName, languageVersion, onError, fresh);
    const causalProgram = ts.createProgram([causalFile], causalOptions, causalHost);
    const causalResults = analyzeReactProgram(causalProgram) as ReadonlyMap<string, unknown>;
    const causalQuint = generateSuspenseTreeFromProgram("causal_tree", causalResults, causalFile, 0, {
      requireKnownSuspension: true,
    }) as string;
    expect(causalQuint).toContain("leaf 0: Data; owner boundary 0; cause react-use(data)");
    expect(causalQuint).toContain("leaf 1: LegacyData; owner boundary 0; cause throw-thenable(legacy)");
    expect(causalQuint).not.toContain("Static; owner boundary");
    expect(causalQuint).not.toContain("Broken; owner boundary");

    const broken = analyzeReact("src/feed.tsx", `
      import { useContext, useEffect, useRef, useState } from "react"
      declare const ThemeContext: object
      /* uneffect: react acquire Subscription */
      declare function subscribe(): void
      /* uneffect: react component */
      export function Feed({ topic, config }: { topic: string; config: { enabled: boolean } }) {
        const configAlias = config
        const [snapshot] = useState({ count: 0 })
        const theme = useContext(ThemeContext) as { mode: string }
        const host = useRef<Element | null>(null)
        configAlias.enabled = false
        snapshot.count++
        theme.mode = "dark"
        host.current = null
        topic = String(Date.now())
        useEffect(() => { subscribe() }, [])
        return null
      }
    `) as { diagnostics: Array<{ kind: string }> };
    expect(broken.diagnostics.map((diagnostic) => diagnostic.kind).sort()).toEqual([
      "immutable-input-mutation", "immutable-input-mutation", "immutable-input-mutation",
      "missing-effect-cleanup", "non-idempotent-render", "render-ref-access",
    ]);
  });

  it("keeps Promise rejection ownership through a loop-local catch and continue join", () => {
    const analyzeAsyncSafety = futureApi("analyzeAsyncSafety");
    const result = analyzeAsyncSafety("src/retry.ts", `
      declare const retry: boolean
      declare const mode: "primary" | "backup"
      declare function task(): Promise<number>
      declare function recordAttempt(value: number): void
      export async function observedAfterRetry() {
        let pending = task()
        while (retry) {
          try {
            const attempt = 1
            void attempt
            try {
              switch (mode) {
                case "primary":
                case "backup":
                  {
                    const value = await pending
                    recordAttempt(value)
                  }
                  break
              }
            } finally {
              void attempt
            }
            break
          } catch {
            pending = task()
            continue
          }
        }
        await pending
      }
      export async function lostAfterRetry() {
        let pending = task()
        while (retry) {
          try {
            await pending
            break
          } catch {
            pending = task()
            break
          }
        }
      }
    `) as { diagnostics: Array<{ functionName: string; kind: string }> };
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "observedAfterRetry",
      kind: "floating-promise",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "lostAfterRetry",
      kind: "floating-promise",
    }));
  });

  it("checks scoped builtin and user-defined capability sets transitively and warns about unused upper bounds", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({
      files: files({
        "src/app.ts": `
          import { readFile } from "node:fs/promises"
          /* uneffect: effect_schema Audit<ResourceSet> */
          /* uneffect: effect FsRead<\"$WORKSPACE_ROOT/config/**\"> | Fetch<Fetch.GET, \"https://api.example.com/v1/**\"> | Net<\"api.example.com:443\"> | Audit<\"users\"> | Console */
          export async function load() {
            await fetch("https://api.example.com/v1/users")
            return readFile("$WORKSPACE_ROOT/config/app.json")
          }
        `,
      }),
      mode: "strict",
    }) as { diagnostics: Array<{ code: string; effect?: string }> };
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unused-effect", effect: "Console" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "missing-effect" }));
  });

  it("runs a user validator and specializes passing functions with an at-most-once sink summary", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const analyzeProject = futureApi("analyzeUneffectProject");
    const datadogOnce = defineValidator({
      name: "DatadogOnce",
      rule: "at-most-once",
      sink: { module: "@datadog/browser-rum", export: "datadogRum.addAction" },
      specialization: { kind: "call-cardinality", maximum: 1 },
    });
    const result = await analyzeProject({ validators: [datadogOnce], files: files({
      "src/report.ts": `
        import { datadogRum } from "@datadog/browser-rum"
        /* uneffect: validate DatadogOnce */
        export function report(enabled: boolean) {
          if (enabled) datadogRum.addAction("loaded")
        }
      `,
    }) }) as { diagnostics: unknown[]; summaries: Array<{ functionName: string; specializations: Array<{ validator: string; maximum: number; evidence: string }> }> };
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries).toContainEqual(expect.objectContaining({
      functionName: "report",
      specializations: [expect.objectContaining({ validator: "DatadogOnce", maximum: 1, evidence: "verified" })],
    }));
  });

  it("composes validator cardinality through aliases, barrels, namespace imports, default exports, and methods", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", version: "2026-08", rule: "at-most-once", sink: { module: "./metrics.js", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, files: files({
      "src/metrics.ts": `export declare function sendMetric(): void`,
      "src/reporters.ts": `
        import { sendMetric as emit } from "./metrics.js"
        export function helper() { emit() }
        export default function defaultReporter() { emit() }
        export class Reporter { report() { emit() } }
      `,
      "src/barrel.ts": `export { helper as forwarded, default as defaultReporter, Reporter } from "./reporters.js"`,
      "src/main.ts": `
        import { forwarded as renamed, defaultReporter, Reporter } from "./barrel.js"
        import * as reports from "./barrel.js"
        import { opaque } from "./missing.js"
        /* uneffect: validate DatadogOnce */
        export function viaAlias() { renamed() }
        /* uneffect: validate DatadogOnce */
        export function viaNamespace() { reports.forwarded() }
        /* uneffect: validate DatadogOnce */
        export function viaDefault() { defaultReporter() }
        /* uneffect: validate DatadogOnce */
        export function viaMethod() { new Reporter().report() }
        /* uneffect: validate DatadogOnce */
        export function twice() { renamed(); new Reporter().report() }
        /* uneffect: validate DatadogOnce */
        export function unresolved() { opaque() }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string; inferredMaximum: string }>; summaries: Array<{ functionName: string; specializations: Array<{ evidence: string; inferredMaximum: string }> }> };
    for (const functionName of ["viaAlias", "viaNamespace", "viaDefault", "viaMethod"]) {
      expect(result.summaries).toContainEqual(expect.objectContaining({ functionName, specializations: [expect.objectContaining({ schema: "uneffect-cardinality/v1", evidence: "verified", inferredMaximum: "1", validatorVersion: "2026-08", validatorDigest: expect.stringMatching(/^[0-9a-f]{64}$/), compilerRevision: expect.any(String), sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/), projectHash: expect.stringMatching(/^[0-9a-f]{64}$/) })] }));
    }
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", functionName: "twice", inferredMaximum: "many" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-unknown", functionName: "unresolved", inferredMaximum: "unknown" }));
    expect(result.summaries.find((summary) => summary.functionName === "unresolved")?.specializations).toEqual([]);
  });

  it("rejects sequential, repeated, concurrent, recursive, or unknown callback paths that may call a sink more than once", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", rule: "at-most-once", sink: { module: "./metrics", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, files: files({
      "src/metrics.ts": `export declare function sendMetric(): Promise<void>`,
      "src/duplicates.ts": `
        import { sendMetric } from "./metrics"
        /* uneffect: validate DatadogOnce */
        function sequential() { sendMetric(); sendMetric() }
        /* uneffect: validate DatadogOnce */
        function repeated(items: string[]) { for (const item of items) sendMetric() }
        /* uneffect: validate DatadogOnce */
        async function concurrent() { await Promise.all([sendMetric(), sendMetric()]) }
        /* uneffect: validate DatadogOnce */
        function recursive() { sendMetric(); if (retry()) recursive() }
        /* uneffect: validate DatadogOnce */
        function callback(run: (job: () => void) => void) { run(() => sendMetric()) }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string; inferredMaximum: string }> };
    for (const functionName of ["sequential", "repeated", "concurrent"]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", functionName }));
    }
    for (const functionName of ["recursive", "callback"]) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-unknown", functionName }));
  });

  it("composes call cardinality through Generator yield, yield-star, AsyncGenerator, and a single main consumption", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", rule: "at-most-once", sink: { module: "./metrics", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, entrypoint: "main", files: files({
      "src/metrics.ts": `export declare function sendMetric(): unknown`,
      "src/main.ts": `
        import { sendMetric } from "./metrics"
        declare function loadWithoutMetrics(): Promise<void>
        function* optional(enabled: boolean) {
          if (enabled) yield sendMetric()
        }
        /* uneffect: validate DatadogOnce */
        function constructOnly() { optional(true) }
        async function* pipeline(enabled: boolean) {
          yield* optional(enabled)
          yield await loadWithoutMetrics()
        }
        /* uneffect: validate DatadogOnce */
        async function main(enabled: boolean) {
          for await (const _effect of pipeline(enabled)) {}
        }
      `,
    }) }) as { diagnostics: unknown[]; summaries: Array<{ functionName: string; specializations: Array<{ inferredMaximum: string }> }>; entrypoint: { functionName: string; sinkMaximum: number; generatorConsumption: string } };
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "constructOnly", specializations: [expect.objectContaining({ inferredMaximum: "0" })] }));
    expect(result.entrypoint).toEqual({ functionName: "main", sinkMaximum: 1, generatorConsumption: "once" });

    const duplicated = await validateProject({ validator, entrypoint: "main", files: files({
      "src/metrics.ts": `export declare function sendMetric(): unknown`,
      "src/main.ts": `
        import { sendMetric } from "./metrics"
        function* pipeline() { yield sendMetric() }
        /* uneffect: validate DatadogOnce */
        async function main() {
          for (const _effect of pipeline()) {}
          for (const _effect of pipeline()) {}
        }
      `,
    }) }) as { diagnostics: Array<{ code: string; inferredMaximum: string }> };
    expect(duplicated.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", inferredMaximum: "many" }));
  });

  it("tracks typed synchronous throws and Promise rejection ownership through explicit discharge boundaries", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ files: files({
      "src/errors.ts": `
        class ParseError extends Error {}
        /* uneffect: effect Throw<Error> */
        function fail(): never { throw new Error("route") }
        /* uneffect: effect Throw<ParseError> */
        function parse(input: string) { if (!input) throw new ParseError(); return input }
        function syncHandled() { try { parse("") } catch (error) {} }
        async function asyncHandled() { try { await Promise.reject(new ParseError()) } catch (error) {} }
        async function floating() { Promise.reject(new ParseError()) }
        async function aggregateHandled(values: string[]) {
          return Promise.all(values.map(async (value) => Promise.resolve(value)))
        }
        function detachedMap(values: string[]) {
          values.map(async (value) => Promise.resolve(value))
        }
        async function caughtBinding() {
          const pending = Promise.reject(new ParseError())
          try { throw new Error("route") } catch { await pending }
        }
        async function conditionalBinding(flag: boolean) {
          const pending = Promise.reject(new ParseError())
          try { if (flag) throw new Error("route") } catch { await pending }
        }
        async function caughtNeverCall() {
          let pending: Promise<never>
          try { pending = Promise.reject(new ParseError()); return undefined ?? fail() }
          catch { await pending }
        }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string }>; summaries: Array<{ functionName: string; effects: string[] }> };
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "parse", effects: ["Throw<ParseError>"] }));
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "syncHandled", effects: [] }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "syncHandled" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "asyncHandled" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "aggregateHandled" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "caughtBinding" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "caughtNeverCall" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "floating-promise", functionName: "floating" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "floating-callback-promise", functionName: "detachedMap" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "floating-promise", functionName: "conditionalBinding" }));
  });

  it("verifies Hoare contracts with Z3 and emits explicit Valibot assertions in the same optional runtime build", async () => {
    const verifyProject = futureApi("verifyUneffectProject");
    const result = await verifyProject({ files: files({
      "src/numeric.ts": `
        import type { Nat } from "@mizchi/uneffect"
        /* uneffect: requires value >= 0 */
        /* uneffect: ensures result > value */
        /* uneffect: assert value: Nat */
        export function increment(value: Nat) { return value + 1 }
      `,
    }), runtimeAssertions: "fallback" }) as { obligations: Array<{ backend: string; result: string }>; emittedFiles: Record<string, string> };
    expect(result.obligations).toContainEqual(expect.objectContaining({ backend: "z3", result: "verified" }));
    expect(result.emittedFiles["src/numeric.js"]).toContain("valibot");
  });

  it("composes temporal function contracts with the Web event loop instead of passing inline Quint through", async () => {
    const verifyProject = futureApi("verifyUneffectProject");
    const result = await verifyProject({ files: files({
      "src/scheduler.ts": `
        /* uneffect: state phase: int */
        /* uneffect: init phase = 0 */
        /* uneffect: temporal committedOnce: phase <= 1 */
        /* uneffect: temporal_requires phase === 0 */
        /* uneffect: temporal_ensures phase' = phase + 1 */
        /* uneffect: temporal_modifies phase */
        function commit() {}
        function main() { queueMicrotask(commit) }
      `,
    }), temporalRuntime: "web" }) as { temporal: { sourceLanguage: string; backend: string; models: Array<{ kind: string; quint: string }>; properties: Array<{ name: string; result: string }> } };
    expect(result.temporal.sourceLanguage).toBe("uneffect-ts");
    expect(result.temporal.backend).toBe("quint");
    expect(result.temporal.models).toContainEqual(expect.objectContaining({ kind: "web-event-loop", quint: expect.stringContaining("eventLoopSafe") }));
    expect(result.temporal.models[0]?.quint).toContain("phase' = phase + 1");
    expect(result.temporal.properties).toContainEqual(expect.objectContaining({ name: "eventLoopSafe", result: "verified" }));
    expect(result.temporal.properties).toContainEqual(expect.objectContaining({ name: "committedOnce", result: "verified" }));

    const broken = await verifyProject({ files: files({
      "src/scheduler.ts": `
        /* uneffect: state phase: int */
        /* uneffect: init phase = 0 */
        /* uneffect: temporal_requires phase === 0 */
        /* uneffect: temporal_ensures phase' = phase + 1 */
        /* uneffect: temporal_modifies phase */
        function commit() {}
        function main() { queueMicrotask(commit); queueMicrotask(commit) }
      `,
    }), temporalRuntime: "web" }) as { temporal: { properties: Array<{ name: string; result: string }> } };
    expect(broken.temporal.properties).toContainEqual(expect.objectContaining({ name: "eventLoopSafe", result: "counterexample" }));
  }, 30_000);

  it("models using cleanup, Transferable ownership, and async exits in one ordered neutral IR", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ files: files({
      "src/worker.ts": `
        async function send(worker: Worker, buffer: ArrayBuffer, open: () => Promise<AsyncDisposable>) {
          await using resource = await open()
          worker.postMessage(buffer, [buffer])
          await Promise.resolve()
        }
      `,
    }) }) as { orderedEvents: Array<{ kind: string; resource?: string }> };
    expect(result.orderedEvents.map((event) => event.kind)).toEqual(["suspend", "acquire", "transfer", "suspend", "dispose"]);
    expect(result.orderedEvents).toContainEqual(expect.objectContaining({ kind: "transfer", resource: "buffer" }));
  });

  it("discharges a loop-local resource alias only when finally clears every exit", () => {
    const analyzeAsync = futureApi("analyzeAsyncSafety");
    const source = `
      interface Session { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Session>
      declare function use(session: Session): Promise<void>
      async function deliver(enabled: boolean, fail: boolean) {
        let active: Session | undefined
        while (enabled) {
          await using session = await open()
          active = session
          try {
            await use(session)
            if (fail) throw new Error("delivery failed")
          } finally {
            active = undefined
          }
        }
        active?.send()
      }
    `;
    const verified = analyzeAsync("finally-cleared-resource.ts", source) as {
      diagnostics: Array<{ functionName: string; kind: string }>;
    };
    expect(verified.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "deliver", kind: "disposed-resource-use",
    }));

    const conditionalClear = analyzeAsync("conditionally-cleared-resource.ts", source.replace(
      "active = undefined",
      "if (!fail) active = undefined",
    )) as typeof verified;
    expect(conditionalClear.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliver", kind: "disposed-resource-use",
    }));
  });

  it("keeps target-aware completion edges when Promise and resource flow leaves a handler", () => {
    const analyzeAsync = futureApi("analyzeAsyncSafety");
    const generateUnified = futureApi("generateUnifiedAsyncQuint");
    const source = `
      interface Session { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Session>
      declare function deliver(session: Session): Promise<void>
      async function run(retry: boolean) {
        attempts: for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await using session = await open()
            await deliver(session)
          } finally {
          if (retry) continue missing
          }
        }
      }
    `;
    const result = analyzeAsync("target-aware-completion.ts", source) as {
      controlStatements: Array<{
        completionPaths: Array<{
          completion: string;
          target?: { kind: string; label?: string };
        }>;
      }>;
      diagnostics: Array<{ functionName: string; kind: string }>;
    };
    expect(result.controlStatements[0]?.completionPaths).toContainEqual(expect.objectContaining({
      completion: "continue",
      target: { kind: "label", label: "missing" },
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "run",
      kind: "unsupported-control-transfer",
    }));
    expect(() => generateUnified("target_aware_completion", result, "run")).toThrow(
      /continue missing leaves the modeled handler CFG/,
    );

    const ownedSource = `
      async function run(retry: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("retry") })
        } finally {
          while (retry) {
            await Promise.resolve("tick").then(value => value)
            continue
          }
        }
      }
    `;
    const owned = analyzeAsync("owned-handler-completion.ts", ownedSource) as typeof result;
    expect(owned.controlStatements[0]?.completionPaths).not.toContainEqual(expect.objectContaining({
      completion: "continue",
    }));
    expect(owned.diagnostics).not.toContainEqual(expect.objectContaining({
      kind: "unsupported-control-transfer",
    }));
    expect(() => generateUnified("owned_handler_completion", owned, "run")).not.toThrow();
  });

  it("lowers cleanup before a statically owned outer retry continue", () => {
    const analyzeAsync = futureApi("analyzeAsyncSafety");
    const generateUnified = futureApi("generateUnifiedAsyncQuint");
    const fileName = "examples/dogfood/target-aware-retry-cleanup.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsync(fileName, source) as {
      diagnostics: Array<{ kind: string }>;
    };
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      kind: "unsupported-control-transfer",
    }));
    const quint = generateUnified("target_aware_retry_cleanup", result, "deliverWithRetry") as string;
    expect(quint).toContain("action dispose_start_session_continue_attempts");
    expect(quint).toContain("action continue_attempts_repeat");
    expect(quint).toContain("action continue_attempts_exit");
    expect(quint.indexOf("action dispose_start_session_continue_attempts"))
      .toBeLessThan(quint.indexOf("action continue_attempts_repeat"));
  });

  it("lowers cleanup before a statically owned outer break and post-loop await", () => {
    const analyzeAsync = futureApi("analyzeAsyncSafety");
    const generateUnified = futureApi("generateUnifiedAsyncQuint");
    const fileName = "examples/dogfood/target-aware-break-cleanup.ts";
    const result = analyzeAsync(fileName, readFileSync(fileName, "utf8")) as {
      diagnostics: Array<{ kind: string }>;
    };
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      kind: "unsupported-control-transfer",
    }));
    const quint = generateUnified("target_aware_break_cleanup", result, "deliverUntilStop") as string;
    expect(quint).toContain("action dispose_start_session_break_attempts");
    expect(quint).toContain("action break_attempts_exit");
    expect(quint).toContain("action continue_attempts_repeat");
    expect(quint.indexOf("action dispose_start_session_break_attempts"))
      .toBeLessThan(quint.indexOf("action break_attempts_exit"));
    expect(quint.indexOf("action break_attempts_exit"))
      .toBeLessThan(quint.indexOf("action promise_1_fulfill"));
  });

  it("preserves a caught rejection through finally and reverse mixed disposal", () => {
    const analyzeAsync = futureApi("analyzeAsyncSafety");
    const generateUnified = futureApi("generateUnifiedAsyncQuint");
    const fileName = "examples/dogfood/rejected-await-multiple-disposal.ts";
    const result = analyzeAsync(fileName, readFileSync(fileName, "utf8")) as {
      promises: Array<{ observation: string; catchesRejection: boolean }>;
      disposals: Array<{ binding: string; asynchronous: boolean }>;
      diagnostics: Array<{ kind: string }>;
    };
    expect(result.promises).toContainEqual(expect.objectContaining({
      observation: "await",
      catchesRejection: true,
    }));
    expect(result.disposals.map(({ binding, asynchronous }) => ({ binding, asynchronous }))).toEqual([
      { binding: "session", asynchronous: true },
      { binding: "audit", asynchronous: false },
    ]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ kind: "floating-promise" }));

    const quint = generateUnified("rejected_await_multiple_disposal", result, "deliverWithRecovery") as string;
    expect(quint).toContain("action promise_0_reject_caught");
    expect(quint).toContain("action catch_statement_0");
    expect(quint).toContain("action finally_statement_0");
    expect(quint).toContain("action dispose_start_session");
    expect(quint).toContain("action dispose_audit");
    expect(quint).toContain("val cleanupOrderSafe");
    expect(quint.indexOf("action dispose_start_session")).toBeLessThan(quint.indexOf("action dispose_audit"));
    expect(generateUnified("rejected_await_multiple_disposal_reordered", result, "deliverWithRecovery", {
      reorderCleanup: true,
    })).toContain("cleanupOrderSafe");
  });

  it("allows compression or mangling only when persisted proof dependencies still match", async () => {
    const optimizeProject = futureApi("optimizeUneffectProject");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-acceptance-evidence-"));
    try {
      const options = {
        files: files({ "src/value.ts": `export function read() { const value = { stable: 1 }; return value.stable + value.stable }` }),
        evidencePath: join(directory, "evidence.json"),
        closedWorld: true,
      };
      await optimizeProject(options);
      const result = await optimizeProject(options) as { transformations: Array<{ kind: string; applied: boolean; evidence: string }>; staleEvidence: unknown[] };
      expect(result.transformations).toContainEqual(expect.objectContaining({ applied: true, evidence: "verified" }));
      expect(result.staleEvidence).toEqual([]);
      const changed = await optimizeProject({ ...options, files: files({
        "src/value.ts": `export function read(value: { stable: number }) { value.stable++; return value.stable + value.stable }`,
      }) }) as { transformations: Array<{ applied: boolean }>; staleEvidence: unknown[] };
      expect(changed.transformations).not.toContainEqual(expect.objectContaining({ applied: true }));
      expect(changed.staleEvidence.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("produces equivalent neutral IR from the TypeScript and Corsa frontends", async () => {
    const compareFrontends = futureApi("compareUneffectFrontends");
    const result = await compareFrontends({ files: files({
      "src/parity.ts": `/* uneffect: effect Console | Mutate<typeof value> */ export function update(value: { n: number }) { value.n++; console.log(value.n) }`,
    }) }) as { equivalent: boolean; schemaDrift: unknown[]; typescriptIr: unknown; corsaIr: unknown };
    expect(result.schemaDrift).toEqual([]);
    expect(result.typescriptIr).toEqual(result.corsaIr);
    expect(result.equivalent).toBe(true);
  }, 60_000);

  it("proves bounded Uint8Array allocation and rejects implicit u8 coercion", async () => {
    const verifyTypedArrays = futureApi("verifyTypedArraySafety");
    const result = await verifyTypedArrays("bytes.ts", `
      import type { BoundedUint8Array, Nat, U8 } from "@mizchi/uneffect"
      /* uneffect: requires size >= 0 && size <= 1024 */
      function allocate(size: Nat): BoundedUint8Array<1024> { return new Uint8Array(size) }
      /* uneffect: requires value >= 0 && value <= 255 */
      function write(bytes: BoundedUint8Array<1024>, index: Nat, value: U8) { bytes[index] = value }
      function truncates(bytes: Uint8Array, value: number) { bytes[0] = value }
      function unbounded(size: number): BoundedUint8Array<1024> { return new Uint8Array(size) }
    `) as { obligations: Array<{ functionName: string; kind: string; result: string }>; diagnostics: Array<{ functionName: string; kind: string }> };
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "allocate", kind: "max-length", result: "verified" }));
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "write", kind: "u8-write", result: "verified" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "truncates", kind: "u8-write" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "unbounded", kind: "max-length" }));
  });

  it("refines switch entry, fallthrough, break, and default as a symbolic temporal update", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state value: int
      state mode: int
      init value = 0
      init mode = 0
      action route: value' = mode === 0 ? value + 1 : mode === 1 ? value + 2 + 4 : value + 4
    */
      interface Runtime { value: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        switch (runtime.mode) {
          case 0: runtime.value += 1; break
          case 1: runtime.value += 2
          default: runtime.value += 4; break
        }
      }
    `;
    const temporal = (parseSpec("switch-routing.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("switch-routing.ts", source, "routing", temporal)).toEqual([]);

    const dynamic = source.replace("case 1:", "case chooseMode():");
    expect(validateActions("dynamic-switch-routing.ts", dynamic, "routing", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("composes switch return and throw paths through catch, finally, and normal continuation", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state routed: int
      state failed: int
      state settled: int
      state observed: int
      state mode: int
      init routed = 0
      init failed = 0
      init settled = 0
      init observed = 0
      init mode = 0
      action route: routed' = mode === 0 ? routed + 1 : mode === 1 ? routed + 2 : routed + 3, failed' = mode === 1 ? failed + 1 : failed, settled' = settled + 1, observed' = mode === 0 ? observed : observed + 1
    */
      interface Runtime { routed: number; failed: number; settled: number; observed: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 0: runtime.routed++; return
            case 1: runtime.routed += 2; throw "failed"
            default: runtime.routed += 3; break
          }
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("switch-completion.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("switch-completion.ts", source, "routing", temporal)).toEqual([]);
  });

  it("eliminates an unreachable catch edge but rejects an unknown throwing try edge", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state outcome: int
      state attempted: int
      init outcome = 0
      init attempted = 0
      action deliver: outcome' = outcome + 1, attempted' = attempted + 1
    */
      interface Runtime { outcome: number; attempted: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action deliver */
      export function deliver(runtime: Runtime) {
        try { runtime.outcome++ }
        finally { runtime.attempted++ }
      }
    `;
    const temporal = (parseSpec("finally-accounting.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-accounting.ts", source, "accounting", temporal)).toEqual([]);
    const unreachableCatch = source.replace("finally {", "catch (error) { runtime.outcome-- } finally {");
    expect(validateActions("unreachable-catch-accounting.ts", unreachableCatch, "accounting", temporal)).toEqual([]);

    const unknownThrowEdge = unreachableCatch.replace(
      "runtime.outcome++",
      "runtime.outcome++; mayThrow()",
    );
    expect(validateActions("unknown-throw-edge.ts", unknownThrowEdge, "accounting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver" }),
    );
  });

  it("refines an explicitly thrown failure through catch and finally", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state attempted: int
      state failed: int
      state settled: int
      init attempted = 0
      init failed = 0
      init settled = 0
      action reject: attempted' = attempted + 1, failed' = failed + 1, settled' = settled + 1
    */
      interface Runtime { attempted: number; failed: number; settled: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          runtime.attempted++
          throw "delivery failed"
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("caught-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("caught-throw.ts", source, "accounting", temporal)).toEqual([]);
    const stateBackedThrow = source.replace('throw "delivery failed"', "throw runtime.attempted");
    expect(validateActions("state-backed-throw.ts", stateBackedThrow, "accounting", temporal)).toEqual([]);
    const effectfulThrow = source.replace('throw "delivery failed"', "throw makeFailure(runtime)");
    expect(validateActions("effectful-throw.ts", effectfulThrow, "accounting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    );
  });

  it("joins a conditional failure with the normal path through catch and finally", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state delivered: int
      state failed: int
      state settled: int
      state shouldFail: bool
      init delivered = 0
      init failed = 0
      init settled = 0
      init shouldFail = false
      action deliver: delivered' = shouldFail ? delivered : delivered + 1, failed' = shouldFail ? failed + 1 : failed, settled' = settled + 1
    */
      interface Runtime { delivered: number; failed: number; settled: number; shouldFail: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          if (runtime.shouldFail) throw "delivery failed"
          runtime.delivered++
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("conditional-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("conditional-throw.ts", source, "delivery", temporal)).toEqual([]);
  });

  it("uses a tracked scalar throw payload in catch control flow", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state failed: int
      state code: int
      state shouldFail: bool
      init failed = 0
      init code = 0
      init shouldFail = false
      action reject: failed' = shouldFail ? code > 0 ? failed + 1 : failed : failed
    */
      interface Runtime { failed: number; code: number; shouldFail: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try { if (runtime.shouldFail) throw runtime.code }
        catch (error) { if (error > 0) runtime.failed++ }
      }
    `;
    const temporal = (parseSpec("caught-payload.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("caught-payload.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("uses switch-selected scalar throw payloads in catch control flow", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state failed: int
      state code: int
      state fallbackCode: int
      state mode: int
      init failed = 0
      init code = 0
      init fallbackCode = 1
      init mode = 0
      action reject: failed' = (mode === 1 || mode === 2) ? (mode === 1 ? code : fallbackCode) > 0 ? failed + 1 : failed : failed
    */
      interface Runtime { failed: number; code: number; fallbackCode: number; mode: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 1: throw runtime.code
            case 2: throw runtime.fallbackCode
          }
        } catch (error) {
          if (error > 0) runtime.failed++
        }
      }
    `;
    const temporal = (parseSpec("switch-caught-payload.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("switch-caught-payload.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("uses boolean literal throw payloads in catch control flow", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state failed: int
      state shouldFail: bool
      init failed = 0
      init shouldFail = false
      action reject: failed' = shouldFail ? failed + 1 : failed
    */
      interface Runtime { failed: number; shouldFail: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          if (runtime.shouldFail) throw true
          throw false
        } catch (error) {
          if (error) runtime.failed++
        }
      }
    `;
    const temporal = (parseSpec("boolean-literal-payload.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("boolean-literal-payload.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("uses fields from a direct record throw payload in catch control flow", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state failed: int
      state code: int
      state retryable: bool
      init failed = 0
      init code = 0
      init retryable = false
      action reject: failed' = retryable && code > 0 ? failed + 1 : failed
    */
      interface Runtime { failed: number; code: number; retryable: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try { throw { code: runtime.code, retryable: runtime.retryable } }
        catch (error) { if (error.retryable && error.code > 0) runtime.failed++ }
      }
    `;
    const temporal = (parseSpec("record-payload.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("record-payload.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("uses common fields from conditional record throw payloads", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state failed: int
      state primary: bool
      init failed = 0
      init primary = false
      action reject: failed' = failed + (primary ? 1 : 2)
    */
      interface Runtime { failed: number; primary: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          if (runtime.primary) throw { code: 1, retryable: true }
          throw { code: 2, retryable: false }
        } catch (error) {
          if (error.retryable) runtime.failed = runtime.failed + error.code
          else runtime.failed = runtime.failed + error.code
        }
      }
    `;
    const temporal = (parseSpec("conditional-record-payload.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("conditional-record-payload.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("routes a nested conditional throw through the enclosing catch path", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state delivered: int
      state failed: int
      state settled: int
      state outer: bool
      state inner: bool
      init delivered = 0
      init failed = 0
      init settled = 0
      init outer = false
      init inner = false
      action deliver: delivered' = outer ? inner ? delivered : delivered + 1 : delivered, failed' = (outer ? inner : false) ? failed + 1 : failed, settled' = settled + 1
    */
      interface Runtime { delivered: number; failed: number; settled: number; outer: boolean; inner: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          if (runtime.outer) {
            if (runtime.inner) throw "delivery failed"
            runtime.delivered++
          }
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("nested-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("nested-throw.ts", source, "delivery", temporal)).toEqual([]);
  });

  it("keeps return and throw paths distinct while catch discharges only throw", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state returned: int
      state caught: int
      state settled: int
      state chooseReturn: bool
      init returned = 0
      init caught = 0
      init settled = 0
      init chooseReturn = false
      action finish: returned' = chooseReturn ? returned + 1 : returned, caught' = !chooseReturn ? caught + 1 : caught, settled' = settled + 1
    */
      interface Runtime { returned: number; caught: number; settled: number; chooseReturn: boolean }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action finish */
      export function finish(runtime: Runtime) {
        try {
          if (runtime.chooseReturn) { runtime.returned++; return }
          throw "failed"
        } catch {
          runtime.caught++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("heterogeneous-completion.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("heterogeneous-completion.ts", source, "completion", temporal)).toEqual([]);
  });

  it("continues only the caught path after a heterogeneous try completion", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state returned: int
      state caught: int
      state settled: int
      state observed: int
      state chooseReturn: bool
      init returned = 0
      init caught = 0
      init settled = 0
      init observed = 0
      init chooseReturn = false
      action finish: returned' = chooseReturn ? returned + 1 : returned, caught' = !chooseReturn ? caught + 1 : caught, settled' = settled + 1, observed' = chooseReturn ? observed : observed + 1
    */
      interface Runtime { returned: number; caught: number; settled: number; observed: number; chooseReturn: boolean }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action finish */
      export function finish(runtime: Runtime) {
        try {
          if (runtime.chooseReturn) { runtime.returned++; return }
          throw "failed"
        } catch {
          runtime.caught++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("heterogeneous-continuation.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("heterogeneous-continuation.ts", source, "completion", temporal)).toEqual([]);
  });

  it("propagates a catch-local return through finally and the post-try join", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state caught: int
      state settled: int
      state observed: int
      state stop: bool
      init caught = 0
      init settled = 0
      init observed = 0
      init stop = false
      action recover: caught' = stop ? caught : caught + 1, settled' = settled + 1, observed' = stop ? observed : observed + 1
    */
      interface Runtime { caught: number; settled: number; observed: number; stop: boolean }
      /* uneffect: refinement recovery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement recovery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement recovery@1 action recover */
      export function recover(runtime: Runtime) {
        try { throw "failed" }
        catch {
          if (runtime.stop) return
          runtime.caught++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("catch-return.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("catch-return.ts", source, "recovery", temporal)).toEqual([]);
  });

  it("propagates a catch-local rethrow through finally without post-try work", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state caught: int
      state settled: int
      state observed: int
      state rethrow: bool
      init caught = 0
      init settled = 0
      init observed = 0
      init rethrow = false
      action recover: caught' = rethrow ? caught : caught + 1, settled' = settled + 1, observed' = rethrow ? observed : observed + 1
    */
      interface Runtime { caught: number; settled: number; observed: number; rethrow: boolean }
      /* uneffect: refinement recovery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement recovery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement recovery@1 action recover */
      export function recover(runtime: Runtime) {
        try { throw "failed" }
        catch {
          if (runtime.rethrow) throw "failed again"
          runtime.caught++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("catch-rethrow.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("catch-rethrow.ts", source, "recovery", temporal)).toEqual([]);
  });

  it("lets conditional finally return or throw override prior completion", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      state cancel: bool
      state fail: bool
      init worked = 0
      init released = 0
      init observed = 0
      init cancel = false
      init fail = false
      action execute: worked' = worked + 1, released' = cancel ? released + 1 : fail ? released : released + 1, observed' = (cancel || fail) ? observed : observed + 1
    */
      interface Runtime { worked: number; released: number; observed: number; cancel: boolean; fail: boolean }
      /* uneffect: refinement cleanup@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement cleanup@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement cleanup@1 action execute */
      export function execute(runtime: Runtime) {
        try {
          runtime.worked++
        } finally {
          if (runtime.cancel) { runtime.released++; return }
          if (runtime.fail) throw "cleanup failed"
          runtime.released++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-override.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-override.ts", source, "cleanup", temporal)).toEqual([]);
  });

  it("lets a finally throw override a retained return completion", async () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const source = `/* uneffect:
      state recovered: int
      state released: int
      state observed: int
      state stop: bool
      state cleanupFails: bool
      init recovered = 0
      init released = 0
      init observed = 0
      init stop = false
      init cleanupFails = false
      action recover: recovered' = stop ? recovered : recovered + 1, released' = cleanupFails ? released : released + 1, observed' = (stop || cleanupFails) ? observed : observed + 1
    */
      interface Runtime { recovered: number; released: number; observed: number; stop: boolean; cleanupFails: boolean }
      /* uneffect: refinement cleanup@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement cleanup@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement cleanup@1 action recover */
      export function recover(runtime: Runtime) {
        try {
          if (runtime.stop) return
          throw "recoverable"
        } catch {
          runtime.recovered++
        } finally {
          if (runtime.cleanupFails) throw "cleanup failed"
          runtime.released++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-overrides-return.ts", source) as { temporal: unknown }).temporal;
    expect(await validateActions("finally-overrides-return.ts", source, "cleanup", temporal)).toEqual([]);
  });

  it("executes finally but suppresses post-try work on an early-return path", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      state cancelled: bool
      init worked = 0
      init released = 0
      init observed = 0
      init cancelled = false
      action execute: worked' = cancelled ? worked : worked + 1, released' = released + 1, observed' = cancelled ? observed : observed + 1
    */
      interface Runtime { worked: number; released: number; observed: number; cancelled: boolean }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try {
          if (runtime.cancelled) return
          runtime.worked++
        } finally {
          runtime.released++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-return.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-return.ts", source, "resource", temporal)).toEqual([]);
  });

  it("allows finally to override normal completion with a void return", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      init worked = 0
      init released = 0
      init observed = 0
      action execute: worked' = worked + 1, released' = released + 1
    */
      interface Runtime { worked: number; released: number; observed: number }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try { runtime.worked++ }
        finally { runtime.released++; return }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-return-override.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-return-override.ts", source, "resource", temporal)).toEqual([]);
  });

  it("propagates nested early return without executing enclosing continuations", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state routed: int
      state observed: int
      state outer: bool
      state inner: bool
      init routed = 0
      init observed = 0
      init outer = false
      init inner = false
      action route: routed' = outer ? inner ? routed : routed + 1 : routed, observed' = outer ? inner ? observed : observed + 1 : observed + 1
    */
      interface Runtime { routed: number; observed: number; outer: boolean; inner: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        if (runtime.outer) {
          if (runtime.inner) return
          runtime.routed++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("nested-return.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("nested-return.ts", source, "routing", temporal)).toEqual([]);
  });

  it("joins an early-return action branch without executing its trailing updates", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state attempts: int
      state routed: int
      state stop: bool
      init attempts = 0
      init routed = 0
      init stop = false
      action route: attempts' = attempts + 1, routed' = stop ? routed + 1 : routed + 2
    */
      interface Runtime { attempts: number; routed: number; stop: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        runtime.attempts++
        if (runtime.stop) { runtime.routed++; return }
        runtime.routed += 2
      }
    `;
    const temporal = (parseSpec("early-return-routing.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("early-return-routing.ts", source, "routing", temporal)).toEqual([]);
    const valueReturn = source.replace("return }", "return runtime.routed }");
    expect(validateActions("value-return-routing.ts", valueReturn, "routing", temporal)).toEqual([]);
    const effectfulReturn = source.replace("return }", "return computeRoute(runtime) }");
    expect(validateActions("effectful-return-routing.ts", effectfulReturn, "routing", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("refines a Set-backed lease implementation against its temporal actions and invariants", async () => {
    const parseSpec = futureApi("parseSpec");
    const validateProjection = futureApi("validateRefinementStateProjectionInProgram");
    const validateActions = futureApi("validateRefinementActionBodiesInProgramWithZ3");
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgramWithZ3");
    const validateInvariantsWithoutTypes = futureApi("validateRefinementInvariantBodies");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-acceptance-lease-"));
    const fileName = join(directory, "lease.ts");
    const source = `/* uneffect:
      state owners: Set<int>
      state allowedOwners: Set<int>
      state epochs: Map<int, int>
      state leases: Map<int, { epoch: int, valid: bool }>
      init owners = Set(1)
      init allowedOwners = Set(1, 2)
      init epochs = Map([[1, 1]])
      init leases = Map([[1, { epoch: 1, valid: true }]])
      action acquire: owners' = owners.union(Set(2)), epochs' = epochs.put(2, 1)
      temporal ownerPresent: owners.contains(1)
      temporal epochRegistered: epochs.keys().contains(1)
      temporal initialEpoch: epochs.keys().contains(1) && epochs.get(1) === 1
      temporal epochsNonNegative: epochs.values().forall(epoch => epoch >= 0)
      temporal epochKeysKnown: epochs.keys().forall(owner => owner === 1 || owner === 2)
      temporal validLeases: leases.values().forall(lease => !lease.valid || lease.epoch > 0)
      temporal ownersAllowed: owners.forall(owner => allowedOwners.contains(owner))
      temporal hasOwnerOne: owners.exists(owner => owner === 1)
    */
      interface LeaseRecord { epoch: number; valid: boolean }
      interface Runtime { owners: Set<number>; allowedOwners: Set<number>; epochs: Map<number, number>; leases: Map<number, LeaseRecord> }
      /* uneffect: refinement lease@1 create */
      export function createLease(initial: Runtime): Runtime { return initial }
      /* uneffect: refinement lease@1 observe */
      export function observeLease(runtime: Runtime): Runtime { return runtime }
      /* uneffect: refinement lease@1 action acquire */
      export function acquire(runtime: Runtime) { runtime.owners.add(2); runtime.epochs.set(2, 1) }
      /* uneffect: refinement lease@1 invariant ownerPresent */
      export function ownerPresent(runtime: Runtime) { return runtime.owners.has(1) }
      /* uneffect: refinement lease@1 invariant epochRegistered */
      export function epochRegistered(runtime: Runtime) { return runtime.epochs.has(1) }
      /* uneffect: refinement lease@1 invariant initialEpoch */
      export function initialEpoch(runtime: Runtime) { return runtime.epochs.has(1) && runtime.epochs.get(1) === 1 }
      /* uneffect: refinement lease@1 invariant epochsNonNegative */
      export function epochsNonNegative(runtime: Runtime) { return Array.from(runtime.epochs.values()).every(epoch => epoch >= 0) }
      /* uneffect: refinement lease@1 invariant epochKeysKnown */
      export function epochKeysKnown(runtime: Runtime) { return Array.from(runtime.epochs.keys()).every(owner => owner === 1 || owner === 2) }
      /* uneffect: refinement lease@1 invariant validLeases */
      export function validLeases(runtime: Runtime) {
        return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch > 0 })
      }
      /* uneffect: refinement lease@1 invariant ownersAllowed */
      export function ownersAllowed(runtime: Runtime) { return Array.from(runtime.owners).every(owner => runtime.allowedOwners.has(owner)) }
      /* uneffect: refinement lease@1 invariant hasOwnerOne */
      export function hasOwnerOne(runtime: Runtime) { return Array.from(runtime.owners).some(owner => owner === 1) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const spec = (parseSpec(fileName, source) as { temporal: unknown }).temporal;
      expect(validateInvariantsWithoutTypes(fileName, source, "lease", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "ownersAllowed" }),
      );
      expect(validateProjection(program, fileName, "lease", spec)).toEqual([]);
      await expect(validateActions(program, fileName, "lease", spec)).resolves.toEqual([]);
      await expect(validateInvariants(program, fileName, "lease", spec)).resolves.toEqual([]);

      const broken = source.replace("runtime.owners.has(1)", "runtime.owners.has(2)");
      writeFileSync(fileName, broken);
      const brokenProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "ownerPresent" }),
      );
      const brokenMap = source.replace("runtime.epochs.has(1)", "runtime.epochs.has(2)");
      writeFileSync(fileName, brokenMap);
      const brokenMapProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenMapProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "epochRegistered" }),
      );
      const brokenValue = source.replace("runtime.epochs.get(1) === 1", "runtime.epochs.get(1) === 2");
      writeFileSync(fileName, brokenValue);
      const brokenValueProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenValueProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "initialEpoch" }),
      );
      const brokenAuthority = source.replace("runtime.allowedOwners.has(owner)", "runtime.allowedOwners.has(2)");
      writeFileSync(fileName, brokenAuthority);
      const brokenAuthorityProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenAuthorityProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "ownersAllowed" }),
      );
      const brokenValues = source.replace(
        "Array.from(runtime.epochs.values()).every(epoch => epoch >= 0)",
        "Array.from(runtime.epochs.values()).every(epoch => epoch > 0)",
      );
      writeFileSync(fileName, brokenValues);
      const brokenValuesProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenValuesProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "epochsNonNegative" }),
      );
      const brokenExistential = source.replace(
        "Array.from(runtime.owners).some(owner => owner === 1)",
        "Array.from(runtime.owners).some(owner => owner === 2)",
      );
      writeFileSync(fileName, brokenExistential);
      const brokenExistentialProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenExistentialProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "hasOwnerOne" }),
      );
      const brokenLeaseField = source.replace(
        "return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch > 0 })",
        "return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch >= 0 })",
      );
      writeFileSync(fileName, brokenLeaseField);
      const brokenLeaseFieldProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenLeaseFieldProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "validLeases" }),
      );
      const statementCallback = source.replace(
        "lease => { return !lease.valid || lease.epoch > 0 }",
        "lease => { const epoch = lease.epoch; return !lease.valid || epoch > 0 }",
      );
      writeFileSync(fileName, statementCallback);
      const statementCallbackProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(statementCallbackProgram, fileName, "lease", spec)).resolves.toEqual([]);
      const mutableCallback = statementCallback.replace("const epoch = lease.epoch", "let epoch = lease.epoch");
      writeFileSync(fileName, mutableCallback);
      const mutableCallbackProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(mutableCallbackProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "validLeases" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refines statically zero-shot and one-shot while forms without claiming a general loop proof", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state attempted: int
       * state completed: int
       * init attempted = 0
       * init completed = 0
       * action runOnce: attempted' = attempted + 1, completed' = completed + 1
       */
      interface Runtime { attempted: number; completed: number }
      /* uneffect: refinement staticLoop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement staticLoop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement staticLoop@1 action runOnce */
      export function runOnce(runtime: Runtime) {
        while (false) runtime.attempted += 100
        do {
          runtime.attempted++
          runtime.completed++
        } while (false)
      }
    `;
    const specification = parseSpecification("static-loop.ts", source) as { temporal: unknown };
    expect(validateActions("static-loop.ts", source, "staticLoop", specification.temporal)).toEqual([]);
  });

  it("unrolls a canonical bounded while with a local counter", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state total: int
       * init total = 0
       * action addBatch: total' = total + 1 + 2 + 3
       */
      interface Runtime { total: number }
      /* uneffect: refinement whileBatch@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement whileBatch@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement whileBatch@1 action addBatch */
      export function addBatch(runtime: Runtime) {
        let index = 1
        while (index < 4) {
          runtime.total += index
          index++
        }
      }
    `;
    const specification = parseSpecification("bounded-while.ts", source) as { temporal: unknown };
    expect(validateActions("bounded-while.ts", source, "whileBatch", specification.temporal)).toEqual([]);
  });

  it("consumes a bounded-loop break after mandatory finally and before outer continuation", () => {
    const validateActions = futureApi("validateRefinementActionBodies");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state applied: int
       * state finalized: int
       * state audited: int
       * state stop: int
       * init applied = 0
       * init finalized = 0
       * init audited = 0
       * init stop = 0
       * action apply: applied' = stop === 0 ? applied + 1 : stop === 1 ? applied + 1 + 1 : applied + 1 + 1 + 1, finalized' = stop === 0 ? finalized + 1 : stop === 1 ? finalized + 1 + 1 : finalized + 1 + 1 + 1, audited' = audited + 1
       */
      interface Runtime { applied: number; finalized: number; audited: number; stop: number }
      /* uneffect: refinement breakBatch@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement breakBatch@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement breakBatch@1 action apply */
      export function apply(runtime: Runtime) {
        let index = 0
        while (index < 3) {
          try {
            runtime.applied++
            if (runtime.stop === index) break
          } finally {
            runtime.finalized++
          }
          index++
        }
        runtime.audited++
      }
    `;
    const specification = parseSpecification("breaking-while.ts", source) as { temporal: unknown };
    expect(validateActions("breaking-while.ts", source, "breakBatch", specification.temporal)).toEqual([]);
  });

  it("consumes bounded-for continue after mandatory finally and advances the loop", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state applied: int
       * state finalized: int
       * state audited: int
       * state skip: int
       * init applied = 0
       * init finalized = 0
       * init audited = 0
       * init skip = 0
       * action apply: applied' = skip === 0 ? applied + 1 + 1 : skip === 1 ? applied + 1 + 1 : skip === 2 ? applied + 1 + 1 : applied + 1 + 1 + 1, finalized' = finalized + 1 + 1 + 1, audited' = audited + 1
       */
      interface Runtime { applied: number; finalized: number; audited: number; skip: number }
      /* uneffect: refinement continueBatch@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement continueBatch@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement continueBatch@1 action apply */
      export function apply(runtime: Runtime) {
        for (let index = 0; index < 3; index++) {
          try {
            if (runtime.skip === index) continue
            runtime.applied++
          } finally {
            runtime.finalized++
          }
        }
        runtime.audited++
      }
    `;
    const specification = parseSpecification("continuing-for.ts", source) as { temporal: unknown };
    await expect(validateActions("continuing-for.ts", source, "continueBatch", specification.temporal)).resolves.toEqual([]);
  });

  it("binds a finite loop label to its own continue target", async () => {
    const validateActions = futureApi("validateRefinementActionBodiesWithZ3");
    const parseSpecification = futureApi("parseSpec");
    const source = `
      /* uneffect:
       * state applied: int
       * state finalized: int
       * state audited: int
       * state skip: int
       * init applied = 0
       * init finalized = 0
       * init audited = 0
       * init skip = 0
       * action apply: applied' = skip === 0 ? applied + 1 + 1 : skip === 1 ? applied + 1 + 1 : skip === 2 ? applied + 1 + 1 : applied + 1 + 1 + 1, finalized' = finalized + 1 + 1 + 1, audited' = audited + 1
       */
      interface Runtime { applied: number; finalized: number; audited: number; skip: number }
      /* uneffect: refinement labeledContinue@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement labeledContinue@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement labeledContinue@1 action apply */
      export function apply(runtime: Runtime) {
        batch: for (let index = 0; index < 3; index++) {
          try {
            if (runtime.skip === index) continue batch
            runtime.applied++
          } finally {
            runtime.finalized++
          }
        }
        runtime.audited++
      }
    `;
    const specification = parseSpecification("labeled-continuing-for.ts", source) as { temporal: unknown };
    await expect(validateActions("labeled-continuing-for.ts", source, "labeledContinue", specification.temporal)).resolves.toEqual([]);
  });

  it("compares native Promise, Uneffect annotations, and Effect TS against the same observable contract", async () => {
    const compareImplementations = futureApi("compareEffectImplementations");
    const result = await compareImplementations({ fixture: "fetch-and-recover" }) as { implementations: string[]; sameResult: boolean; sameDeclaredAuthority: boolean; effectTsRecovery: { unhandledFailures: number }; limitations: string[] };
    expect(result.implementations).toEqual(["native", "uneffect", "effect-ts"]);
    expect(result.sameResult).toBe(true);
    expect(result.sameDeclaredAuthority).toBe(true);
    expect(result.effectTsRecovery.unhandledFailures).toBe(0);
    expect(result.limitations).not.toContain(expect.stringContaining("catchAll"));
  });

  it("dogfoods representative projects and reports adoption and verifier KPIs", async () => {
    const measureAdoption = futureApi("measureUneffectAdoption");
    const report = await measureAdoption({ fixtures: ["node-cli", "browser-app", "worker-app"] }) as {
      falsePositiveRate: number;
      unknownSummaryRate: number;
      annotationDensity: number;
      verifierMilliseconds: number;
      frontendMilliseconds: number;
      builtinDrift: unknown[];
      external: { packageName: string; sourceFiles: number; analyzedFunctions: number; unknownSummaries: number; unknownReasonCounts: Record<string, number>; diagnostics: unknown[]; builtinDrift: unknown[]; frontendMilliseconds: number };
    };
    expect(report.falsePositiveRate).toBeLessThanOrEqual(0.02);
    expect(report.unknownSummaryRate).toBeLessThanOrEqual(0.05);
    expect(report.annotationDensity).toBeLessThanOrEqual(0.15);
    expect(report.verifierMilliseconds).toBeGreaterThan(0);
    expect(report.frontendMilliseconds).toBeGreaterThan(0);
    expect(report.builtinDrift).toEqual([]);
    expect(report.external).toMatchObject({
      packageName: "effect",
      unknownSummaries: 1,
      unknownReasonCounts: { "unresolved-call": 1 },
      diagnostics: [],
      builtinDrift: [],
    });
    expect(report.external.sourceFiles).toBeGreaterThanOrEqual(3);
    expect(report.external.analyzedFunctions).toBeGreaterThanOrEqual(40);
    expect(report.external.frontendMilliseconds).toBeGreaterThan(0);
  });
});
