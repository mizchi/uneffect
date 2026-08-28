import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as uneffect from "../src/index.js";

type FutureApi = (...args: unknown[]) => unknown;

function futureApi(name: string): FutureApi {
  const candidate = (uneffect as unknown as Record<string, unknown>)[name];
  expect(candidate, `public API ${name} is not implemented`).toBeTypeOf("function");
  return candidate as FutureApi;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("declaration transform evidence", () => {
  it("publishes a strict manifest schema for the supported profile", () => {
    expect(JSON.parse(readFileSync("schemas/uneffect-declaration-transforms-v1.schema.json", "utf8"))).toMatchObject({
      $id: "https://github.com/mizchi/uneffect/blob/main/schemas/uneffect-declaration-transforms-v1.schema.json",
      additionalProperties: false,
      required: ["schema", "transforms"],
      properties: {
        schema: { const: "uneffect-declaration-transforms/v1" },
        transforms: {
          items: {
            additionalProperties: false,
            required: expect.arrayContaining(["profile", "transform", "sourceFile", "generatedFile", "sourceSpan", "sourceDigest", "generatedDigest", "compilerVersion"]),
            properties: { profile: { const: "embedded-typescript/v1" } },
          },
        },
      },
    });
  });

  it("verifies only an exact embedded TypeScript source span", () => {
    const parse = futureApi("parseDeclarationTransformManifest");
    const validate = futureApi("validateDeclarationTransformManifest");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-declaration-transform-"));
    const sourceFile = join(directory, "counter.component");
    const generatedFile = join(directory, "counter.ts");
    const generated = "export interface Counter { value: number }\nexport function increment(value: number) { return value + 1 }\n";
    const source = `<script lang="ts">\n${generated}</script>\n`;
    const start = source.indexOf(generated), end = start + generated.length;
    try {
      writeFileSync(sourceFile, source);
      writeFileSync(generatedFile, generated);
      const manifest = parse({
        schema: "uneffect-declaration-transforms/v1",
        transforms: [{
          profile: "embedded-typescript/v1",
          transform: { name: "component-script", version: "1.0.0" },
          sourceFile, generatedFile, sourceSpan: { start, end },
          sourceDigest: digest(source), generatedDigest: digest(generated),
          compilerVersion: ts.version,
        }],
      });
      expect(validate(manifest)).toMatchObject({
        status: "verified",
        evidence: [expect.objectContaining({
          schema: "uneffect-declaration-transform-evidence/v1",
          profile: "embedded-typescript/v1",
          transform: { name: "component-script", version: "1.0.0" },
          sourceFile, generatedFile, sourceSpan: { start, end },
          sourceDigest: digest(source), generatedDigest: digest(generated),
          compilerVersion: ts.version,
          status: "verified",
        })],
        diagnostics: [],
      });

      writeFileSync(sourceFile, source.replace("Counter", "ChangedCounter"));
      expect(validate(manifest)).toMatchObject({
        status: "mismatch",
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "source-digest-mismatch", generatedFile })]),
      });
      writeFileSync(sourceFile, source);
      writeFileSync(generatedFile, generated.replace("number", "string"));
      expect(validate(manifest)).toMatchObject({
        status: "mismatch",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "generated-digest-mismatch", generatedFile }),
          expect.objectContaining({ code: "source-span-mismatch", generatedFile }),
        ]),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown profiles, missing spans, and compiler drift", () => {
    const parse = futureApi("parseDeclarationTransformManifest");
    const validate = futureApi("validateDeclarationTransformManifest");
    const base = {
      schema: "uneffect-declaration-transforms/v1",
      transforms: [{
        profile: "embedded-typescript/v1",
        transform: { name: "component-script", version: "1.0.0" },
        sourceFile: "/missing/source.component", generatedFile: "/missing/source.ts",
        sourceSpan: { start: 0, end: 0 }, sourceDigest: "0".repeat(64),
        generatedDigest: "0".repeat(64), compilerVersion: ts.version,
      }],
    };
    expect(() => parse({ ...base, transforms: [{ ...base.transforms[0], profile: "arbitrary/v1" }] }))
      .toThrow(/unsupported declaration transform profile/);
    const { sourceSpan: _span, ...withoutSpan } = base.transforms[0];
    expect(() => parse({ ...base, transforms: [withoutSpan] })).toThrow(/sourceSpan/);
    expect(validate(parse({
      ...base,
      transforms: [{ ...base.transforms[0], compilerVersion: "0.0.0" }],
    }))).toMatchObject({
      status: "mismatch",
      diagnostics: [expect.objectContaining({ code: "compiler-version-mismatch" })],
    });
  });
});
