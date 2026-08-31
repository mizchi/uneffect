import ts from "typescript";
import { resourceProtocolCfgSchema, type ResourceProtocolBlock, type ResourceProtocolCfg, type ResourceProtocolModel, type ResourceProtocolTransition } from "./resource-protocol.js";

export interface ResourceTransitionSite {
  readonly node: ts.Node;
  readonly transitions: readonly ResourceProtocolTransition[];
}

export type ResourceProtocolTypeScriptLowering =
  | { readonly status: "exact"; readonly cfg: ResourceProtocolCfg }
  | { readonly status: "unknown"; readonly reason: "outside-function" | "unplaced-transition" | "unsupported-control-flow"; readonly node?: string };

export interface ResourceProtocolTypeScriptLoweringOptions {
  readonly budget?: { readonly name: string; readonly limit: number };
}

function nearestStatement(node: ts.Node, boundary: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return undefined;
}

/**
 * Lowers a deliberately small public-AST control-flow fragment. Operation
 * recognition stays in the caller; this function only places authenticated
 * resource transitions into structured basic blocks.
 */
export function lowerResourceProtocolCfgInFunction(
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  model: ResourceProtocolModel,
  sites: readonly ResourceTransitionSite[],
  options: ResourceProtocolTypeScriptLoweringOptions = {},
): ResourceProtocolTypeScriptLowering {
  if (!fn.body || !ts.isBlock(fn.body)) return { status: "unknown", reason: "outside-function" };
  const body = fn.body;
  const siteStatements = new Map<ResourceTransitionSite, ts.Statement>();
  for (const site of sites) {
    if (site.node.getSourceFile() !== source || site.node.getStart(source) < body.getStart(source) || site.node.getEnd() > body.getEnd()) {
      return { status: "unknown", reason: "outside-function", node: site.node.getText(source) };
    }
    const statement = nearestStatement(site.node, body);
    if (!statement) return { status: "unknown", reason: "unplaced-transition", node: site.node.getText(source) };
    siteStatements.set(site, statement);
  }
  const blocks = new Map<string, ResourceProtocolBlock>();
  const used = new Set<ResourceTransitionSite>();
  let serial = 0;
  const id = (kind: string, node?: ts.Node): string => `${kind}_${node?.getStart(source) ?? "synthetic"}_${serial++}`;
  const transitionsFor = (statement: ts.Statement): readonly ResourceProtocolTransition[] => {
    const selected = sites.filter((site) => siteStatements.get(site) === statement)
      .sort((left, right) => left.node.getStart(source) - right.node.getStart(source));
    for (const site of selected) used.add(site);
    return selected.flatMap((site) => site.transitions);
  };
  const exit = id("exit");
  blocks.set(exit, { id: exit, transitions: [], successors: [] });
  let unsupported: ts.Statement | undefined;

  const lowerSequence = (statements: readonly ts.Statement[], continuation: string): string => {
    let next = continuation;
    for (let index = statements.length - 1; index >= 0; index--) next = lowerStatement(statements[index]!, next);
    return next;
  };
  const lowerStatement = (statement: ts.Statement, continuation: string): string => {
    if (ts.isBlock(statement)) return lowerSequence(statement.statements, continuation);
    if (ts.isIfStatement(statement)) {
      const whenTrue = lowerStatement(statement.thenStatement, continuation);
      const whenFalse = statement.elseStatement ? lowerStatement(statement.elseStatement, continuation) : continuation;
      const blockId = id("if", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: [whenTrue, whenFalse] });
      return blockId;
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const blockId = id(ts.isReturnStatement(statement) ? "return" : "throw", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: [exit] });
      return blockId;
    }
    if (ts.isIterationStatement(statement, false) || ts.isTryStatement(statement) || ts.isSwitchStatement(statement)
      || ts.isLabeledStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)
      || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      unsupported ??= statement;
      return continuation;
    }
    const blockId = id("statement", statement);
    blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: [continuation] });
    return blockId;
  };

  const entry = lowerSequence(body.statements, exit);
  if (unsupported) return { status: "unknown", reason: "unsupported-control-flow", node: unsupported.getText(source) };
  const unplaced = sites.find((site) => !used.has(site));
  if (unplaced) return { status: "unknown", reason: "unplaced-transition", node: unplaced.node.getText(source) };
  return {
    status: "exact",
    cfg: {
      schema: resourceProtocolCfgSchema,
      model,
      entry,
      exits: [exit],
      blocks: [...blocks.values()],
      budget: options.budget ?? { name: "typescript-resource-cfg", limit: 256 },
    },
  };
}
