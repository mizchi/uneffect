import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";

const declarations = `
  declare const trustedTypes: {
    emptyScript: TrustedScript;
    createPolicy(name: string, rules: { createScript(input: string): string }): { createScript(input: string): TrustedScript };
  };
  type TrustedScript = string & { readonly __trustedScript: unique symbol };
`;

async function diagnostics(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-trusted-script-")), fileName = join(directory, "main.ts");
  try {
    writeFileSync(fileName, `${declarations}\n${body}`);
    return (await checkFiles([fileName], { requireAnnotations: false })).diagnostics
      .filter((item) => "domain" in item && item.domain === "trusted-types");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("TrustedScript sinks", () => {
  it("rejects strings at eval and timer script sinks but not callable timers", async () => {
    const result = await diagnostics(`
      eval(userInput);
      setTimeout(userInput, 0);
      setInterval("poll()", 100);
      setTimeout(() => work(), 0);
      declare const userInput: string; declare function work(): void;
    `);
    expect(result).toHaveLength(3);
    expect(result.every((item) => item.kind === "untrusted-script-sink")).toBe(true);
  });

  it("accepts values created by a directly resolved Trusted Types policy and emptyScript", async () => {
    expect(await diagnostics(`
      const policy = trustedTypes.createPolicy("app", { createScript(input) { return input === "boot()" ? input : "" } });
      const boot = policy.createScript("boot()");
      eval(boot);
      setTimeout(trustedTypes.emptyScript, 0);
    `)).toEqual([]);
  });

  it("rejects casts and same-shaped custom policy objects", async () => {
    const result = await diagnostics(`
      declare const input: string;
      eval(input as TrustedScript);
      const fake = { createScript(value: string) { return value as TrustedScript } };
      eval(fake.createScript(input));
    `);
    expect(result).toHaveLength(2);
  });

  it("checks inline script text properties", async () => {
    const result = await diagnostics(`
      const script = document.createElement("script");
      script.text = "alert(1)";
      const policy = trustedTypes.createPolicy("app", { createScript(input) { return input } });
      script.textContent = policy.createScript("boot()");
    `);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sink: "HTMLScriptElement.text" });
  });

  it("checks the Function constructor and rejects a shadowed trustedTypes factory", async () => {
    const result = await diagnostics(`
      new Function("return secret");
      function forged(input: string) {
        const trustedTypes = { createPolicy() { return { createScript(value: string) { return value as TrustedScript } } } };
        eval(trustedTypes.createPolicy().createScript(input));
      }
    `);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sink: "Function" });
  });
});
