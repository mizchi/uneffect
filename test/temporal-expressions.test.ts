import { describe, expect, it } from "vitest";
import {
  assertGuardedTemporalMapGets,
  generateQuintExpression,
  generateRuntimeAssertionExpression,
  generateRuntimeAssertionStatement,
  parseTemporalExpression,
  typeCheckTemporalExpression,
} from "../src/temporal-expressions.js";

describe("restricted TypeScript temporal expressions", () => {
  it("lowers one neutral AST to Quint and runtime JavaScript", () => {
    const expression = parseTemporalExpression("phase === 0 && !cancelled");
    expect(generateQuintExpression(expression)).toBe("phase == 0 and not(cancelled)");
    expect(generateRuntimeAssertionExpression(expression)).toBe("phase === 0 && !cancelled");
  });

  it("supports arithmetic and relational predicates", () => {
    const expression = parseTemporalExpression("epoch + 1 <= limit || ready");
    expect(generateQuintExpression(expression)).toBe("epoch + 1 <= limit or ready");
  });

  it("parses, types, and emits conditional temporal expressions", () => {
    const expression = parseTemporalExpression("armed ? value + 1 : value");
    const symbols = new Map([["armed", "bool"], ["value", "int"]] as const);
    expect(typeCheckTemporalExpression(expression, symbols)).toBe("int");
    expect(generateRuntimeAssertionExpression(expression)).toBe("armed ? value + 1 : value");
    expect(generateQuintExpression(expression)).toBe("if (armed) value + 1 else value");
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("armed ? value : false"), symbols)).toThrow(/matching branch types/);
  });

  it("rejects calls, untyped property access, and loose equality", () => {
    expect(() => parseTemporalExpression("check(value)")).toThrow(/unsupported temporal expression/);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("state.value === 1"), new Map([["state", "int"]]))).toThrow(/field access requires a record/);
    expect(() => parseTemporalExpression("phase == 0")).toThrow(/strict equality/);
  });

  it("can compile the same predicate into an optional runtime assertion", () => {
    const statement = generateRuntimeAssertionStatement(parseTemporalExpression("phase === 1"), "bad phase");
    const check = new Function("phase", statement);
    expect(() => check(1)).not.toThrow();
    expect(() => check(0)).toThrow("bad phase");
  });

  it("type-checks names and operators against an explicit symbol table", () => {
    const symbols = new Map([["phase", "int"], ["ready", "bool"]] as const);
    expect(typeCheckTemporalExpression(parseTemporalExpression("phase < 2 && ready"), symbols)).toBe("bool");
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("phase && ready"), symbols)).toThrow(/requires boolean operands/);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("missing === 0"), symbols)).toThrow(/unknown temporal symbol `missing`/);
  });

  it("lowers finite Set construction, membership, union, and quantification", () => {
    const expression = parseTemporalExpression("nodes.forall(node => owners.union(Set(2)).contains(node)) && owners.size() <= 2");
    const setOfInt = { kind: "set", element: "int" } as const;
    const symbols = new Map<string, "int" | "bool" | typeof setOfInt>([["nodes", setOfInt], ["owners", setOfInt]]);
    expect(typeCheckTemporalExpression(expression, symbols)).toBe("bool");
    expect(generateQuintExpression(expression)).toBe("nodes.forall(node => owners.union(Set(2)).contains(node)) and owners.size() <= 2");
    expect(generateRuntimeAssertionExpression(expression)).toBe("Array.from(nodes).every(node => new Set([...owners, ...new Set([2])]).has(node)) && owners.size <= 2");
    const check = new Function("nodes", "owners", `return ${generateRuntimeAssertionExpression(expression)}`);
    expect(check(new Set([1, 2]), new Set([1]))).toBe(true);
    expect(check(new Set([1, 3]), new Set([1]))).toBe(false);
  });

  it("rejects heterogeneous Sets and invalid finite quantifier predicates", () => {
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("Set(1, true)"), new Map())).toThrow(/same element type/);
    const sets = new Map([["nodes", { kind: "set", element: "int" } as const]]);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("nodes.forall(node => node + 1)"), sets)).toThrow(/boolean predicate/);
  });

  it("lowers total Map updates and finite key/value views without partial get", () => {
    const expression = parseTemporalExpression("epochs.put(2, 1).values().forall(epoch => epoch >= 0)");
    const mapType = { kind: "map", key: "int", value: "int" } as const;
    expect(typeCheckTemporalExpression(expression, new Map([["epochs", mapType]]))).toBe("bool");
    expect(generateQuintExpression(expression)).toBe("epochs.put(2, 1).keys().map(_uneffect_key => epochs.put(2, 1).get(_uneffect_key)).forall(epoch => epoch >= 0)");
    expect(generateRuntimeAssertionExpression(expression)).toBe("Array.from(new Set(new Map([...epochs, [2, 1]]).values())).every(epoch => epoch >= 0)");
    const check = new Function("epochs", `return ${generateRuntimeAssertionExpression(expression)}`);
    expect(check(new Map([[1, 0], [2, 0]]))).toBe(true);
    expect(check(new Map([[1, -1], [2, 0]]))).toBe(false);
  });

  it("lowers exact Set difference and Map key removal", () => {
    const setType = { kind: "set", element: "int" } as const;
    const mapType = { kind: "map", key: "int", value: "int" } as const;
    const setExpression = parseTemporalExpression("owners.exclude(Set(2))");
    const mapExpression = parseTemporalExpression("epochs.remove(2)");
    expect(typeCheckTemporalExpression(setExpression, new Map([["owners", setType]]))).toEqual(setType);
    expect(typeCheckTemporalExpression(mapExpression, new Map([["epochs", mapType]]))).toEqual(mapType);
    expect(generateQuintExpression(setExpression)).toBe("owners.exclude(Set(2))");
    expect(generateQuintExpression(mapExpression)).toBe("epochs.keys().exclude(Set(2)).mapBy(_uneffect_key => epochs.get(_uneffect_key))");
    expect(generateRuntimeAssertionExpression(setExpression)).toBe("new Set([...owners].filter(_uneffect_item => !new Set([2]).has(_uneffect_item)))");
    expect(generateRuntimeAssertionExpression(mapExpression)).toBe("new Map([...epochs].filter(([_uneffect_key]) => _uneffect_key !== 2))");
  });

  it("types and lowers Map size symmetrically with Set size", () => {
    const mapType = { kind: "map", key: "int", value: "int" } as const;
    const expression = parseTemporalExpression("epochs.size() > 0");
    expect(typeCheckTemporalExpression(expression, new Map([["epochs", mapType]]))).toBe("bool");
    expect(generateQuintExpression(expression)).toBe("epochs.size() > 0");
    expect(generateRuntimeAssertionExpression(expression)).toBe("epochs.size > 0");
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("count.size() > 0"), new Map([["count", "int"]]))).toThrow(/Set or Map/);
  });

  it("accepts typed guarded Map lookup and rejects unguarded partial lookup", () => {
    const mapType = { kind: "map", key: "int", value: "int" } as const;
    const guarded = parseTemporalExpression("epochs.keys().contains(1) && epochs.get(1) === 2");
    expect(typeCheckTemporalExpression(guarded, new Map([["epochs", mapType]]))).toBe("bool");
    expect(() => assertGuardedTemporalMapGets(guarded)).not.toThrow();
    expect(() => assertGuardedTemporalMapGets(parseTemporalExpression("epochs.get(1) === 2"))).toThrow(/Map\.get requires a conjunctive/);
    expect(generateQuintExpression(guarded)).toBe("epochs.keys().contains(1) and epochs.get(1) == 2");
    expect(generateRuntimeAssertionExpression(guarded)).toBe("new Set(epochs.keys()).has(1) && epochs.get(1) === 2");
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("Map([1, 2])"), new Map())).toThrow(/\[key, value\] pairs/);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("Map([[1, true], [2, 0]])"), new Map())).toThrow(/homogeneous key and value types/);
  });

  it("lowers typed records, field reads, and immutable spread updates", () => {
    const recordType = { kind: "record", fields: { owner: "int", valid: "bool" } } as const;
    const expression = parseTemporalExpression("({ ...lease, owner: 2 }).owner === 2 && lease.valid");
    expect(typeCheckTemporalExpression(expression, new Map([ ["lease", recordType] ]))).toBe("bool");
    expect(generateQuintExpression(expression)).toBe('lease.with("owner", 2).owner == 2 and lease.valid');
    expect(generateRuntimeAssertionExpression(expression)).toBe("({ ...lease, owner: 2 }).owner === 2 && lease.valid");
    const check = new Function("lease", `return ${generateRuntimeAssertionExpression(expression)}`);
    expect(check({ owner: 1, valid: true })).toBe(true);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("lease.missing"), new Map([ ["lease", recordType] ]))).toThrow(/unknown temporal record field `missing`/);
  });
});
