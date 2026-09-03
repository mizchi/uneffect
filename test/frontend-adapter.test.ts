import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { auditBuiltinDeclarationDrift, collectBuiltinCallRefinements, standardLibraryOperation } from "../src/frontend-adapter.js";
import { builtinContractRegistry, extendBuiltinContractRegistry } from "../src/builtin-contracts.js";
import { analyzeEffectsInProgram, analyzeProgramEffects } from "../src/effects.js";
import { verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";
import { analyzeUneffectProject } from "../src/custom-validators.js";

describe("TypeChecker symbol adapter", () => {
  it("authenticates standard operations through immutable aliases but rejects mutable aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-standard-operation-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        const P = Promise;
        const resolve = Promise.resolve;
        const { reject } = Promise;
        let MutablePromise = Promise;
        let mutableResolve = Promise.resolve;
        P.resolve(1);
        resolve(1);
        reject(new Error("no"));
        new P<number>((done) => done(1));
        MutablePromise.resolve(1);
        mutableResolve(1);
        new MutablePromise<number>((done) => done(1));
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.esnext.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const operations = source.statements.flatMap((statement) =>
        ts.isExpressionStatement(statement)
          && (ts.isCallExpression(statement.expression) || ts.isNewExpression(statement.expression))
          ? [standardLibraryOperation(program.getTypeChecker(), statement.expression)] : []);
      expect(operations).toEqual([
        "PromiseConstructor#resolve", "PromiseConstructor#resolve", "PromiseConstructor#reject", "PromiseConstructor",
        undefined, undefined, undefined,
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("infers fixed external script loading only after a script element is inserted", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-static-script-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        /* uneffect:effect Dom<Create, typeof document> | Dom<PropertyWrite, typeof script> | Dom<NodeWrite, typeof document.head> | Mutate<typeof document.head> | InvokeUserCode | ScriptLoad<Classic, "https://cdn.example.com/sdk.js"> | ExecuteExternalCode<"https://cdn.example.com/sdk.js", "sha384-YWJj"> | Net<"cdn.example.com:443"> */
        export function load() {
          const script = document.createElement("script");
          script.src = "https://cdn.example.com/sdk.js";
          script.integrity = "sha384-YWJj";
          script.crossOrigin = "anonymous";
          document.head.appendChild(script);
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      expect(analyzeEffectsInProgram(program, source)).toEqual([]);
      expect(analyzeProgramEffects(program).summaries.find((summary) => summary.functionName === "load")?.effects)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "ScriptLoad" }),
          expect.objectContaining({ kind: "capability", name: "ExecuteExternalCode" }),
          expect.objectContaining({ kind: "capability", name: "Net" }),
        ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps dynamic script URLs and missing integrity explicitly unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dynamic-script-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        export function load(url: string) {
          const script = document.createElement("script");
          script.src = url;
          document.head.appendChild(script);
        }
        export function conditional(flag: boolean) {
          const script = document.createElement("script");
          if (flag) script.src = "https://cdn.example.com/sdk.js";
          script.integrity = "sha384-YWJj";
          script.crossOrigin = "anonymous";
          document.head.appendChild(script);
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const summary = analyzeProgramEffects(program).summaries.find((item) => item.functionName === "load")!;
      expect(summary.effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "capability", name: "ScriptLoad", arguments: expect.arrayContaining([expect.objectContaining({ kind: "unknown", reason: "dynamic-script-url" })]) }),
        expect.objectContaining({ kind: "capability", name: "ExecuteExternalCode", arguments: expect.arrayContaining([expect.objectContaining({ kind: "unknown", reason: "missing-script-integrity" })]) }),
      ]));
      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "conditional")?.effects)
        .toContainEqual(expect.objectContaining({
          kind: "capability", name: "ScriptLoad",
          arguments: expect.arrayContaining([expect.objectContaining({ kind: "unknown", reason: "dynamic-script-url" })]),
        }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("binds a Datadog sink contract to its exact package version and intake authority", () => {
    const directory = mkdtempSync(join(process.cwd(), ".uneffect-datadog-contract-"));
    const packageRoot = join(directory, "node_modules", "@datadog", "browser-rum");
    const fileName = join(directory, "input.ts");
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
        name: "@datadog/browser-rum", version: "6.0.0", types: "index.d.ts",
      }));
      writeFileSync(join(packageRoot, "index.d.ts"), `
        export declare const datadogRum: {
          addAction(name: string, context?: object): void;
          status: string;
          Client: new () => object;
        };
        export declare const fake: typeof datadogRum;
      `);
      writeFileSync(fileName, `
        import { datadogRum, fake } from "@datadog/browser-rum";
        export function report() { datadogRum.addAction("critical_failure"); }
        const addAction = datadogRum.addAction;
        export function reportAlias() { addAction("aliased"); }
        const { addAction: destructuredAction } = datadogRum;
        export function reportDestructured() { destructuredAction("destructured"); }
        export function reportFake() { fake.addAction("not_datadog"); }
        export function reportBracket() { datadogRum["addAction"]("bracket"); }
        export function reportFakeBracket() { fake["addAction"]("fake-bracket"); }
        export function reportDynamic(key: "addAction") { datadogRum[key]("dynamic"); }
        export function readStatus() { return datadogRum.status; }
        export function readFakeStatus() { return fake.status; }
        export function readBracketStatus() { return datadogRum["status"]; }
        export function readFakeBracketStatus() { return fake["status"]; }
        export function readDynamicStatus(key: "status") { return datadogRum[key]; }
        export function writeStatus() { datadogRum.status = "ready"; }
        export function writeFakeStatus() { fake.status = "ready"; }
        export function createClient() { return new datadogRum.Client(); }
        export function createFakeClient() { return new fake.Client(); }
        export function createBracketClient() { return new datadogRum["Client"](); }
        export function createFakeBracketClient() { return new fake["Client"](); }
        export function createDynamicClient(key: "Client") { return new datadogRum[key](); }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const registry = (version: string) => extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
        symbol: { module: "@datadog/browser-rum", export: "datadogRum", path: ["addAction"] },
        runtime: { kind: "package" as const, version }, evidence: "trusted" as const,
        semantics: { schema: "uneffect-semantic-primitives/v1" as const, primitives: [{ kind: "effect" as const, capability: "Fetch<POST, \"https://browser-intake-datadoghq.com/api/v2/**\">" }] },
        trustReason: "reviewed Datadog wrapper delivery authority", trustOwner: "telemetry-platform",
      }, {
        symbol: { module: "@datadog/browser-rum", export: "datadogRum", path: ["status"] },
        runtime: { kind: "package" as const, version }, evidence: "trusted" as const,
        semantics: { schema: "uneffect-semantic-primitives/v1" as const, primitives: [{
          kind: "property" as const,
          read: [{ kind: "effect" as const, capability: "CookieRead<\"dd-session\">" }],
          write: [{ kind: "effect" as const, capability: "CookieWrite<\"dd-session\">" }],
        }] },
        trustReason: "reviewed Datadog status read", trustOwner: "telemetry-platform",
      }, {
        symbol: { module: "@datadog/browser-rum", export: "datadogRum", path: ["Client"] },
        runtime: { kind: "package" as const, version }, evidence: "trusted" as const,
        semantics: { schema: "uneffect-semantic-primitives/v1" as const, primitives: [{ kind: "effect" as const, capability: "Console" }] },
        trustReason: "reviewed Datadog client construction", trustOwner: "telemetry-platform",
      }] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "report"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "Fetch" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportAlias"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "Fetch" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportDestructured"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "Fetch" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportFake"))
        .toMatchObject({ evidence: "unknown", effects: [], unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportBracket"))
        .toMatchObject({ effects: [expect.objectContaining({ kind: "capability", name: "Fetch" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportFakeBracket"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "reportDynamic"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "readStatus"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "CookieRead" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "readFakeStatus"))
        .toMatchObject({ evidence: "unknown", effects: [], unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "readBracketStatus"))
        .toMatchObject({ effects: [expect.objectContaining({ kind: "capability", name: "CookieRead" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "readFakeBracketStatus"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "readDynamicStatus"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "writeStatus"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "CookieWrite" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "writeFakeStatus"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "createClient"))
        .toMatchObject({ evidence: "inferred", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "createFakeClient"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "createBracketClient"))
        .toMatchObject({ effects: [expect.objectContaining({ kind: "capability", name: "Console" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "createFakeBracketClient"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.0") }).summaries.find((item) => item.functionName === "createDynamicClient"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.1") }).summaries.find((item) => item.functionName === "report"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("6.0.1") }).summaries.find((item) => item.functionName === "createClient"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks cookie and Web Storage reads and writes by DOM symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-browser-storage-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        /* uneffect:effect CookieRead | CookieWrite<"theme"> */
        export function cookies() { const before = document.cookie; document.cookie = "theme=dark"; return before }
        /* uneffect:effect LocalStorageRead<"theme"> | LocalStorageWrite<"theme"> */
        export function preferences() { const before = localStorage.getItem("theme"); localStorage.setItem("theme", "dark"); return before }
        /* uneffect:effect LocalStorageRead<"theme" | "locale"> */
        export function finite(key: "theme" | "locale") { return localStorage.getItem(key) }
        export function dynamic(key: string) { return localStorage.removeItem(key) }
        /* uneffect:effect LocalStorageWrite */
        export function clearAll() { localStorage.clear() }
        interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
        /* uneffect:effect none */
        export function shadowed(storage: StorageLike) { storage.getItem("theme"); storage.setItem("theme", "dark") }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      expect(analyzeEffectsInProgram(program, source)).toEqual([
        expect.objectContaining({ functionName: "dynamic", kind: "missing", effect: "LocalStorageWrite<Unknown<dynamic-storage-key>>" }),
      ]);
      const summaries = analyzeProgramEffects(program).summaries;
      expect(summaries.find((item) => item.functionName === "cookies")?.effects)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "CookieRead", arguments: [{ kind: "all" }] }),
          expect.objectContaining({ kind: "capability", name: "CookieWrite", arguments: [{ kind: "finite", atoms: [{ kind: "literal", value: "theme" }] }] }),
        ]));
      expect(summaries.find((item) => item.functionName === "preferences")?.effects)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "LocalStorageRead", arguments: [{ kind: "finite", atoms: [{ kind: "literal", value: "theme" }] }] }),
          expect.objectContaining({ kind: "capability", name: "LocalStorageWrite", arguments: [{ kind: "finite", atoms: [{ kind: "literal", value: "theme" }] }] }),
        ]));
      expect(summaries.find((item) => item.functionName === "finite")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "LocalStorageRead", arguments: [expect.objectContaining({ kind: "finite", atoms: expect.arrayContaining([
          { kind: "literal", value: "theme" }, { kind: "literal", value: "locale" },
        ]) })] }));
      expect(summaries.find((item) => item.functionName === "dynamic")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "LocalStorageWrite", arguments: [{ kind: "unknown", reason: "dynamic-storage-key" }] }));
      expect(summaries.find((item) => item.functionName === "clearAll")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "LocalStorageWrite", arguments: [{ kind: "all" }] }));
      expect(analyzeProgramEffects(program).summaries.find((item) => item.functionName === "shadowed")?.effects).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks same-realm globalThis keys without trusting same-spelled locals", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-global-vars-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        declare global { var featureFlag: boolean; var counter: number }
        /* uneffect:effect GlobalVarsRead<"featureFlag"> | GlobalVarsWrite<"counter"> */
        export function access() { const enabled = globalThis.featureFlag; globalThis.counter = enabled ? 1 : 0 }
        /* uneffect:effect GlobalVarsRead<"featureFlag"> */
        export function alias() { const realm = globalThis; return realm["featureFlag"] }
        /* uneffect:effect GlobalVarsRead<"featureFlag"> */
        export function browserAlias() { return window.featureFlag }
        /* uneffect:effect GlobalVarsRead<"featureFlag" | "counter"> */
        export function finite(key: "featureFlag" | "counter") { return globalThis[key] }
        /* uneffect:effect GlobalVarsRead<"counter"> | GlobalVarsWrite<"counter"> */
        export function update() { return globalThis.counter++ }
        /* uneffect:effect GlobalVarsWrite<"counter"> */
        export function erase() { return delete (globalThis as Record<string, unknown>)["counter"] }
        export function dynamic(key: string) { return globalThis[key as keyof typeof globalThis] }
        /* uneffect:effect none */
        export function shadowed(globalThis: { featureFlag: boolean }) { return globalThis.featureFlag }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      expect(analyzeEffectsInProgram(program, source)).toEqual([
        expect.objectContaining({ functionName: "dynamic", kind: "missing", effect: "GlobalVarsRead<Unknown<dynamic-global-key>>" }),
      ]);
      const summaries = analyzeProgramEffects(program).summaries;
      expect(summaries.find((item) => item.functionName === "access")?.effects.map((effect) => effect.kind === "capability" ? `${effect.name}:${effect.arguments[0]?.kind === "finite" ? effect.arguments[0].atoms[0]?.value : ""}` : effect.kind))
        .toEqual(expect.arrayContaining(["GlobalVarsRead:featureFlag", "GlobalVarsWrite:counter"]));
      expect(summaries.find((item) => item.functionName === "alias")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "GlobalVarsRead" }));
      expect(summaries.find((item) => item.functionName === "browserAlias")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "GlobalVarsRead" }));
      expect(summaries.find((item) => item.functionName === "finite")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "GlobalVarsRead", arguments: [expect.objectContaining({ kind: "finite", atoms: expect.arrayContaining([
          expect.objectContaining({ value: "featureFlag" }), expect.objectContaining({ value: "counter" }),
        ]) })] }));
      expect(summaries.find((item) => item.functionName === "update")?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind))
        .toEqual(expect.arrayContaining(["GlobalVarsRead", "GlobalVarsWrite"]));
      expect(summaries.find((item) => item.functionName === "erase")?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind))
        .toEqual(["GlobalVarsWrite"]);
      expect(summaries.find((item) => item.functionName === "dynamic")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "GlobalVarsRead", arguments: [expect.objectContaining({ kind: "unknown", reason: "dynamic-global-key" })] }));
      expect(summaries.find((item) => item.functionName === "shadowed")?.effects).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records network transport separately from the shared Net authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-network-via-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        export async function request() { await fetch("https://api.example.com/v1/users") }
        /* uneffect:effect Net<"telemetry.example.com:443"> */
        export function beacon() { navigator.sendBeacon("https://telemetry.example.com/v1/events", "ok") }
        /* uneffect:effect Net<"stream.example.com:443"> */
        export function socket() { return new WebSocket("wss://stream.example.com/events") }
        /* uneffect:effect Net */
        export function dynamicSocket(url: string) { return new WebSocket(url) }
        /* uneffect:effect Net */
        export function dynamicBeacon(url: string) { navigator.sendBeacon(url) }
        interface NavigatorLike { sendBeacon(url: string, body?: string): boolean }
        class WebSocketLike { constructor(_url: string) {} }
        /* uneffect:effect none */
        export function shadowedBeacon(navigator: NavigatorLike) { navigator.sendBeacon("https://telemetry.example.com/v1/events") }
        /* uneffect:effect none */
        export function shadowedSocket() { return new WebSocketLike("wss://stream.example.com/events") }
        export async function main() { await request() }
        export function script() {
          const node = document.createElement("script");
          node.src = "https://cdn.example.com/sdk.js";
          node.integrity = "sha384-YWJj";
          node.crossOrigin = "anonymous";
          document.head.appendChild(node);
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const summaries = analyzeProgramEffects(program).summaries;
      expect(summaries.find((item) => item.functionName === "request")?.networkBoundaries)
        .toContainEqual(expect.objectContaining({ via: "fetch", authority: "api.example.com:443", target: "https://api.example.com/v1/users" }));
      expect(summaries.find((item) => item.functionName === "beacon")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "Net", arguments: [{ kind: "finite", atoms: [{ kind: "host", value: "telemetry.example.com:443" }] }] }));
      expect(summaries.find((item) => item.functionName === "beacon")?.networkBoundaries)
        .toContainEqual(expect.objectContaining({ via: "beacon", authority: "telemetry.example.com:443", target: "https://telemetry.example.com/v1/events", evidence: "exact" }));
      expect(summaries.find((item) => item.functionName === "dynamicBeacon"))
        .toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Net", arguments: [{ kind: "all" }] })], networkBoundaries: [expect.objectContaining({ via: "beacon", authority: "unknown", target: "unknown", evidence: "unknown" })] });
      expect(summaries.find((item) => item.functionName === "socket"))
        .toMatchObject({
          evidence: "verified",
          effects: [expect.objectContaining({ kind: "capability", name: "Net", arguments: [{ kind: "finite", atoms: [{ kind: "host", value: "stream.example.com:443" }] }] })],
          networkBoundaries: [expect.objectContaining({ via: "websocket", authority: "stream.example.com:443", target: "wss://stream.example.com/events", evidence: "exact" })],
        });
      expect(summaries.find((item) => item.functionName === "dynamicSocket"))
        .toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Net", arguments: [{ kind: "all" }] })], networkBoundaries: [expect.objectContaining({ via: "websocket", authority: "unknown", target: "unknown", evidence: "unknown" })] });
      expect(summaries.find((item) => item.functionName === "shadowedBeacon")?.effects).toEqual([]);
      expect(summaries.find((item) => item.functionName === "shadowedSocket")?.effects).toEqual([]);
      expect(summaries.find((item) => item.functionName === "script")?.networkBoundaries)
        .toContainEqual(expect.objectContaining({ via: "script", authority: "cdn.example.com:443", target: "https://cdn.example.com/sdk.js" }));
      expect(summaries.find((item) => item.functionName === "main")?.networkBoundaries)
        .toContainEqual(expect.objectContaining({ via: "fetch", authority: "api.example.com:443" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves a reviewed callable result and exposes its captured callbacks", () => {
    const directory = mkdtempSync(join(process.cwd(), ".uneffect-callable-result-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        import { OxlintUtils, definePlugin } from "corsa-oxlint";
        const createRule = OxlintUtils.RuleCreator(() => "https://example.com/rule");
        export const rule = createRule({ name: "example", meta: {}, create() { return {} } } as any);
        export function buildWithLogging() {
          const loggedRule = OxlintUtils.RuleCreator(() => { console.log("resolve URL"); return "https://example.com/logged"; });
          return loggedRule({ name: "logged", meta: {}, create() { return {} } } as any);
        }
        export default definePlugin({ meta: { name: "example" }, rules: { example: rule } });
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      const source = program.getSourceFile(fileName)!;
      const calls = collectBuiltinCallRefinements(program, source);
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ symbol: { module: "corsa-oxlint", export: "OxlintUtils#RuleCreator" } }),
        expect.objectContaining({
          symbol: { module: "corsa-oxlint", export: "OxlintUtils#RuleCreator" },
          capturedCallbacks: [expect.objectContaining({ kind: ts.SyntaxKind.ArrowFunction })],
        }),
        expect.objectContaining({ symbol: { module: "corsa-oxlint", export: "definePlugin" } }),
      ]));
      const moduleSummary = analyzeProgramEffects(program).summaries.find((item) => item.fileName === fileName && item.functionName === "<module>");
      expect(moduleSummary).toMatchObject({ evidence: "trusted" });
      expect(moduleSummary?.unknownReasons).toBeUndefined();
      expect(analyzeProgramEffects(program).summaries.find((item) => item.fileName === fileName && item.functionName === "buildWithLogging")?.effects)
        .toContainEqual(expect.objectContaining({ kind: "capability", name: "Console" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not trust a reviewed callable result through a mutable binding", () => {
    const directory = mkdtempSync(join(process.cwd(), ".uneffect-mutable-callable-result-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `
        import { OxlintUtils } from "corsa-oxlint";
        let createRule = OxlintUtils.RuleCreator(() => "https://example.com/rule");
        createRule({ name: "example", meta: {}, create() { return {} } } as any);
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      const source = program.getSourceFile(fileName)!;
      expect(collectBuiltinCallRefinements(program, source)
        .filter((call) => call.symbol.export === "OxlintUtils#RuleCreator")).toHaveLength(1);
      expect(analyzeProgramEffects(program).summaries.find((item) => item.fileName === fileName && item.functionName === "<module>")).toMatchObject({
        evidence: "unknown",
        unknownReasons: [expect.objectContaining({ code: "unresolved-call" })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves named imports from export-equals Node modules", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-export-equals-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { join as pathJoin } from "node:path";
      const resolved = pathJoin("a", "b");
      function join(...parts: string[]) { return parts.join("/") }
      const local = join("a", "b");
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.symbol.export === "join"))
      .toEqual([expect.objectContaining({ symbol: { module: "node:path", export: "join" } })]);
  });

  it("applies an external function contract only to its exact package version", () => {
    const directory = mkdtempSync(join(process.cwd(), ".uneffect-versioned-call-"));
    const fileName = join(directory, "input.ts");
    try {
      writeFileSync(fileName, `import * as v from "valibot"; export const schema = v.number()`);
      const relativeFileName = relative(process.cwd(), fileName);
      const program = ts.createProgram([relativeFileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const registry = (version: string) => extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
        symbol: { module: "valibot", export: "number" },
        runtime: { kind: "package" as const, version }, evidence: "trusted" as const,
        trustReason: "reviewed pure schema factory", trustOwner: "test",
      }] });

      expect(analyzeProgramEffects(program, { builtinRegistry: registry("1.4.2") }).summaries.find((summary) => summary.functionName === "<module>"))
        .toMatchObject({ evidence: "trusted" });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("0.0.0") }).summaries.find((summary) => summary.functionName === "<module>"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unresolved-call" })] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses a versioned external fresh-result annotation", () => {
    const directory = mkdtempSync(join(process.cwd(), ".uneffect-fresh-result-"));
    const packageRoot = join(directory, "node_modules", "reviewed-values");
    const fileName = join(directory, "input.ts");
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
        name: "reviewed-values", version: "1.0.0", types: "index.d.ts",
      }));
      writeFileSync(join(packageRoot, "index.d.ts"), "export declare function keys(value: object): string[]");
      writeFileSync(fileName, `
        import { keys } from "reviewed-values"
        /* uneffect:effect none */
        export function sorted(value: object) { return keys(value).sort() }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const registry = (version: string) => extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
        symbol: { module: "reviewed-values", export: "keys" },
        runtime: { kind: "package" as const, version }, evidence: "trusted" as const,
        semantics: { schema: "uneffect-semantic-primitives/v1" as const, primitives: [{ kind: "result" as const, refinement: { kind: "fresh" as const } }] },
        trustReason: "reviewed allocation contract", trustOwner: "test",
      }] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("1.0.0") }).summaries.find((item) => item.functionName === "sorted"))
        .toMatchObject({ evidence: "verified", effects: [] });
      expect(analyzeProgramEffects(program, { builtinRegistry: registry("1.0.1") }).summaries.find((item) => item.functionName === "sorted"))
        .toMatchObject({ evidence: "unknown", unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("applies tmpdir refinement through aliased and namespace symbol identity only", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-symbols-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { tmpdir as targetTemp } from "node:os";
      import * as os from "node:os";
      const a = targetTemp();
      const b = os.tmpdir();
      function tmpdir() { return "shadowed" }
      const c = tmpdir();
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    const calls = collectBuiltinCallRefinements(program, source);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.symbol)).toEqual([
      { module: "node:os", export: "tmpdir" },
      { module: "node:os", export: "tmpdir" },
    ]);
    expect(calls.every((call) => call.result?.kind === "path" && call.result.pattern === "$TEMP")).toBe(true);
  });

  it("infers fs effects from resolved symbols and ignores a shadowing receiver", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-effects-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import * as fs from "node:fs";
      /* uneffect:effect FsRead<"a"> */
      function actual() { return fs.readFileSync("a") }
      function shadowed(fs: { readFileSync(path: string): string }) { return fs.readFileSync("a") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
  });

  it("resolves imported Node class members without matching a user-defined method name", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { createServer } from "node:net";
      createServer().close(() => undefined);
      class Server { close(callback: () => void) { callback() } }
      new Server().close(() => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.symbol.export === "Server#close")).toEqual([
      expect.objectContaining({ symbol: { module: "node:net", export: "Server#close" } }),
    ]);
  });

  it("resolves an inherited net.Server member through a node:http receiver", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-http-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { createServer } from "node:http";
      const server = createServer();
      server.listen(8080, "127.0.0.1", () => undefined);
      class Server { listen(_port: number, callback: () => void) { callback() } }
      new Server().listen(8080, () => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.symbol.export === "Server#listen"))
      .toEqual([expect.objectContaining({ symbol: { module: "node:net", export: "Server#listen" } })]);
  });

  it("resolves node:net Socket.connect without matching a lookalike", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-socket-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import type { Socket } from "node:net";
      declare const socket: Socket;
      socket.connect({ host: "example.com", port: 443 }, () => undefined);
      class LocalSocket { connect(_options: object, callback: () => void) { callback() } }
      new LocalSocket().connect({}, () => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.semantics?.primitives.some((primitive) => primitive.kind === "callback")))
      .toEqual([expect.objectContaining({ symbol: { module: "node:net", export: "Socket#connect" } })]);
  });

  it("resolves global fetch and console while ignoring a shadowed fetch parameter", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-globals-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Console | Fetch | Net */
      async function actual() { console.log("start"); await fetch("https://example.com/") }
      function shadowed(fetch: (url: string) => void) { fetch("https://example.com/") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
  });

  it("maps DOM member symbols to receiver-scoped compound effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<NodeRead, typeof document> */
      function query() { return document.querySelector(".item") }
      /* uneffect:effect Dom<NodeWrite, typeof root> | Mutate<typeof root> | Mutate<typeof child> | InvokeUserCode */
      function attach(root: Element, child: Node) { root.appendChild(child) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(collectBuiltinCallRefinements(program, source)).toContainEqual(
      expect.objectContaining({ queryRefinement: { kind: "css-selector", selector: ".item" } }),
    );
    expect(auditBuiltinDeclarationDrift(program)).toEqual([]);
    expect(auditBuiltinDeclarationDrift(program, {
      ...builtinContractRegistry,
      declarations: [{ ...builtinContractRegistry.declarations[0]!, sha256: "stale" }],
    })).toContainEqual(expect.objectContaining({ library: "lib.dom.d.ts", actual: expect.any(String) }));
  });

  it("classifies reviewed attribute, topology, and character-data methods", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-categories-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<AttributeRead, typeof element> */
      function inspectAttributes(element: Element) { return [element.hasAttribute("role"), element.getAttributeNames()] }
      /* uneffect:effect Dom<AttributeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function updateAttributes(element: Element) { element.removeAttribute("hidden"); element.toggleAttribute("open") }
      /* uneffect:effect Dom<NodeRead, typeof node> */
      function inspectTopology(node: Node, other: Node) { return node.contains(other) && node.compareDocumentPosition(other) !== 0 }
      /* uneffect:effect Dom<NodeWrite, typeof root> | Mutate<typeof root> | Mutate<typeof child> | Mutate<typeof before> | InvokeUserCode */
      function insert(root: Node, child: Node, before: Node) { return root.insertBefore(child, before) }
      /* uneffect:effect Dom<TextRead, typeof data> */
      function readRange(data: CharacterData) { return data.substringData(0, 1) }
      /* uneffect:effect Dom<TextWrite, typeof data> | Mutate<typeof data> */
      function replaceRange(data: CharacterData) { data.replaceData(0, 1, "x") }
      interface LocalElement { hasAttribute(name: string): boolean; toggleAttribute(name: string): boolean }
      function localMethods(element: LocalElement) { return element.hasAttribute("x") || element.toggleAttribute("x") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("emits compound DOM effects for clone, normalize, and adjacent content", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-compound-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<NodeRead, typeof node> | Dom<Create, typeof node> */
      function clone(node: Node) { return node.cloneNode(true) }
      /* uneffect:effect Dom<NodeWrite, typeof node> | Dom<TextWrite, typeof node> | Mutate<typeof node> */
      function normalize(node: Node) { node.normalize() }
      /* uneffect:effect Dom<Parse, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function insertMarkup(element: Element) { element.insertAdjacentHTML("beforeend", "<span>ready</span>") }
      /* uneffect:effect Dom<TextWrite, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> */
      function insertText(element: Element) { element.insertAdjacentText("beforeend", "ready") }
      interface LocalNode { cloneNode(deep?: boolean): LocalNode; normalize(): void }
      function local(node: LocalNode) { node.normalize(); return node.cloneNode(true) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("projects NamedNodeMap effects back to a proven Element origin", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-live-view-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<AttributeRead, typeof element> | Dom<AttributeWrite, typeof element> | Mutate<typeof element> | Mutate<typeof attr> | InvokeUserCode */
      function direct(element: Element, attr: Attr) { element.attributes.setNamedItem(attr); return element.attributes.getNamedItem("role") }
      /* uneffect:effect Dom<AttributeRead, typeof element> | Dom<AttributeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function immutableAlias(element: Element) { const attrs = element.attributes; attrs.removeNamedItem("hidden") }
      /* uneffect:effect Dom<AttributeRead, typeof first> | Dom<AttributeRead, typeof second> | Dom<AttributeWrite, typeof attrs> | InvokeUserCode */
      function mutableAlias(first: Element, second: Element) { let attrs = first.attributes; attrs = second.attributes; attrs.removeNamedItem("hidden") }
      interface LocalMap { setNamedItem(attr: object): void }
      function local(map: LocalMap, attr: object) { map.setNamedItem(attr) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("classifies markup serialization, parsing, and layout properties", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-markup-layout-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<NodeRead, typeof element> | Dom<AttributeRead, typeof element> | Dom<TextRead, typeof element> */
      function readMarkup(element: Element) { return element.innerHTML }
      /* uneffect:effect Dom<Parse, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function writeMarkup(element: Element) { element.innerHTML = "<span>ready</span>" }
      /* uneffect:effect Dom<NodeRead, typeof element> | Dom<AttributeRead, typeof element> | Dom<TextRead, typeof element> | Dom<Parse, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function appendMarkup(element: Element) { element.innerHTML += "<span>ready</span>" }
      /* uneffect:effect Dom<NodeRead, typeof root> | Dom<AttributeRead, typeof root> | Dom<TextRead, typeof root> */
      function readShadowMarkup(root: ShadowRoot) { return root.innerHTML }
      /* uneffect:effect Dom<LayoutRead, typeof element> */
      function measure(element: HTMLElement) { return element.clientWidth + element.scrollHeight + element.offsetHeight }
      interface LocalMarkup { innerHTML: string; clientWidth: number }
      /* uneffect:effect Mutate<typeof value> */
      function local(value: LocalMarkup) { value.innerHTML = String(value.clientWidth) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("scopes outerHTML replacement to the parent topology region", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-outer-html-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<NodeRead, typeof element> | Dom<AttributeRead, typeof element> | Dom<TextRead, typeof element> */
      function readOuter(element: Element) { return element.outerHTML }
      /* uneffect:effect Dom<Parse, typeof element.parentNode> | Dom<NodeWrite, typeof element.parentNode> | Mutate<typeof element.parentNode> | Mutate<typeof element> | InvokeUserCode */
      function replaceOuter(element: Element) { element.outerHTML = "<section>ready</section>" }
      /* uneffect:effect Dom<NodeRead, typeof element> | Dom<AttributeRead, typeof element> | Dom<TextRead, typeof element> | Dom<Parse, typeof element.parentNode> | Dom<NodeWrite, typeof element.parentNode> | Mutate<typeof element.parentNode> | Mutate<typeof element> | InvokeUserCode */
      function appendOuter(element: Element) { element.outerHTML += "<section>ready</section>" }
      interface LocalOuter { outerHTML: string; parentNode: object }
      /* uneffect:effect Mutate<typeof value> */
      function local(value: LocalOuter) { value.outerHTML = "local" }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("distinguishes DOM text and Web IDL property reads from writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-property-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Dom<TextRead, typeof node> */
      function readText(node: Node) { return node.textContent }
      /* uneffect:effect Dom<TextWrite, typeof node> | Dom<NodeWrite, typeof node> | Mutate<typeof node> | InvokeUserCode */
      function replaceText(node: Node) { node.textContent = "updated" }
      /* uneffect:effect Dom<TextWrite, typeof node> | Mutate<typeof node> */
      function writeNodeValue(node: Node) { node.nodeValue = "updated" }
      /* uneffect:effect Dom<TextRead, typeof data> */
      function readCharacterData(data: CharacterData) { return data.data }
      /* uneffect:effect Dom<TextWrite, typeof data> | Mutate<typeof data> */
      function writeCharacterData(data: CharacterData) { data.data = "updated" }
      /* uneffect:effect Dom<NodeRead, typeof node> */
      function readParent(node: Node) { return node.parentNode }
      /* uneffect:effect Dom<NodeRead, typeof element> */
      function readChildren(element: Element) { return element.children }
      /* uneffect:effect Dom<AttributeRead, typeof element> */
      function readAttributes(element: Element) { return element.attributes }
      /* uneffect:effect Dom<PropertyRead, typeof input> */
      function readValue(input: HTMLInputElement) { return input.value }
      /* uneffect:effect Dom<PropertyRead, typeof input> */
      function readLiteralValue(input: HTMLInputElement) { return input["value"] }
      /* uneffect:effect Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function writeValue(input: HTMLInputElement) { input.value = "updated" }
      /* uneffect:effect Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function writeLiteralValue(input: HTMLInputElement) { input["value"] = "updated" }
      /* uneffect:effect Dom<PropertyRead, typeof input> | Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function appendValue(input: HTMLInputElement) { input.value += "!" }
      /* uneffect:effect Dom<All, typeof input> */
      function dynamicRead(input: HTMLInputElement, key: "value" | "checked") { return input[key] }
      /* uneffect:effect Dom<All, typeof input> | Mutate<typeof input> */
      function dynamicWrite(input: HTMLInputElement, key: "value" | "checked") { input[key] = undefined as never }
      /* uneffect:effect Dom<PropertyWrite, typeof proxy> | InvokeUserCode */
      function proxyWrite(input: HTMLInputElement) { const proxy = new Proxy(input, {}); proxy.value = "proxied" }
      interface LocalInput { value: string }
      /* uneffect:effect Mutate<typeof input> */
      function localWrite(input: LocalInput) { input.value = "local" }
      interface LocalNode { parentNode: object; attributes: object }
      function localTopology(node: LocalNode) { return [node.parentNode, node.attributes] }
      interface LocalCharacterData { data: string }
      /* uneffect:effect Mutate<typeof data> */
      function localDataWrite(data: LocalCharacterData) { data.data = "local" }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("preserves DOM property symbols in virtual project analysis", () => {
    const result = analyzeUneffectProject({ mode: "strict", files: { "src/app.ts": `
      /* uneffect:effect Dom<TextWrite, typeof target> | Dom<NodeWrite, typeof target> | Mutate<typeof target> | InvokeUserCode */
      export function render(target: HTMLElement) { target.textContent = "ready" }
    ` } });
    expect(result.diagnostics).toEqual([]);
  });

  it("marks accessors, proxies, computed-key coercion, and value coercion as user-code invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-user-code-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      class Box { get value() { return 1 } }
      /* uneffect:effect InvokeUserCode */ function getter(box: Box) { return box.value }
      /* uneffect:effect InvokeUserCode */ function proxy() { const value = new Proxy({}, {}); return value.x }
      /* uneffect:effect InvokeUserCode */ function assimilate(flag: boolean) {
        const foreign = { get then() { if (flag) throw new Error("getter"); return (resolve: (value: number) => void) => resolve(1) } }
        return new Promise<number>((resolve) => resolve(foreign))
      }
      /* uneffect:effect InvokeUserCode */ async function collect(values: Iterable<Promise<number>>) { await Promise.all(values) }
      /* uneffect:effect InvokeUserCode */ function key(value: object, key: object) { return (value as any)[key as any] }
      function safeKey(value: Record<"success" | "failure", number>, key: "success" | "failure") { return value[key] }
      class RoutedBox { get success() { return 1 } get failure() { return 0 } }
      /* uneffect:effect InvokeUserCode */ function routedGetter(value: RoutedBox, key: "success" | "failure") { return value[key] }
      /* uneffect:effect InvokeUserCode */ function coerce(value: object) { return value + "" }
      /* uneffect:effect InvokeUserCode */ function compare(value: object) { return value == 1 }
      /* uneffect:effect InvokeUserCode */ function arithmetic(value: object) { return value * 2 }
      /* uneffect:effect InvokeUserCode */ function unary(value: object) { return +value }
      /* uneffect:effect InvokeUserCode */ function interpolate(value: object) { return \`value=\${value}\` }
      function primitiveUnion(value: string | number | null | undefined) {
        return value == 1 || \`value=\${value}\` === "value=1"
      }
      /* uneffect:effect InvokeUserCode */ function proxyHas() {
        const target = new Proxy({}, {}); const alias = target; return "value" in alias
      }
      /* uneffect:effect InvokeUserCode */ function proxyDelete() {
        const target = new Proxy({ value: 1 }, {}); return delete target.value
      }
      /* uneffect:effect InvokeUserCode */ function proxyCopy() {
        const target = new Proxy({ value: 1 }, {}); const alias = target; return { ...alias }
      }
      class Plain {}
      function safeOperators(value: object) { return "value" in value || value instanceof Plain }
      function shadowedProxy() {
        class Proxy { value = 1 }
        const target = new Proxy(); return target.value
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    expect(analyzeEffectsInProgram(program, program.getSourceFile(fileName)!)).toEqual([]);
  });

  it("instantiates clone and transfer effects while keeping SharedArrayBuffer shared", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-transfer-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Clone<typeof value> | Transfer<typeof buffer> | Throw<DOMException> */
      function move(value: object, buffer: ArrayBuffer) { structuredClone(value, { transfer: [buffer] }) }
      /* uneffect:effect Clone<typeof shared> | SharedMemory<typeof shared> | Throw<DOMException> */
      function share(shared: SharedArrayBuffer) { structuredClone(shared) }
      /* uneffect:effect Clone<typeof value> | Transfer<typeof buffer> */
      function post(worker: Worker, value: object, buffer: ArrayBuffer) { worker.postMessage(value, [buffer]) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    expect(analyzeEffectsInProgram(program, program.getSourceFile(fileName)!)).toEqual([]);
  });

  it("recognizes integer casts by lib.d.ts symbol identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-math-symbols-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      function builtin(output: BoundedUint8Array<1>, value: U8) { output[0] = Math.floor(value) }
      const floorAlias = Math.floor
      const { trunc: truncate } = Math
      function aliases(output: BoundedUint8Array<2>, value: U8) {
        output[0] = floorAlias(value)
        output[1] = truncate(value)
      }
      function shadowed(output: BoundedUint8Array<1>, value: U8) {
        const Math = { floor: (_value: number) => 1.5 }
        output[0] = Math.floor(value)
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = await verifyTypedArraySafetyInTypeScriptProgram(program, program.getSourceFile(fileName)!);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "builtin", kind: "u8-write", result: "verified" }));
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write").every((item) => item.result === "verified")).toBe(true);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write")).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "shadowed", kind: "u8-write" }));
  });

  it("propagates integer cast identity through immutable aliases, properties, imports, and parameters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-math-propagation-"));
    const helpers = join(directory, "helpers.ts");
    const fileName = join(directory, "input.ts");
    writeFileSync(helpers, `
      export const importedFloor = Math.floor
    `);
    writeFileSync(fileName, `
      import { importedFloor } from "./helpers.js"
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      const first = Math.floor
      const second = first
      const casts = { truncate: Math.trunc } as const
      function applyCast(output: BoundedUint8Array<1>, cast: (value: number) => number, value: U8) { output[0] = cast(value) }
      function aliases(output: BoundedUint8Array<3>, value: U8) {
        output[0] = second(value)
        output[1] = casts.truncate(value)
        output[2] = importedFloor(value)
      }
      applyCast(new Uint8Array(1), Math.ceil, 1)
      let mutable = Math.floor
      mutable = (value) => value + 0.5
      function mutableAlias(output: BoundedUint8Array<1>, value: U8) { output[0] = mutable(value) }
      const mutableObject = { cast: Math.floor }
      mutableObject.cast = (value) => value + 0.5
      function mutableProperty(output: BoundedUint8Array<1>, value: U8) { output[0] = mutableObject.cast(value) }
    `);
    const program = ts.createProgram([fileName, helpers], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = await verifyTypedArraySafetyInTypeScriptProgram(program, program.getSourceFile(fileName)!);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write")).toHaveLength(3);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write").every((item) => item.result === "verified")).toBe(true);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "applyCast", kind: "u8-write", result: "verified" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "mutableAlias", kind: "u8-write" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "mutableProperty", kind: "u8-write" }));
  });

  it("uses shared region evidence for DataView aliases and rejects escape", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dataview-region-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      type Nat = number
      type BoundedDataView<N extends number> = DataView
      declare function escape(value: DataView): void
      function safe(view: BoundedDataView<8>) {
        const root = view
        const cursor = root
        cursor.getUint8(0)
        cursor.getUint16(1)
      }
      function escaped(view: BoundedDataView<8>) {
        const cursor = view
        escape(cursor)
        cursor.getUint8(0)
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts"] });
    const result = await verifyTypedArraySafetyInTypeScriptProgram(program, program.getSourceFile(fileName)!);

    expect(result.obligations.filter((item) => item.functionName === "safe" && item.kind === "dataview-bounds"))
      .toHaveLength(2);
    expect(result.obligations.filter((item) => item.functionName === "safe" && item.kind === "dataview-bounds")
      .every((item) => item.result === "verified")).toBe(true);
    expect(result.obligations).toContainEqual(expect.objectContaining({
      functionName: "escaped", kind: "dataview-bounds", result: "unknown",
    }));
  });
});
