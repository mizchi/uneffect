import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(source: string, run: (result: Result) => void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-defn-"));
  try {
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(join(directory, "index.ts"), source);
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"] },
      files: ["index.ts"],
    }));
    run(await checkCorsaProject({ configFile }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const named = (result: Result) => Object.fromEntries(result.summaries
  .map((item) => [item.functionName, item.effects.map(formatEffect).filter((name) => name === "Console").sort()]));

const evidenceOf = (result: Result, functionName: string) =>
  result.summaries.find((item) => item.functionName === functionName)?.evidence;

describe("definition-time work in a class body", () => {
  it("charges a static field initializer to the scope that declares the class, not to construction", async () => {
    await check(`export class Widget {
  static readonly banner = String(console.log("declared") ?? "w");
  size = 1;
}
export function build(): Widget { return new Widget(); }
`, (result) => {
      const rows = named(result);
      // The initializer runs once, where the declaration is evaluated.
      expect(rows["<module>"]).toEqual(["Console"]);
      // Constructing one runs the instance initializer only, so neither the constructor nor its callers log.
      expect(rows["Widget.constructor"]).toEqual([]);
      expect(rows.build).toEqual([]);
    });
  });

  it("charges a static block the same way", async () => {
    await check(`export class Widget {
  static { console.log("declared"); }
  size = 1;
}
export function build(): Widget { return new Widget(); }
`, (result) => {
      const rows = named(result);
      expect(rows["<module>"]).toEqual(["Console"]);
      expect(rows.build).toEqual([]);
    });
  });

  it("keeps an instance field initializer with construction", async () => {
    await check(`export class Widget {
  size = console.log("constructed") ?? 1;
}
export function build(): Widget { return new Widget(); }
`, (result) => {
      const rows = named(result);
      expect(rows["Widget.constructor"]).toEqual(["Console"]);
      expect(rows.build).toEqual(["Console"]);
      expect(rows["<module>"]).toBeUndefined();
    });
  });

  it("leaves a function created at declaration time owning its own body", async () => {
    await check(`export class Widget {
  static readonly handler = () => { console.log("called later"); };
  static { const later = () => { console.log("also later"); }; void later; }
  size = 1;
}
export function build(): Widget { return new Widget(); }
`, (result) => {
      const rows = named(result);
      // Creating a function at declaration time is not calling it, so its body stays its own boundary.
      expect(rows["<module>"] ?? []).toEqual([]);
      expect(rows.build).toEqual([]);
      expect(rows["<anonymous>"]).toEqual(["Console"]);
      expect(rows.later).toEqual(["Console"]);
    });
  });

  it("leaves a class built at declaration time owning its own construction", async () => {
    await check(`export class Outer {
  static readonly Inner = class { constructor() { console.log("constructed"); } };
  size = 1;
}
export function makeInner(): unknown { return new Outer.Inner(); }
`, (result) => {
      const rows = named(result);
      // Declaring the outer class allocates the inner class; it does not run the inner constructor.
      expect(rows["<module>"] ?? []).toEqual([]);
      expect(rows.constructor).toEqual(["Console"]);
      expect(rows["Outer.constructor"] ?? []).toEqual([]);
      // Constructing through a static property is not a link this path makes, which it says rather than proves.
      expect(evidenceOf(result, "makeInner")).toBe("unknown");
    });
  });

  it("walks a class nested in another class's definition-time region out to the scope that evaluates it", async () => {
    await check(`export let held: unknown;
export class Outer {
  static {
    class Inner {
      static readonly seed = String(console.log("declared") ?? "i");
      n = 1;
    }
    held = new Inner();
  }
  size = 1;
}
export function build(): Outer { return new Outer(); }
`, (result) => {
      const rows = named(result);
      // Evaluating the module declares Outer, which runs the static block, which declares Inner.
      expect(rows["<module>"]).toEqual(["Console"]);
      expect(rows["Outer.constructor"] ?? []).toEqual([]);
      expect(rows["Inner.constructor"] ?? []).toEqual([]);
      expect(rows.build).toEqual([]);
    });
  });

  it("charges a class declared inside a function stored in a static field to that function", async () => {
    await check(`export class Outer {
  static readonly factory = function make(): unknown {
    class Inner {
      static readonly seed = String(console.log("declared") ?? "i");
      n = 1;
    }
    return new Inner();
  };
  size = 1;
}
export function run(): unknown { return Outer.factory(); }
`, (result) => {
      const rows = named(result);
      // The declaration is re-evaluated on every call of `make`, and not at all when the module is evaluated.
      expect(rows["<module>"] ?? []).toEqual([]);
      expect(rows.make).toEqual(["Console"]);
      expect(rows["Inner.constructor"] ?? []).toEqual([]);
      // Calling through a static property is not a link this path makes, which it says rather than proves.
      expect(evidenceOf(result, "run")).toBe("unknown");
    });
  });

  it("charges an immediately invoked function in a static block to the declaring scope", async () => {
    await check(`export class Boot {
  static { (function start(): void { console.log("declared"); })(); }
  size = 1;
}
export function build(): Boot { return new Boot(); }
`, (result) => {
      const rows = named(result);
      // The call runs where the declaration is evaluated, while the body it calls keeps its own boundary.
      expect(rows["<module>"]).toEqual(["Console"]);
      expect(rows.start).toEqual(["Console"]);
      expect(rows["Boot.constructor"] ?? []).toEqual([]);
      expect(rows.build).toEqual([]);
    });
  });

  it("keeps a construction written inside a definition-time region with the constructor that runs", async () => {
    await check(`export class Outer {
  static readonly instance = new (class Payload { n = console.log("constructed") ?? 1; })();
  size = 1;
}
export function build(): Outer { return new Outer(); }
`, (result) => {
      const rows = named(result);
      // The inner instance field runs at construction; the construction merely happens to be written here.
      expect(rows["Payload.constructor"]).toEqual(["Console"]);
    });
  });

  it("does not claim a declaring scope it modelled only in part", async () => {
    await check(`export function trace<T>(value: T, _context: unknown): T {
  console.log("applied");
  return value;
}
export class Widget {
  @trace
  run(): number { return 1; }
  static readonly tag = String(1);
  size = 1;
}
export function build(): Widget { return new Widget(); }
`, (result) => {
      // Applying the decorator invokes it when the class is declared, and no call expression spells that.
      // Naming the region's other work while that stays invisible would be a proof the source does not support.
      expect(evidenceOf(result, "<module>")).toBe("unknown");
    });
  });

  it("charges a class declared inside a function to that function", async () => {
    await check(`export function make(): unknown {
  class Widget {
    static readonly banner = String(console.log("declared") ?? "w");
    size = 1;
  }
  return new Widget();
}
`, (result) => {
      const rows = named(result);
      expect(rows.make).toEqual(["Console"]);
      expect(rows["Widget.constructor"]).toEqual([]);
    });
  });
});
