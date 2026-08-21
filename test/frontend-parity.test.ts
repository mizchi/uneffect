import { describe, expect, it } from "vitest";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("TypeScript/Corsa neutral projection parity", () => {
  it("normalizes UTF-8 trivia and reports schema drift instead of treating it as parity", async () => {
    const files = { "unicode.ts": `/* uneffect: effect FsRead<"$CWD/データ/**"> */ export function read() {}` };
    const matching = await compareUneffectFrontends({ files });
    expect(matching).toMatchObject({ equivalent: true, schemaDrift: [] });

    const drift = await compareUneffectFrontends({ files, corsaSchemaVersion: 2 });
    expect(drift.equivalent).toBe(false);
    expect(drift.schemaDrift[0]?.message).toContain("unsupported Corsa frontend schema");

  });
});
