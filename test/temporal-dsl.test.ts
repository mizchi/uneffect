import { describe, expect, it } from "vitest";
import ts from "typescript";
import { generateQuint } from "../src/spec-backends.js";
import { bool, defineTemporal, int, parseTemporalDsl, resolveTemporalDslLink, validateTemporalDslHelperIdentities } from "../src/temporal-dsl.js";
import { generateTemporalModel } from "../src/temporal-model.js";
import { verifyUneffectProject } from "../src/project-verification.js";

defineTemporal({
  state: { count: int(), ready: bool() },
  init: { count: 0, ready: false },
  actions: { increment: ({ count }) => ({ count: count + 1 }) },
  invariants: { valid: ({ count, ready }) => count >= 0 || ready },
});

const source = `
  import { bool, defineTemporal, int } from "@mizchi/uneffect/spec";

  export default defineTemporal({
    state: { attempts: int(), done: bool() },
    init: { attempts: 0, done: false },
    actions: {
      retry: ({ attempts }) => ({ attempts: attempts + 1 }),
      finish: ({ attempts }) => ({ done: attempts >= 1 }),
    },
    guards: { retry: ({ done }) => !done },
    fairness: { retry: "weak" },
    invariants: {
      nonnegative: ({ attempts }) => attempts >= 0,
    },
    eventually: {
      completes: ({ done }) => done,
    },
    repeatedly: {
      observesCompletion: ({ done }) => done,
    },
    stabilizes: {
      remainsDone: ({ done }) => done,
    },
    responses: {
      retryCompletes: {
        trigger: ({ attempts, done }) => attempts > 0 && !done,
        response: ({ done }) => done,
      },
    },
  });
`;

describe("TypeScript temporal DSL", () => {
  it("lowers a .uneffect.ts module to the neutral temporal IR", () => {
    const spec = parseTemporalDsl("upload.uneffect.ts", source);
    expect(spec.states).toEqual([
      { name: "attempts", type: "int" },
      { name: "done", type: "bool" },
    ]);
    expect(spec.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "retry", fairness: "weak", guard: expect.objectContaining({ expression: "!done" }) }),
      expect.objectContaining({ name: "finish" }),
    ]));
    expect(spec.properties[0]?.name).toBe("nonnegative");
    expect(spec.liveness[0]?.name).toBe("completes");
    expect(spec.recurrences[0]?.name).toBe("observesCompletion");
    expect(spec.stabilizations[0]?.name).toBe("remainsDone");
    expect(spec.responses[0]?.name).toBe("retryCompletes");
    expect(generateQuint("upload", spec)).toContain("temporal completes = eventually(done)");
  });

  it("requires helpers imported from the Uneffect spec entrypoint", () => {
    expect(() => parseTemporalDsl("bad.uneffect.ts", source.replace('from "@mizchi/uneffect/spec"', 'from "somewhere-else"')))
      .toThrow(/must be imported from @mizchi\/uneffect\/spec/);
  });

  it("fails closed for executable or dynamic specification code", () => {
    expect(() => parseTemporalDsl("bad.uneffect.ts", source.replace("attempts: int()", "attempts: chooseType()")))
      .toThrow(/unsupported temporal state descriptor/);
    expect(() => parseTemporalDsl("bad.uneffect.ts", source.replace("attempts: attempts + 1", "attempts: helper(attempts)")))
      .toThrow(/unsupported temporal expression/);
    expect(() => parseTemporalDsl("bad.uneffect.ts", source.replace("export default", "const hidden = 1; export default")))
      .toThrow(/unsupported top-level statement/);
  });

  it("connects an implementation comment to a .uneffect.ts model", () => {
    const files = {
      "src/upload.ts": `/* uneffect:temporal from "./upload.uneffect.ts#default" */\nexport function upload() {}`,
      "src/upload.uneffect.ts": source,
    };
    const link = resolveTemporalDslLink("src/upload.ts", files["src/upload.ts"], files);
    expect(link).toMatchObject({ implementationFile: "src/upload.ts", specificationFile: "src/upload.uneffect.ts", exportName: "default" });
    const model = generateTemporalModel({
      fileName: "src/upload.ts",
      source: files["src/upload.ts"],
      runtime: "web",
      linkedTemporal: link,
    });
    expect(model.includedDomains).toContain("user-temporal");
    expect(model.models).toContainEqual(expect.objectContaining({ kind: "user-temporal", properties: ["nonnegative"] }));
    expect(model.quint).toContain("module src_upload_uneffect");
  });

  it("fails closed on missing, non-default, and ambiguous temporal links", () => {
    const implementation = `/* uneffect:temporal from "./missing.uneffect.ts#default" */\nexport function upload() {}`;
    expect(() => resolveTemporalDslLink("src/upload.ts", implementation, {})).toThrow(/does not exist/);
    expect(() => resolveTemporalDslLink("src/upload.ts", implementation.replace("#default", "#Upload"), { "src/missing.uneffect.ts": source })).toThrow(/only #default/);
    expect(() => resolveTemporalDslLink("src/upload.ts", `${implementation}\n${implementation}`, {})).toThrow(/exactly one/);
  });

  it("loads the linked model during project verification", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/upload.ts": `/* uneffect:temporal from "./upload.uneffect.ts#default" */\nexport function upload() {}`,
        "src/upload.uneffect.ts": source,
      },
      temporalRuntime: "web",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.temporal?.models).toContainEqual(expect.objectContaining({
      fileName: "src/upload.ts", kind: "user-temporal", module: "src_upload_uneffect",
    }));
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({ name: "nonnegative", result: "verified" }));
  }, 40_000);

  it("rejects a same-spelled helper that does not have Uneffect symbol identity", () => {
    const files: Record<string, string> = {
      "/spec.uneffect.ts": `import { defineTemporal, int } from "@mizchi/uneffect/spec"; export default defineTemporal({ state: { n: int() }, init: { n: 0 }, actions: { inc: ({ n }: any) => ({ n: n + 1 }) } });`,
      "/fake.ts": `export const defineTemporal = (value: unknown) => value; export const int = () => ({ kind: "int" });`,
    };
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
    host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
    host.getSourceFile = (name, languageVersion, onError, fresh) => files[name] === undefined
      ? original(name, languageVersion, onError, fresh)
      : ts.createSourceFile(name, files[name], languageVersion, true, ts.ScriptKind.TS);
    host.resolveModuleNames = (names) => names.map(() => ({ resolvedFileName: "/fake.ts", extension: ts.Extension.Ts, isExternalLibraryImport: true }));
    const program = ts.createProgram({ rootNames: Object.keys(files), options, host });
    expect(() => validateTemporalDslHelperIdentities(program, "/spec.uneffect.ts"))
      .toThrow(/does not resolve .* TypeChecker symbol identity/);
  });
});
