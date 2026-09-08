import type { Expression, FunctionBody, Statement } from "oxc-parser";
import { solveBasicBlockFixedPoint, type BasicBlock } from "../cfg/index.js";
import type { LogicExpression } from "./logic-contracts.js";
import type { NativeScalar } from "./native-scalars.js";

export interface NativeReturnPath {
  readonly span: { start: number; end: number };
  readonly result: NativeScalar;
  readonly conditions: readonly LogicExpression[];
}
type Paths = ReadonlyMap<string, readonly LogicExpression[]>;

/** Acyclic scalar CFG; joins retain every path, with explicit bounds on enumeration.
 * The expression callback receives null for structural validation, or established path
 * conditions for arithmetic verification. A predicate is checked before it is assumed.
 */
export function lowerNativeReturnPaths(body: FunctionBody, expression: (node: Expression, conditions: readonly LogicExpression[] | null) => NativeScalar): NativeReturnPath[] {
  const blocks: BasicBlock<Paths>[] = [];
  const returns: Array<{ id: string; span: { start: number; end: number }; node: Expression }> = [];
  const bounded = (paths: Paths): Paths => {
    if (paths.size > 256) throw new Error("native contract path budget exceeded (256 paths per block)");
    return paths;
  };
  const append = (paths: Paths, condition: LogicExpression): Paths => bounded(new Map([...paths.values()].map(path => {
    const next = [...path, condition];
    return [JSON.stringify(next), next];
  })));
  const block = (edges: string[], transfer: BasicBlock<Paths>["transfer"]): string => {
    if (blocks.length >= 512) throw new Error("native contract CFG budget exceeded (512 blocks)");
    const id = `scalar:${blocks.length}`;
    blocks.push({ id, edges: edges.map(to => ({ to, completion: "normal" })), transfer });
    return id;
  };
  const exit = block([], () => []);
  const statements = (nodes: readonly Statement[], next: string): string => {
    for (const node of [...nodes].reverse()) next = statement(node, next);
    return next;
  };
  const statement = (node: Statement, next: string): string => {
    if (node.type === "BlockStatement") return statements(node.body, next);
    if (node.type === "EmptyStatement") return next;
    if (node.type === "VariableDeclaration" && node.kind === "const") return next;
    if (node.type === "ReturnStatement") {
      if (!node.argument) throw new Error("native contract body must return a scalar expression");
      expression(node.argument, null);
      const id = block([], () => []);
      returns.push({ id, span: { start: node.start, end: node.end }, node: node.argument });
      return id;
    }
    if (node.type === "IfStatement") {
      const test = expression(node.test, null);
      if (test.kind !== "boolean") throw new Error("native contract conditions must be Boolean");
      const yes = statement(node.consequent, next), no = node.alternate ? statement(node.alternate, next) : next;
      const condition = test.expression;
      return block([...new Set([yes, no])], paths => {
        for (const conditions of paths.values()) expression(node.test, conditions);
        return condition.kind === "boolean"
        ? [{ to: condition.value ? yes : no, value: paths }]
        : [{ to: yes, value: append(paths, condition) }, { to: no, value: append(paths, { kind: "unary", operator: "not", operand: condition }) }];
      });
    }
    throw new Error(`native contract control flow does not support ${node.type}`);
  };
  const entry = statements(body.body, exit);
  const solved = solveBasicBlockFixedPoint<Paths>({ entry, blocks, initial: new Map([["[]", []]]),
    budget: { name: "native-contract-paths", limit: 4096 },
    lattice: {
      bottom: () => new Map(),
      equivalent: (left, right) => left.size === right.size && [...left.keys()].every(key => right.has(key)),
      join: (left, right) => ({ status: "joined", value: bounded(new Map([...left, ...right])) }),
    },
  });
  if (solved.status !== "converged") throw new Error(`native contract CFG ${solved.reason}: ${solved.detail}`);
  if (solved.states.get(exit)?.size) throw new Error("native contract body may fall through without returning a scalar");
  const paths = returns.sort((left, right) => left.span.start - right.span.start).flatMap(({ id, span, node }) =>
    [...(solved.states.get(id)?.values() ?? [])].map(conditions => ({ span, result: expression(node, conditions), conditions })));
  if (!paths.length) throw new Error("native contract body has no reachable scalar returns");
  return paths;
}
