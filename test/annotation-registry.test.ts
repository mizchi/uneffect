import { describe, expect, it } from "vitest";
import { extractAnnotations, validateUneffectAnnotations } from "../src/support/annotations.js";

describe("annotation registry own entries", () => {
  it.each(["constructor", "toString", "__proto__"])("diagnoses unknown dialect %s without throwing", name => {
    for (const payload of ["", " payload"]) {
      const source = `/* uneffect:${name}${payload} */`;
      const diagnostics = validateUneffectAnnotations(source);
      expect(diagnostics).toMatchObject([{ kind: "unknown-dialect", directive: name }]);
      expect(source.slice(diagnostics[0]!.span.start, diagnostics[0]!.span.end)).toBe(name);
    }
  });

  it.each(["constructor", "toString", "__proto__"])("rejects unknown temporal clause %s with or without payload", name => {
    for (const payload of ["", " payload"]) {
      const source = `/* uneffect:temporal_contract ${name}${payload} */`;
      const diagnostics = validateUneffectAnnotations(source);
      expect(diagnostics).toMatchObject([{ kind: "unknown-directive", directive: name, dialect: "temporal_contract" }]);
      expect(source.slice(diagnostics[0]!.span.start, diagnostics[0]!.span.end)).toBe(name);
      expect(extractAnnotations(source, "temporal_requires")).toEqual([]);
    }
  });

  it.each(["constructor", "toString", "__proto__"])("preserves explicitly added directive %s in both syntaxes", name => {
    const source = `/* uneffect:${name} first */\n/* uneffect:\n ${name} second\n */`;
    expect(validateUneffectAnnotations(source, 0, [name])).toEqual([]);
    expect(extractAnnotations(source, name)).toEqual(["first", "second"]);
    expect(validateUneffectAnnotations(`/* uneffect:${name} */`, 0, [name]))
      .toMatchObject([{ kind: "missing-payload", directive: name }]);
  });
});
