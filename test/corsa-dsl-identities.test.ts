import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openCorsaApiFrontend } from "../src/frontends/corsa/corsa-api-frontend.js";
import { validateCorsaDslHelperIdentities } from "../src/spec/corsa-dsl-identities.js";

describe("Corsa DSL helper identities", () => {
  async function project(kind: "temporal" | "contract" | "capability" | "refinement", fake: boolean, test: (frontend: Awaited<ReturnType<typeof openCorsaApiFrontend>>, file: string, source: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-dsl-"));
    const file = join(directory, "spec.uneffect.ts"), configFile = join(directory, "tsconfig.json");
    const more = JSON.parse(readFileSync("test/fixtures/oxc-capability-refinement-parity.json", "utf8"));
    const source: string = kind === "capability" || kind === "refinement" ? more[kind][1].source : kind === "temporal"
      ? 'import { defineTemporal as define, int as integer, bool, text } from "@mizchi/uneffect/spec"; export default define({state: { n: integer() }, init: { n: 0 }, actions: { next: ({n}) => ({n: n+1}) }});'
      : 'import { defineContract as define, int as integer, nat, float, bool } from "@mizchi/uneffect/spec"; export const Contract = define({parameters:{n:integer()}, returns:integer(), ensures:({n,result}) => result >= n});';
    const fakeFile = join(directory, `${kind}-authoring.ts`);
    writeFileSync(fakeFile, 'export const defineTemporal = (x: any) => x, defineContract = (x: any) => x; export const int = () => ({}), nat = int, float = int, bool = int, text = int; export const defineCapability = defineTemporal, defineEffectSchema = defineTemporal, Custom = int, Console = int, Fetch = int, FsRead = int, Throw = int, Builtin = int, defineRefinement = defineTemporal, globalRuntime = int, identityProjection = int, setFromArrayProjection = int;');
    writeFileSync(file, source);
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", types: [], paths: { "@mizchi/uneffect/spec": [fake ? fakeFile : resolve("src/spec/index.ts")] } }, files: [file] }));
    let frontend: Awaited<ReturnType<typeof openCorsaApiFrontend>> | undefined;
    try { frontend = await openCorsaApiFrontend({ configFile }); test(frontend, file, source); }
    finally { frontend?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  it.each(["temporal", "contract", "capability", "refinement"] as const)("authenticates %s aliases against package-owned symbols", async kind => {
    await project(kind, false, (frontend, file, source) => expect(() => validateCorsaDslHelperIdentities(frontend, file, source, kind)).not.toThrow());
  });
  it.each(["temporal", "contract", "capability", "refinement"] as const)("rejects %s impostors even with the expected declaration basename", async kind => {
    await project(kind, true, (frontend, file, source) => expect(() => validateCorsaDslHelperIdentities(frontend, file, source, kind)).toThrow(/Corsa symbol identity/));
  });
  it("rejects a declaration path that merely ends with the package's absolute path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-dsl-suffix-"));
    const fake = join(directory, resolve("src/contracts/contract-authoring.ts"));
    const file = join(directory, "spec.ts"), configFile = join(directory, "tsconfig.json");
    const source = 'import { defineContract } from "@mizchi/uneffect/spec"; export const Contract = defineContract({});';
    let frontend: Awaited<ReturnType<typeof openCorsaApiFrontend>> | undefined;
    try {
      mkdirSync(dirname(fake), { recursive: true });
      writeFileSync(fake, "export const defineContract = (value: unknown) => value;");
      writeFileSync(file, source);
      writeFileSync(configFile, JSON.stringify({ compilerOptions: { types: [], paths: { "@mizchi/uneffect/spec": [fake] } }, files: [file] }));
      frontend = await openCorsaApiFrontend({ configFile });
      expect(() => validateCorsaDslHelperIdentities(frontend!, file, source, "contract")).toThrow(/Corsa symbol identity/);
    } finally { frontend?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
