import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { authenticateResourceCallableContractArtifact, createResourceCallableContractArtifact, resourceCallableArtifactAssumption } from "../src/resource-callable-artifact.js";
import { collectResourceCallableTransitionSites } from "../src/resource-callable-typescript.js";

const declarationText = "export declare function consume(body: object): void";
const base = () => createResourceCallableContractArtifact({
  symbol: { module: "reviewed-sdk", export: "consume" },
  runtime: { kind: "package", version: "1.2.3" },
  declarationText,
  summary: {
    schema: "uneffect-resource-callable-summary/v1", id: "reviewed-sdk#consume", evidence: "trusted",
    operations: [{ kind: "consume", subject: { kind: "parameter", index: 0, name: "body" } }],
  },
  trust: { owner: "platform-team", reason: "reviewed SDK 1.2.3", expiresOn: "2027-01-01" },
});
const environment = {
  symbol: { module: "reviewed-sdk", export: "consume" },
  runtime: { kind: "package" as const, version: "1.2.3" },
  declarationText,
  declarationId: "/node_modules/reviewed-sdk/index.d.ts:0",
  asOf: "2026-08-31",
};

describe("resource callable contract artifacts", () => {
  it("rebinds an exact reviewed artifact to TypeChecker declaration identity without upgrading trust", () => {
    expect(authenticateResourceCallableContractArtifact(base(), environment)).toMatchObject({
      status: "accepted",
      summary: { id: environment.declarationId, evidence: "trusted", operations: [{ kind: "consume" }] },
    });
    expect(resourceCallableArtifactAssumption(base(), { fileName: "index.d.ts", span: { start: 0, end: declarationText.length } })).toMatchObject({
      evidence: "trusted", domain: "resource-callable", owner: "platform-team", expiresOn: "2027-01-01",
      dependency: { module: "reviewed-sdk", packageVersion: "1.2.3" },
    });
  });

  it("blocks stale, mismatched, tampered, and self-asserted verified artifacts", () => {
    expect(authenticateResourceCallableContractArtifact(base(), { ...environment, runtime: { kind: "package", version: "1.2.4" } }))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["runtime version mismatch"]) });
    expect(authenticateResourceCallableContractArtifact(base(), { ...environment, asOf: "2027-01-02" }))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["trust review is expired or invalid"]) });
    expect(authenticateResourceCallableContractArtifact({ ...base(), declarationSha256: "0".repeat(64) }, environment))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["declaration digest mismatch", "artifact digest mismatch"]) });
    const verified = { ...base(), summary: { ...base().summary, evidence: "verified" } };
    expect(authenticateResourceCallableContractArtifact(verified, environment))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["external resource summary must remain trusted", "artifact digest mismatch"]) });
    const malformed = { ...base(), summary: { ...base().summary, operations: [{ kind: "consume", subject: { kind: "parameter", index: -1 } }] } };
    expect(authenticateResourceCallableContractArtifact(malformed, environment))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["invalid resource summary", "artifact digest mismatch"]) });
    const wrongIdentity = { ...base(), summary: { ...base().summary, id: "other#consume" } };
    expect(authenticateResourceCallableContractArtifact(wrongIdentity, environment))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["summary symbol identity mismatch", "artifact digest mismatch"]) });
    const invalidAcquire = createResourceCallableContractArtifact({
      symbol: environment.symbol, runtime: environment.runtime, declarationText,
      summary: { ...base().summary, operations: [{ kind: "acquire", subject: { kind: "parameter", index: 0 } }] },
      trust: base().trust,
    });
    expect(authenticateResourceCallableContractArtifact(invalidAcquire, environment))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["invalid resource summary"]) });
  });

  it.each(["acquire", "use", "release"] as const)("authenticates the %s lifecycle operation", (kind) => {
    const subject = kind === "acquire" ? { kind: "return" as const }
      : kind === "use" ? { kind: "receiver" as const } : { kind: "parameter" as const, index: 0 };
    const artifact = createResourceCallableContractArtifact({
      symbol: environment.symbol, runtime: environment.runtime, declarationText,
      summary: { ...base().summary, operations: [{ kind, subject }] }, trust: base().trust,
    });
    expect(authenticateResourceCallableContractArtifact(artifact, environment)).toMatchObject({
      status: "accepted", summary: { operations: [{ kind }] },
    });
  });

  it("connects an authenticated package artifact to a TypeChecker-resolved call", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-artifact-"));
    try {
      const packageDirectory = join(directory, "node_modules", "reviewed-sdk");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "reviewed-sdk", version: "1.2.3", types: "index.d.ts" }));
      writeFileSync(join(packageDirectory, "index.d.ts"), `${declarationText}\n`);
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `import { consume } from "reviewed-sdk"; export function main(body: object) { consume(body) }`);
      const program = ts.createProgram([entry], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const source = program.getSourceFile(entry)!;
      const main = source.statements.find(ts.isFunctionDeclaration)!;
      const call = main.body!.statements[0] as ts.ExpressionStatement;
      const signature = program.getTypeChecker().getResolvedSignature(call.expression as ts.CallExpression)!;
      const declaration = signature.declaration!;
      const declarationSource = declaration.getSourceFile();
      const authenticated = authenticateResourceCallableContractArtifact(base(), {
        ...environment,
        declarationText: declarationSource.text,
        declarationId: `${declarationSource.fileName}:${declaration.getStart(declarationSource)}`,
      });
      expect(authenticated.status).toBe("blocked");

      const exactArtifact = createResourceCallableContractArtifact({
        symbol: environment.symbol, runtime: environment.runtime, declarationText: declarationSource.text,
        summary: base().summary, trust: base().trust,
      });
      const accepted = authenticateResourceCallableContractArtifact(exactArtifact, {
        ...environment,
        declarationText: declarationSource.text,
        declarationId: `${declarationSource.fileName}:${declaration.getStart(declarationSource)}`,
      });
      expect(accepted.status).toBe("accepted");
      if (accepted.status === "accepted") expect(collectResourceCallableTransitionSites(program, main, [accepted.summary])).toMatchObject({
        diagnostics: [], sites: [{ transitions: [{ kind: "consume", evidence: "trusted" }] }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
