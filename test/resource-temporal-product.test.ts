import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAsyncSafety } from "../src/async-safety.js";
import { lowerResourceDisposalsToProtocol } from "../src/resource-disposal-protocol.js";
import { createResourceDisposalTemporalProduct, evaluateResourceTemporalProduct } from "../src/resource-temporal-product.js";
import { generateResourceTemporalProductQuint } from "../src/resource-temporal-product.js";

describe("resource temporal product IR", () => {
  it("links sync and awaited disposal to their neutral completion lanes", () => {
    const analysis = analyzeAsyncSafety("using-product.ts", `
      interface SyncResource { [Symbol.dispose](): void }
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function openSync(): SyncResource
      declare function openAsync(): AsyncResource
      async function main() {
        using sync = openSync()
        await using asyncResource = openAsync()
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.product.links.map(({ relation }) => relation)).toEqual(["await-completion", "inline"]);
    expect(evaluateResourceTemporalProduct(created.product)).toMatchObject({
      status: "satisfied", evidence: "exact", preconditions: [], reasons: [],
    });
    expect(created.product.initializerFailureResources).toEqual(created.product.resource.resources.map(({ id }) => id));
    const quint = generateResourceTemporalProductQuint("resource_product", created.product);
    expect(quint).toContain("action fail_acquire_0");
    expect(quint).toContain("action fail_acquire_1");
    expect(quint).toContain("pc' = 2");
    expect(quint).toContain("action release_start_2");
    expect(quint).toContain("action release_resume_2");
    expect(quint).toContain("action release_inline_3");
    expect(quint).toContain("val resourceTemporalSafe");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-initializer-failure-"));
    try {
      const path = join(directory, "model.qnt");
      writeFileSync(path, quint);
      const checked = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=resource_product", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=300", "--seed=0x696e6974"], { encoding: "utf8" });
      expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("models an explicitly awaited initializer on the microtask lane", () => {
    const analysis = analyzeAsyncSafety("awaited-initializer.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Resource>
      async function main() { await using resource = await open() }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.product.initializerAwaitedResources).toEqual([expect.stringContaining(":resource")]);
    const quint = generateResourceTemporalProductQuint("awaited_initializer", created.product);
    expect(quint).toContain("action acquire_start_0");
    expect(quint).toContain("action acquire_resume_0");
    expect(quint).toContain("action fail_acquire_reject_0");
    expect(quint).toContain("action fail_acquire_inline_0");
    expect(quint).not.toContain("action acquire_0 =");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-awaited-initializer-"));
    try {
      const validPath = join(directory, "valid.qnt");
      writeFileSync(validPath, quint);
      const valid = spawnSync("pnpm", ["exec", "quint", "run", validPath, "--main=awaited_initializer", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=300", "--seed=0x61776169"], { encoding: "utf8" });
      expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
      const brokenPath = join(directory, "broken.qnt");
      writeFileSync(brokenPath, generateResourceTemporalProductQuint("broken_awaited_initializer", created.product, { resumeOutsideMicrotask: true }));
      const broken = spawnSync("pnpm", ["exec", "quint", "run", brokenPath, "--main=broken_awaited_initializer", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=500", "--seed=0x61776169"], { encoding: "utf8" });
      expect(broken.status).not.toBe(0);
      expect(`${broken.stdout}${broken.stderr}`).toMatch(/violation|counterexample/iu);
      const corruptPath = join(directory, "corrupt-parent.qnt");
      writeFileSync(corruptPath, generateResourceTemporalProductQuint("corrupt_parent_product", created.product, { corruptSuppressionParent: true }));
      const corrupt = spawnSync("pnpm", ["exec", "quint", "run", corruptPath, "--main=corrupt_parent_product", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=500", "--seed=0x756e6566"], { encoding: "utf8" });
      expect(corrupt.status).not.toBe(0);
      expect(`${corrupt.stdout}${corrupt.stderr}`).toMatch(/violation|counterexample/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed for lane mismatch, dangling, duplicate, and unlinked releases", () => {
    const analysis = analyzeAsyncSafety("using-product-invalid.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main() { await using resource = open() }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    if (created.status !== "ready") throw new Error(created.reasons.join("; "));
    const link = created.product.links[0]!;
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [{ ...link, relation: "inline" }] }).reasons)
      .toContainEqual(expect.stringContaining("targets microtask"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [{ ...link, hostTransitionId: "missing" }] }).reasons)
      .toContainEqual(expect.stringContaining("dangling host"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [link, link] }).reasons)
      .toContainEqual(expect.stringContaining("duplicate"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [] }).reasons)
      .toContainEqual(expect.stringContaining("no host completion link"));
    expect(evaluateResourceTemporalProduct({
      ...created.product,
      host: created.product.host.map((transition) => transition.kind === "dispose-resource" ? { ...transition, resource: "other" } : transition),
    }).reasons).toContainEqual(expect.stringContaining("resource identity mismatch"));
  });

  it("models bounded conditional acquisition as acquire-or-skip before host-linked disposal", () => {
    const analysis = analyzeAsyncSafety("conditional-using-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main(enabled: boolean) {
        if (enabled) { await using resource = open() }
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.product.optionalResources).toHaveLength(1);
    expect(evaluateResourceTemporalProduct(created.product)).toMatchObject({
      status: "satisfied", evidence: "exact", preconditions: [], reasons: [],
    });
    const quint = generateResourceTemporalProductQuint("conditional_resource_product", created.product);
    expect(quint).toContain("action skip_acquire_0");
    expect(quint).toContain("action skip_release_1");
  });

  it("models one repeated loop acquisition with explicit generation reset", () => {
    const analysis = analyzeAsyncSafety("loop-using-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main(values: boolean[]) {
        for (const value of values) { await using resource = open(); void value }
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    expect(lifecycle).toMatchObject({ status: "exact", repeatedAcquisition: { resources: [expect.stringContaining(":resource")] } });
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    const quint = generateResourceTemporalProductQuint("loop_resource_product", created.product);
    expect(quint).toContain("action exit_repeat_0");
    expect(quint).toContain("action release_resume_repeat_1");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-loop-resource-"));
    try {
      const path = join(directory, "model.qnt");
      writeFileSync(path, quint);
      const checked = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=loop_resource_product", "--invariant=resourceTemporalSafe", "--max-steps=18", "--max-samples=500", "--seed=0x6c6f6f70"], { encoding: "utf8" });
      expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed for multiple or non-stack repeated acquisition regions", () => {
    const multiple = analyzeAsyncSafety("multiple-loop-using.ts", `
      interface Resource { [Symbol.dispose](): void }
      declare function open(): Resource
      function main(left: number[], right: number[]) {
        for (const value of left) { using first = open(); void value }
        for (const value of right) { using second = open(); void value }
      }
    `);
    expect(lowerResourceDisposalsToProtocol(multiple.resources, multiple.disposals, "main"))
      .toMatchObject({ status: "unknown", reasons: expect.arrayContaining(["repeated-acquisition"]) });

    const nonStack = analyzeAsyncSafety("non-stack-loop-using.ts", `
      interface Resource { [Symbol.dispose](): void }
      declare function open(): Resource
      function main(values: number[]) {
        for (const value of values) { using repeated = open(); void value }
        using later = open()
      }
    `);
    expect(lowerResourceDisposalsToProtocol(nonStack.resources, nonStack.disposals, "main"))
      .toMatchObject({ status: "unknown", reasons: expect.arrayContaining(["non-stack-acquisition-order"]) });
  });

  it("keeps disposal rejection and suppression in the common host product", () => {
    const analysis = analyzeAsyncSafety("failing-disposal-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main() {
        await using first = open()
        await using second = open()
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    if (created.status !== "ready") throw new Error(created.reasons.join("; "));
    const quint = generateResourceTemporalProductQuint("failing_disposal_product", created.product);
    expect(quint).toContain("action release_reject_2");
    expect(quint).toContain("action release_reject_3");
    expect(quint).toContain("action enter_cleanup_throw");
    expect(quint).toContain("var active_failure: int");
    expect(quint).toContain("var failure_parent_2: int");
    expect(quint).toContain("var failure_parent_3: int");
    expect(quint).toContain("val suppressionIdentitySafe");
    expect(quint).toContain("suppressed_failure");
    expect(quint).toContain("val disposalSuppressionSafe");

    const directory = mkdtempSync(join(tmpdir(), "uneffect-disposal-suppression-"));
    try {
      const path = join(directory, "broken.qnt");
      writeFileSync(path, generateResourceTemporalProductQuint("broken_disposal_product", created.product, { dropSuppression: true }));
      const broken = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=broken_disposal_product", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=500", "--seed=0x756e6566"], { encoding: "utf8" });
      expect(broken.status).not.toBe(0);
      expect(`${broken.stdout}${broken.stderr}`).toMatch(/violation|counterexample/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
