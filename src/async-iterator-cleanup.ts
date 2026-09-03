import ts from "typescript";
import type { ResourceProtocolModel } from "./resource-protocol.js";
import { analyzeResourceCallableSummaries } from "./resource-callable-typescript.js";
import type { ResourceCallableSummary } from "./resource-protocol.js";
import { standardLibraryOperation } from "./frontend-adapter.js";

export type AsyncIteratorExit = "exhausted" | "break" | "return" | "throw" | "manual-return" | "manual-open" | "manual-exhausted" | "manual-escape" | "manual-consume" | "manual-transfer" | "delegated-return" | "delegated-throw";
export type AsyncIteratorCleanupUnknown = "abrupt-through-finally" | "manual-iterator-not-closed" | "unawaited-iterator-operation" | "conditional-manual-protocol" | "iterator-passed-to-call" | "unstable-iterator-property" | "unstable-iterator-alias" | "delegation-step-failure";

export interface AsyncIteratorCleanupScenario {
  readonly exit: AsyncIteratorExit;
  readonly model: ResourceProtocolModel;
  readonly close?: {
    readonly lookupLane: "inline";
    readonly resultLane: "inline" | "microtask-if-present" | "microtask" | "unobserved";
    readonly method: "return-if-present" | "return";
    readonly propertyAccessMayInvokeUserCode: true;
    readonly failure: "throw" | "reject";
    readonly span: { readonly start: number; readonly end: number };
  };
}

export interface AsyncIteratorCleanup {
  readonly protocol: "sync" | "async";
  readonly owner: string;
  readonly resource: string;
  readonly iterable: string;
  readonly loopSpan: { readonly start: number; readonly end: number };
  readonly coverage: "reviewed-explicit-completions" | "reviewed-manual-protocol" | "reviewed-yield-star-delegation";
  readonly unknownReasons: readonly AsyncIteratorCleanupUnknown[];
  readonly scenarios: readonly AsyncIteratorCleanupScenario[];
}

function functionName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return "<module>";
}

function breakTargetsLoop(node: ts.BreakStatement, loop: ts.IterationStatement): boolean {
  if (node.label) {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isLabeledStatement(current) && current.label.text === node.label.text) {
        return current.statement.pos <= loop.pos && loop.end <= current.statement.end;
      }
    }
    return false;
  }
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) return false;
  }
  return true;
}

function throwEscapesLoop(node: ts.Node, loop: ts.IterationStatement): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isTryStatement(current) && current.tryBlock.pos <= node.pos && node.end <= current.tryBlock.end && current.catchClause) return false;
  }
  return true;
}

function continueTargetsLoop(node: ts.ContinueStatement, loop: ts.IterationStatement): boolean {
  if (node.label) {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isLabeledStatement(current) && current.label.text === node.label.text) {
        return current.statement.pos <= loop.pos && loop.end <= current.statement.end;
      }
    }
    return false;
  }
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (current === loop) return true;
    if (ts.isIterationStatement(current, false)) return false;
  }
  return false;
}

function mayImplicitlyThrow(node: ts.Node): boolean {
  return ts.isCallExpression(node) || ts.isNewExpression(node)
    || ts.isTaggedTemplateExpression(node) || ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node);
}

function unconditionalFinallyExit(block: ts.Block, loop: ts.ForOfStatement): AsyncIteratorExit | "continue" | undefined {
  for (const statement of block.statements) {
    if (ts.isReturnStatement(statement)) return "return";
    if (ts.isThrowStatement(statement)) return "throw";
    if (ts.isBreakStatement(statement) && breakTargetsLoop(statement, loop)) return "break";
    if (ts.isContinueStatement(statement) && continueTargetsLoop(statement, loop)) return "continue";
  }
  return undefined;
}

function projectAbruptExitThroughFinally(
  node: ts.Node,
  loop: ts.ForOfStatement,
  initial: AsyncIteratorExit,
): AsyncIteratorExit | undefined {
  let exit: AsyncIteratorExit | "continue" = initial;
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (!ts.isTryStatement(current) || !current.finallyBlock
      || current.finallyBlock.pos <= node.pos && node.end <= current.finallyBlock.end) continue;
    exit = unconditionalFinallyExit(current.finallyBlock, loop) ?? exit;
  }
  return exit === "continue" ? undefined : exit;
}

function crossesFinally(node: ts.Node, loop: ts.ForOfStatement): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (!ts.isTryStatement(current) || !current.finallyBlock
      || current.finallyBlock.pos <= node.pos && node.end <= current.finallyBlock.end) continue;
    let resumesLoop = false;
    const scan = (child: ts.Node): void => {
      if (resumesLoop || child !== current!.finallyBlock && ts.isFunctionLike(child)) return;
      if (ts.isContinueStatement(child) && continueTargetsLoop(child, loop)) { resumesLoop = true; return; }
      ts.forEachChild(child, scan);
    };
    scan(current.finallyBlock);
    if (resumesLoop) return true;
  }
  return false;
}

function scenario(resource: string, loop: ts.ForOfStatement, exit: AsyncIteratorExit, at: number): AsyncIteratorCleanupScenario {
  const abrupt = exit !== "exhausted";
  return {
    exit,
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: resource, label: loop.expression.getText(), kind: "AsyncIterator", initialState: "available", requiredTerminalStates: ["consumed", "released"] }],
      transitions: [{ kind: abrupt ? "release" : "consume", resource, at, evidence: "exact" }],
    },
    ...(abrupt ? { close: { lookupLane: "inline" as const, resultLane: "microtask-if-present" as const,
      method: "return-if-present" as const, propertyAccessMayInvokeUserCode: true as const, failure: "reject" as const,
      span: { start: at, end: at + (exit === "break" ? 5 : exit === "return" ? 6 : 5) } } } : {}),
  };
}

/** Extracts the reviewed `for await...of` IteratorClose fragment. */
export function analyzeAsyncIteratorCleanup(source: ts.SourceFile): readonly AsyncIteratorCleanup[] {
  const cleanups: AsyncIteratorCleanup[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      const resource = `async-iterator:${source.fileName}:${node.getStart(source)}`;
      const exits = new Map<AsyncIteratorExit, number>([["exhausted", node.getEnd()]]);
      const unknownReasons = new Set<"abrupt-through-finally">();
      const scan = (child: ts.Node): void => {
        if (child !== node.statement && ts.isFunctionLike(child)) return;
        const exit = ts.isBreakStatement(child) && breakTargetsLoop(child, node) ? "break"
          : ts.isReturnStatement(child) ? "return"
          : ts.isThrowStatement(child) && throwEscapesLoop(child, node) ? "throw" : undefined;
        if (exit && crossesFinally(child, node)) unknownReasons.add("abrupt-through-finally");
        else if (exit) {
          const projected = projectAbruptExitThroughFinally(child, node, exit);
          if (projected) exits.set(projected, child.getStart(source));
        }
        else if (mayImplicitlyThrow(child) && throwEscapesLoop(child, node) && !crossesFinally(child, node)
          && !exits.has("throw")) exits.set("throw", child.getStart(source));
        ts.forEachChild(child, scan);
      };
      scan(node.statement);
      cleanups.push({
        protocol: "async", owner: functionName(node), resource, iterable: node.expression.getText(source),
        loopSpan: { start: node.getStart(source), end: node.getEnd() },
        coverage: "reviewed-explicit-completions",
        unknownReasons: [...unknownReasons],
        scenarios: [...exits].map(([exit, at]) => scenario(resource, node, exit, at)),
      });
      ts.forEachChild(node.statement, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return cleanups;
}

function unwrapped(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

const synchronousIterableConsumers = new Set([
  "ArrayConstructor#from", "ArrayConstructor#fromAsync", "ObjectConstructor#fromEntries",
  "PromiseConstructor#all", "PromiseConstructor#allSettled", "PromiseConstructor#any", "PromiseConstructor#race",
  "ObjectConstructor#groupBy", "MapConstructor#groupBy",
]);
const synchronousIterableConstructors = new Set([
  "SetConstructor", "MapConstructor", "WeakSetConstructor", "WeakMapConstructor",
  "Int8ArrayConstructor", "Uint8ArrayConstructor", "Uint8ClampedArrayConstructor", "Int16ArrayConstructor",
  "Uint16ArrayConstructor", "Int32ArrayConstructor", "Uint32ArrayConstructor", "Float32ArrayConstructor",
  "Float64ArrayConstructor", "BigInt64ArrayConstructor", "BigUint64ArrayConstructor",
]);

/** A reviewed ECMAScript operation that takes ownership of argument zero's iterator protocol. */
function isStandardIteratorConsumer(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  argumentIndex: number,
  protocol: "sync" | "async",
): boolean {
  if (argumentIndex !== 0) return false;
  const operation = standardLibraryOperation(checker, call);
  return protocol === "async"
    ? operation === "ArrayConstructor#fromAsync"
    : synchronousIterableConsumers.has(operation ?? "");
}

function isStandardIteratorConstructConsumer(
  checker: ts.TypeChecker,
  call: ts.NewExpression,
  argumentIndex: number,
  protocol: "sync" | "async",
): boolean {
  return protocol === "sync" && argumentIndex === 0
    && synchronousIterableConstructors.has(standardLibraryOperation(checker, call) ?? "");
}

function awaitedCall(node: ts.CallExpression): boolean {
  let current: ts.Expression = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent);
}

function isLibraryAsyncIterator(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const next = checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next");
  return next?.declarations?.some((declaration) => {
    const name = declaration.getSourceFile().fileName.replaceAll("\\", "/");
    return /\/lib\.(?:es\d+|esnext)\.(?:asynciterable|asyncgenerator)\.d\.ts$/.test(name);
  }) ?? false;
}

function isLibrarySynchronousIterator(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const next = checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next");
  return next?.declarations?.some((declaration) => {
    const name = declaration.getSourceFile().fileName.replaceAll("\\", "/");
    return /\/lib\.es2015\.(?:iterable|generator)\.d\.ts$/.test(name);
  }) ?? false;
}

function isLibraryAsyncIterable(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  return checker.getPropertiesOfType(checker.getTypeAtLocation(expression)).some((property) =>
    property.name.startsWith("__@asyncIterator@") && (property.declarations?.some((declaration) => {
      const name = declaration.getSourceFile().fileName.replaceAll("\\", "/");
      return /\/lib\.(?:es\d+|esnext)\.asynciterable\.d\.ts$/.test(name);
    }) ?? false));
}

function isLibrarySynchronousIterable(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  return checker.getPropertiesOfType(checker.getTypeAtLocation(expression)).some((property) =>
    property.name.startsWith("__@iterator@") && (property.declarations?.some((declaration) => {
      const name = declaration.getSourceFile().fileName.replaceAll("\\", "/");
      return /\/lib\.es2015\.iterable\.d\.ts$/.test(name);
    }) ?? false));
}

function immediatelyProtectedByTry(declaration: ts.VariableDeclaration, statement: ts.TryStatement): boolean {
  let acquisition: ts.Node = declaration;
  while (acquisition.parent && !ts.isStatement(acquisition)) acquisition = acquisition.parent;
  if (!ts.isStatement(acquisition) || acquisition.parent !== statement.parent) return false;
  const statements = ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent) ? statement.parent.statements : undefined;
  if (!statements) return false;
  const acquisitionIndex = statements.indexOf(acquisition), tryIndex = statements.indexOf(statement);
  return acquisitionIndex >= 0 && tryIndex === acquisitionIndex + 1;
}

function conditionallyExecuted(node: ts.Node, declaration: ts.VariableDeclaration): boolean {
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  let child: ts.Node = node;
  for (let current = node.parent; current && current !== owner; child = current, current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)
      || ts.isIterationStatement(current, false)
      || ts.isTryStatement(current) && (child !== current.finallyBlock || !immediatelyProtectedByTry(declaration, current))
      || ts.isCatchClause(current)
      || ts.isBinaryExpression(current) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) return true;
    if (ts.isFunctionLike(current)) return true;
  }
  return false;
}

function directIfBranch(node: ts.Node): { statement: ts.IfStatement; side: "then" | "else" } | undefined {
  let current = node;
  while (current.parent && (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent) || ts.isExpressionStatement(current.parent))) current = current.parent;
  if (ts.isBlock(current.parent)) {
    if (current.parent.statements.length !== 1 || current.parent.statements[0] !== current) return undefined;
    current = current.parent;
  }
  const parent = current.parent;
  if (!ts.isIfStatement(parent) || !parent.elseStatement) return undefined;
  if (parent.thenStatement === current) return { statement: parent, side: "then" };
  if (parent.elseStatement === current) return { statement: parent, side: "else" };
  return undefined;
}

function containingStatement(node: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isStatement(current)) return current;
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function directBranchStatements(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? [...statement.statements] : [statement];
}

function containsOwnerExit(node: ts.Node): boolean {
  let found = false;
  const scan = (child: ts.Node): void => {
    if (found || child !== node && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) { found = true; return; }
    ts.forEachChild(child, scan);
  };
  scan(node);
  return found;
}

function containsOwnerReturn(node: ts.Node): boolean {
  let found = false;
  const scan = (child: ts.Node): void => {
    if (found || child !== node && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child)) { found = true; return; }
    ts.forEachChild(child, scan);
  };
  scan(node);
  return found;
}

interface ManualIteratorOperation {
  kind: "use" | "consume" | "release" | "transfer" | "escape";
  node: ts.Node;
  at?: number;
  awaited: boolean;
  conditional: boolean;
  evidence?: "exact" | "trusted" | "unknown";
  uncontractedCall?: boolean;
  unstableProperty?: boolean;
  unstableAlias?: boolean;
  naturalExhaustion?: boolean;
}

/** Normalize reviewed branch joins before projecting them to the linear protocol IR. */
function normalizeManualIteratorBranches(
  operations: ManualIteratorOperation[],
  declaration: ts.VariableDeclaration,
): void {
  const branchReleases = new Map<ts.IfStatement, Map<"then" | "else", ManualIteratorOperation>>();
  operations.forEach((operation) => {
    if (operation.kind !== "release") return;
    const branch = directIfBranch(operation.node);
    if (!branch) return;
    const sides = branchReleases.get(branch.statement) ?? new Map<"then" | "else", ManualIteratorOperation>();
    sides.set(branch.side, operation);
    branchReleases.set(branch.statement, sides);
  });
  const pairedReleases = new Set<ManualIteratorOperation>();
  const collapsedReleases: ManualIteratorOperation[] = [];
  for (const [statement, sides] of branchReleases) {
    const left = sides.get("then"), right = sides.get("else");
    if (!left || !right || !left.awaited || !right.awaited) continue;
    const evidence = left.evidence === "unknown" || right.evidence === "unknown" ? "unknown" as const
      : left.evidence === "trusted" || right.evidence === "trusted" ? "trusted" as const : "exact" as const;
    pairedReleases.add(left);
    pairedReleases.add(right);
    collapsedReleases.push({
      kind: "release", node: statement, awaited: true,
      conditional: conditionallyExecuted(statement, declaration), evidence,
    });
  }
  if (pairedReleases.size > 0) operations.splice(0, operations.length,
    ...operations.filter((operation) => !pairedReleases.has(operation)), ...collapsedReleases);

  const acquisitionStatement = containingStatement(declaration);
  const acquisitionBlock = acquisitionStatement?.parent;
  if (!acquisitionStatement || !acquisitionBlock || !ts.isBlock(acquisitionBlock) && !ts.isSourceFile(acquisitionBlock)) return;
  const acquisitionIndex = acquisitionBlock.statements.indexOf(acquisitionStatement);
  const guardReleases = new Set<ManualIteratorOperation>();
  const inspectExitRegion = (
    region: ts.Node,
    statements: readonly ts.Statement[],
    fallthroughRelease: ManualIteratorOperation,
    returnOnly = false,
  ): boolean => {
    if (!(returnOnly ? containsOwnerReturn(region) : containsOwnerExit(region))) return false;
    const abruptIndex = statements.findIndex((item) => ts.isReturnStatement(item) || !returnOnly && ts.isThrowStatement(item));
    const guarded = operations.find((operation) => operation !== fallthroughRelease && operation.kind === "release"
      && operation.conditional && statements.includes(containingStatement(operation.node)!)
      && statements.indexOf(containingStatement(operation.node)!) < abruptIndex);
    if (abruptIndex >= 0 && guarded) { guardReleases.add(guarded); return false; }
    return true;
  };
  for (const fallthroughRelease of operations.filter((operation) => operation.kind === "release" && !operation.conditional)) {
    const releaseStatement = containingStatement(fallthroughRelease.node);
    if (!releaseStatement || releaseStatement.parent !== acquisitionBlock) continue;
    const releaseIndex = acquisitionBlock.statements.indexOf(releaseStatement);
    if (releaseIndex <= acquisitionIndex) continue;
    let bypassesClose = false;
    for (const previous of acquisitionBlock.statements.slice(acquisitionIndex + 1, releaseIndex)) {
      if (ts.isIfStatement(previous)) {
        for (const branch of [previous.thenStatement, previous.elseStatement].filter((item): item is ts.Statement => !!item)) {
          bypassesClose ||= inspectExitRegion(branch, directBranchStatements(branch), fallthroughRelease);
        }
      } else if (ts.isSwitchStatement(previous)) {
        for (const clause of previous.caseBlock.clauses) {
          bypassesClose ||= inspectExitRegion(clause, [...clause.statements], fallthroughRelease);
        }
      } else if (ts.isTryStatement(previous)) {
        bypassesClose ||= inspectExitRegion(previous.tryBlock, [...previous.tryBlock.statements], fallthroughRelease, !!previous.catchClause);
        if (previous.catchClause) bypassesClose ||= inspectExitRegion(previous.catchClause.block,
          [...previous.catchClause.block.statements], fallthroughRelease);
        if (previous.finallyBlock) bypassesClose ||= inspectExitRegion(previous.finallyBlock,
          [...previous.finallyBlock.statements], fallthroughRelease);
      } else if (containsOwnerExit(previous)) bypassesClose = true;
    }
    if (bypassesClose) {
      fallthroughRelease.conditional = true;
      fallthroughRelease.evidence = "unknown";
    }
  }
  if (guardReleases.size > 0) operations.splice(0, operations.length,
    ...operations.filter((operation) => !guardReleases.has(operation)));
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function stripProtocolExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAwaitExpression(expression)) expression = expression.expression;
  return expression;
}

function canonicalExhaustionLoop(call: ts.CallExpression): ts.WhileStatement | undefined {
  let loop: ts.WhileStatement | undefined;
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (ts.isWhileStatement(current)) { loop = current; break; }
    if (ts.isFunctionLike(current)) return undefined;
  }
  if (!loop) return undefined;
  const condition = stripProtocolExpression(loop.expression);
  let done: ts.Expression | undefined;
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
    done = stripProtocolExpression(condition.operand);
  } else if (ts.isBinaryExpression(condition)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(condition.operatorToken.kind)) {
    const left = stripProtocolExpression(condition.left), right = stripProtocolExpression(condition.right);
    if (right.kind === ts.SyntaxKind.FalseKeyword) done = left;
    else if (left.kind === ts.SyntaxKind.FalseKeyword) done = right;
  }
  if (!done) return undefined;
  if (!ts.isPropertyAccessExpression(done) || done.name.text !== "done"
    || stripProtocolExpression(done.expression) !== call) return undefined;
  let abrupt = false;
  const scan = (node: ts.Node): void => {
    if (abrupt || node !== loop!.statement && ts.isFunctionLike(node)) return;
    if (ts.isBreakStatement(node) && breakTargetsLoop(node, loop!)) abrupt = true;
    else if (ts.isReturnStatement(node) || ts.isThrowStatement(node) && throwEscapesLoop(node, loop!)) abrupt = true;
    else ts.forEachChild(node, scan);
  };
  scan(loop.statement);
  return abrupt ? undefined : loop;
}

function canonicalBoundDoneBreak(call: ts.CallExpression, checker: ts.TypeChecker): ts.BreakStatement | undefined {
  let value: ts.Node = call;
  while (value.parent && (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent)
    || ts.isAsExpression(value.parent) || ts.isTypeAssertionExpression(value.parent)
    || ts.isNonNullExpression(value.parent)) && value.parent.expression === value) value = value.parent;
  const declaration = value.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== value
    || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return undefined;
  const block = statement.parent, loop = block.parent;
  const infinite = ts.isWhileStatement(loop) && stripProtocolExpression(loop.expression).kind === ts.SyntaxKind.TrueKeyword
    || ts.isForStatement(loop) && (!loop.condition || stripProtocolExpression(loop.condition).kind === ts.SyntaxKind.TrueKeyword)
    || ts.isDoStatement(loop) && stripProtocolExpression(loop.expression).kind === ts.SyntaxKind.TrueKeyword;
  if (!infinite || !(ts.isWhileStatement(loop) || ts.isForStatement(loop) || ts.isDoStatement(loop))) return undefined;
  const index = block.statements.indexOf(statement), guard = block.statements[index + 1];
  if (index < 0 || !guard || !ts.isIfStatement(guard) || guard.elseStatement) return undefined;
  let doneCondition = stripProtocolExpression(guard.expression);
  if (ts.isBinaryExpression(doneCondition)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(doneCondition.operatorToken.kind)) {
    const left = stripProtocolExpression(doneCondition.left), right = stripProtocolExpression(doneCondition.right);
    if (right.kind === ts.SyntaxKind.TrueKeyword) doneCondition = left;
    else if (left.kind === ts.SyntaxKind.TrueKeyword) doneCondition = right;
    else return undefined;
  }
  let expectedDone: ts.Symbol | undefined;
  if (ts.isIdentifier(declaration.name)) {
    const resultSymbol = checker.getSymbolAtLocation(declaration.name);
    if (ts.isPropertyAccessExpression(doneCondition) && doneCondition.name.text === "done"
      && ts.isIdentifier(stripProtocolExpression(doneCondition.expression))) {
      const receiver = stripProtocolExpression(doneCondition.expression) as ts.Identifier;
      if (checker.getSymbolAtLocation(receiver) !== resultSymbol) return undefined;
    } else return undefined;
  } else if (ts.isObjectBindingPattern(declaration.name)) {
    const element = declaration.name.elements.find((candidate) => {
      const key = candidate.propertyName ?? candidate.name;
      return !candidate.dotDotDotToken && ts.isIdentifier(candidate.name)
        && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "done";
    });
    if (!element || !ts.isIdentifier(doneCondition)) return undefined;
    expectedDone = checker.getSymbolAtLocation(element.name);
    if (!expectedDone || checker.getSymbolAtLocation(doneCondition) !== expectedDone) return undefined;
  } else return undefined;
  const breakStatement = ts.isBreakStatement(guard.thenStatement) ? guard.thenStatement
    : ts.isBlock(guard.thenStatement) && guard.thenStatement.statements.length === 1
      && ts.isBreakStatement(guard.thenStatement.statements[0]) ? guard.thenStatement.statements[0] : undefined;
  if (!breakStatement || !breakTargetsLoop(breakStatement, loop)) return undefined;
  let alternateAbrupt = false;
  const scan = (node: ts.Node): void => {
    if (alternateAbrupt || node === breakStatement || node !== block && ts.isFunctionLike(node)) return;
    if (ts.isBreakStatement(node) && breakTargetsLoop(node, loop)) alternateAbrupt = true;
    else if (ts.isReturnStatement(node) || ts.isThrowStatement(node) && throwEscapesLoop(node, loop)) alternateAbrupt = true;
    else ts.forEachChild(node, scan);
  };
  scan(block);
  return alternateAbrupt ? undefined : breakStatement;
}

function doneIsFalseForSymbol(expression: ts.Expression, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  expression = stripProtocolExpression(expression);
  let done: ts.Expression | undefined;
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    done = stripProtocolExpression(expression.operand);
  } else if (ts.isBinaryExpression(expression)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(expression.operatorToken.kind)) {
    const left = stripProtocolExpression(expression.left), right = stripProtocolExpression(expression.right);
    if (right.kind === ts.SyntaxKind.FalseKeyword) done = left;
    else if (left.kind === ts.SyntaxKind.FalseKeyword) done = right;
  }
  if (!done || !ts.isPropertyAccessExpression(done) || done.name.text !== "done") return false;
  const receiver = stripProtocolExpression(done.expression);
  return ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver) === symbol;
}

function canonicalForResultLoop(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): { loop: ts.ForStatement; updateCall: ts.CallExpression } | undefined {
  let value: ts.Node = call;
  while (value.parent && (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent)
    || ts.isAsExpression(value.parent) || ts.isTypeAssertionExpression(value.parent)
    || ts.isNonNullExpression(value.parent)) && value.parent.expression === value) value = value.parent;
  const declaration = value.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== value
    || !ts.isIdentifier(declaration.name) || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Let) === 0 || declaration.parent.declarations.length !== 1
    || !ts.isForStatement(declaration.parent.parent)) return undefined;
  const loop = declaration.parent.parent, resultSymbol = checker.getSymbolAtLocation(declaration.name);
  if (!resultSymbol || !loop.condition || !doneIsFalseForSymbol(loop.condition, resultSymbol, checker) || !loop.incrementor) return undefined;
  const increment = stripProtocolExpression(loop.incrementor);
  if (!ts.isBinaryExpression(increment) || increment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    || !ts.isIdentifier(stripProtocolExpression(increment.left))
    || checker.getSymbolAtLocation(stripProtocolExpression(increment.left)) !== resultSymbol) return undefined;
  const update = stripProtocolExpression(increment.right);
  if (!ts.isCallExpression(update)) return undefined;
  const callee = unwrapped(update.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "next") return undefined;
  let abrupt = false;
  const scan = (node: ts.Node): void => {
    if (abrupt || node !== loop.statement && ts.isFunctionLike(node)) return;
    if (ts.isBreakStatement(node) && breakTargetsLoop(node, loop)) abrupt = true;
    else if (ts.isReturnStatement(node) || ts.isThrowStatement(node) && throwEscapesLoop(node, loop)) abrupt = true;
    else ts.forEachChild(node, scan);
  };
  scan(loop.statement);
  return abrupt ? undefined : { loop, updateCall: update };
}

/** Shared TypeChecker-backed manual Iterator/AsyncIterator protocol analysis. */
function analyzeIteratorProtocolCleanupInProgram(
  program: ts.Program,
  source: ts.SourceFile,
  protocol: "sync" | "async",
  suppliedCallableSummaries?: ReadonlyMap<string, ResourceCallableSummary>,
): readonly AsyncIteratorCleanup[] {
  const checker = program.getTypeChecker();
  const cleanups = protocol === "async" ? [...analyzeAsyncIteratorCleanup(source)] : [];
  const callableSummaries = suppliedCallableSummaries
    ?? new Map(analyzeResourceCallableSummaries(program).summaries.map((summary) => [summary.id, summary] as const));
  const collectDelegations = (node: ts.Node): void => {
    if (ts.isYieldExpression(node) && node.asteriskToken && node.expression
      && (protocol === "async" ? isLibraryAsyncIterable(checker, node.expression) : isLibrarySynchronousIterable(checker, node.expression))) {
      let ownerNode: ts.Node | undefined = node.parent;
      while (ownerNode && !ts.isFunctionLike(ownerNode)) ownerNode = ownerNode.parent;
      const generatorOwner = ownerNode && (ts.isFunctionDeclaration(ownerNode)
        || ts.isFunctionExpression(ownerNode) || ts.isMethodDeclaration(ownerNode)) ? ownerNode : undefined;
      const asynchronousGenerator = !!generatorOwner?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      if (generatorOwner?.asteriskToken && asynchronousGenerator === (protocol === "async")) {
        const resource = `${protocol === "async" ? "async-iterator" : "iterator"}:${source.fileName}:${node.getStart(source)}`;
        const definition = { id: resource, label: node.expression.getText(source), kind: protocol === "async" ? "AsyncIterator" : "Iterator", initialState: "available" as const, requiredTerminalStates: ["consumed", "released"] as const };
        const at = node.getStart(source);
        cleanups.push({
          protocol, owner: functionName(node), resource, iterable: node.expression.getText(source),
          loopSpan: { start: at, end: node.getEnd() }, coverage: "reviewed-yield-star-delegation", unknownReasons: ["delegation-step-failure"],
          scenarios: [{
            exit: "exhausted", model: { schema: "uneffect-resource-protocol/v1", resources: [definition], transitions: [{ kind: "consume", resource, at: node.getEnd(), evidence: "exact" }] },
          }, {
            exit: "delegated-return", model: { schema: "uneffect-resource-protocol/v1", resources: [definition], transitions: [{ kind: "release", resource, at, evidence: "exact" }] },
            close: { lookupLane: "inline", resultLane: protocol === "async" ? "microtask-if-present" : "inline", method: "return-if-present", propertyAccessMayInvokeUserCode: true, failure: protocol === "async" ? "reject" : "throw", span: { start: at, end: node.getEnd() } },
          }, {
            exit: "delegated-throw",
            model: {
              schema: "uneffect-resource-protocol/v1", resources: [definition],
              transitions: [{ kind: "escape", resource, at, evidence: "unknown", conditional: true }],
            },
          }],
        });
      }
    }
    ts.forEachChild(node, collectDelegations);
  };
  collectDelegations(source);
  const aliases = new Map<ts.Symbol, ts.Symbol>();
  const bindings = new Map<ts.Symbol, { declaration: ts.VariableDeclaration; initializer: ts.Expression }>();
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const root = (symbol: ts.Symbol): ts.Symbol => {
    const seen = new Set<ts.Symbol>();
    while (aliases.has(symbol) && !seen.has(symbol)) { seen.add(symbol); symbol = aliases.get(symbol)!; }
    return symbol;
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const symbol = symbolAt(node.name), initializer = unwrapped(node.initializer);
      if (symbol && ts.isIdentifier(initializer)) {
        const target = symbolAt(initializer);
        if (target && (ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0)) aliases.set(symbol, root(target));
      } else if (symbol && (protocol === "async" ? isLibraryAsyncIterator(checker, initializer) : isLibrarySynchronousIterator(checker, initializer))) bindings.set(symbol, { declaration: node, initializer });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const frozenProperties = new Map<ts.Symbol, Map<string, ts.Symbol>>();
  const stableProperties = new Map<ts.Symbol, Map<string, ts.Symbol>>();
  const unstableProperties = new Map<ts.Symbol, Map<string, ts.Symbol>>();
  const collectFrozenProperties = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      const initializer = unwrapped(node.initializer);
      if (ts.isCallExpression(initializer) && initializer.arguments.length === 1
        && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === "freeze") {
        const declaration = checker.getResolvedSignature(initializer)?.declaration;
        const declarationFile = declaration?.getSourceFile().fileName.replaceAll("\\", "/") ?? "";
        const object = unwrapped(initializer.arguments[0]!);
        const objectSymbol = symbolAt(node.name);
        if (objectSymbol && /(?:^|\/)lib\..*\.d\.ts$/.test(declarationFile) && ts.isObjectLiteralExpression(object)) {
          const properties = new Map<string, ts.Symbol>();
          for (const property of object.properties) {
            let key: string | undefined, valueSymbol: ts.Symbol | undefined;
            if (ts.isShorthandPropertyAssignment(property)) {
              key = property.name.text;
              valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
            } else if (ts.isPropertyAssignment(property)
              && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
              key = property.name.text;
              const value = unwrapped(property.initializer);
              valueSymbol = ts.isIdentifier(value) ? symbolAt(value) : undefined;
            }
            if (!key || !valueSymbol) continue;
            const target = root(valueSymbol);
            if (bindings.has(target)) properties.set(key, target);
          }
          if (properties.size > 0) frozenProperties.set(root(objectSymbol), properties);
        }
      }
    }
    ts.forEachChild(node, collectFrozenProperties);
  };
  collectFrozenProperties(source);
  const localAggregateIsStable = (objectSymbol: ts.Symbol, declaration: ts.VariableDeclaration, keys: ReadonlySet<string>): boolean => {
    const objectRoot = root(objectSymbol), owner = enclosingFunction(declaration) ?? source;
    let stable = true;
    const visit = (node: ts.Node): void => {
      if (!stable || node !== owner && ts.isFunctionLike(node)) return;
      const nodeSymbol = ts.isIdentifier(node) ? symbolAt(node) : undefined;
      if (ts.isIdentifier(node) && nodeSymbol && root(nodeSymbol) === objectRoot) {
        if (node === declaration.name) { ts.forEachChild(node, visit); return; }
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node
          && ts.isVariableDeclarationList(node.parent.parent) && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0) {
          ts.forEachChild(node, visit); return;
        }
        if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node
          && ts.isVariableDeclarationList(node.parent.parent) && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0) {
          ts.forEachChild(node, visit); return;
        }
        const access = node.parent;
        const argument = ts.isElementAccessExpression(access) && access.argumentExpression
          ? unwrapped(access.argumentExpression) : undefined;
        const key = ts.isPropertyAccessExpression(access) && access.expression === node ? access.name.text
          : ts.isElementAccessExpression(access) && access.expression === node && argument
            && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) ? argument.text : undefined;
        if (!key || !keys.has(key)) { stable = false; return; }
        const parent = access.parent;
        if (ts.isBinaryExpression(parent) && parent.left === access && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          || ts.isPrefixUnaryExpression(parent) && parent.operand === access
          || ts.isPostfixUnaryExpression(parent) && parent.operand === access
          || ts.isDeleteExpression(parent) && parent.expression === access) { stable = false; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(owner);
    return stable;
  };
  const collectUnstableProperties = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapped(node.initializer);
      let object = ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
      const array = ts.isArrayLiteralExpression(initializer) ? initializer : undefined;
      const directLiteral = !!object || !!array;
      if (!object && ts.isCallExpression(initializer) && initializer.arguments.length > 0) {
        const candidate = unwrapped(initializer.arguments[0]!);
        if (ts.isObjectLiteralExpression(candidate)) object = candidate;
      }
      const objectSymbol = symbolAt(node.name);
      if ((object || array) && objectSymbol && !frozenProperties.has(root(objectSymbol))) {
        const properties = new Map<string, ts.Symbol>();
        for (const property of object?.properties ?? []) {
          let key: string | undefined, valueSymbol: ts.Symbol | undefined;
          if (ts.isShorthandPropertyAssignment(property)) {
            key = property.name.text;
            valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
          } else if (ts.isPropertyAssignment(property)
            && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
            key = property.name.text;
            const value = unwrapped(property.initializer);
            valueSymbol = ts.isIdentifier(value) ? symbolAt(value) : undefined;
          }
          if (!key || !valueSymbol) continue;
          const target = root(valueSymbol);
          if (bindings.has(target)) properties.set(key, target);
        }
        for (const [index, element] of array?.elements.entries() ?? []) {
          const value = ts.isExpression(element) ? unwrapped(element) : undefined;
          const valueSymbol = value && ts.isIdentifier(value) ? symbolAt(value) : undefined;
          if (valueSymbol && bindings.has(root(valueSymbol))) properties.set(String(index), root(valueSymbol));
        }
        if (properties.size > 0) {
          const target = root(objectSymbol);
          if (directLiteral && localAggregateIsStable(objectSymbol, node, new Set(properties.keys()))) stableProperties.set(target, properties);
          else unstableProperties.set(target, properties);
        }
      }
    }
    ts.forEachChild(node, collectUnstableProperties);
  };
  collectUnstableProperties(source);
  const unstableIteratorAliases = new Map<ts.Symbol, Set<ts.Symbol>>();
  const collectDestructuringAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
      && node.initializer && ts.isVariableDeclarationList(node.parent)) {
      const initializer = unwrapped(node.initializer);
      const objectSymbol = ts.isIdentifier(initializer) ? symbolAt(initializer) : undefined;
      const objectRoot = objectSymbol ? root(objectSymbol) : undefined;
      const exactProperties = objectRoot ? frozenProperties.get(objectRoot) ?? stableProperties.get(objectRoot) : undefined;
      const properties = exactProperties ?? (objectRoot ? unstableProperties.get(objectRoot) : undefined);
      const immutable = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      if (properties) for (const [index, rawElement] of node.name.elements.entries()) {
        if (ts.isOmittedExpression(rawElement) || !ts.isIdentifier(rawElement.name)) continue;
        const element = rawElement;
        const keyNode = ts.isObjectBindingPattern(node.name) ? element.propertyName ?? element.name : undefined;
        const key = ts.isArrayBindingPattern(node.name) ? String(index)
          : keyNode && (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode) || ts.isNumericLiteral(keyNode)) ? keyNode.text : undefined;
        const targets = element.dotDotDotToken
          ? new Set([...properties.entries()].filter(([property]) => ts.isArrayBindingPattern(node.name)
            ? Number(property) >= index : property !== key).map(([, target]) => target))
          : new Set(key ? properties.has(key) ? [properties.get(key)!] : [] : properties.values());
        const alias = symbolAt(element.name);
        if (!alias || targets.size === 0) continue;
        if (immutable && exactProperties && key && !element.dotDotDotToken && targets.size === 1) aliases.set(alias, [...targets][0]!);
        else unstableIteratorAliases.set(alias, targets);
      }
    }
    ts.forEachChild(node, collectDestructuringAliases);
  };
  collectDestructuringAliases(source);
  interface IteratorAliasResolution { targets: Set<ts.Symbol>; unstable: boolean }
  const emptyResolution = (): IteratorAliasResolution => ({ targets: new Set(), unstable: false });
  const identifierResolutionAt = (symbol: ts.Symbol, position: number, seen = new Set<ts.Symbol>()): IteratorAliasResolution => {
    if (seen.has(symbol)) return { targets: new Set(), unstable: true };
    const unstableTargets = unstableIteratorAliases.get(symbol);
    if (unstableTargets) return { targets: new Set(unstableTargets), unstable: true };
    const rooted = root(symbol);
    if (bindings.has(rooted)) return { targets: new Set([rooted]), unstable: false };
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent)) return emptyResolution();
    const mutable = (declaration.parent.flags & ts.NodeFlags.Const) === 0;
    const initializer = unwrapped(declaration.initializer);
    const initializerSymbol = ts.isIdentifier(initializer) ? symbolAt(initializer) : undefined;
    let state = initializerSymbol
      ? identifierResolutionAt(initializerSymbol, declaration.getStart(source), new Set(seen).add(symbol))
      : emptyResolution();
    if (!mutable) return state;
    const assignments: ts.BinaryExpression[] = [];
    const owner = enclosingFunction(declaration);
    const collectAssignments = (node: ts.Node): void => {
      if (node.getStart(source) >= position || node !== owner && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrapped(node.left)) && symbolAt(unwrapped(node.left)) === symbol) assignments.push(node);
      ts.forEachChild(node, collectAssignments);
    };
    collectAssignments(owner ?? source);
    assignments.sort((left, right) => left.getStart(source) - right.getStart(source));
    for (const assignment of assignments) {
      if (assignment.getStart(source) <= declaration.getEnd() || assignment.getEnd() > position) continue;
      const right = unwrapped(assignment.right);
      const next = ts.isIdentifier(right) && symbolAt(right)
        ? identifierResolutionAt(symbolAt(right)!, assignment.getStart(source), new Set(seen).add(symbol))
        : { targets: new Set<ts.Symbol>(), unstable: true };
      if (conditionallyExecuted(assignment, declaration)) {
        state = { targets: new Set([...state.targets, ...next.targets]), unstable: true };
      } else state = next;
    }
    return state;
  };
  const iteratorResolutionAtExpression = (expression: ts.Expression, at: ts.Node = expression): IteratorAliasResolution => {
    expression = unwrapped(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      return symbol ? identifierResolutionAt(symbol, at.getStart(source)) : emptyResolution();
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(unwrapped(expression.expression))) {
      const receiver = unwrapped(expression.expression) as ts.Identifier;
      const objectSymbol = symbolAt(receiver);
      const unstableTargets = objectSymbol ? unstableIteratorAliases.get(objectSymbol) : undefined;
      if (unstableTargets) return { targets: new Set(unstableTargets), unstable: true };
      const target = objectSymbol ? (frozenProperties.get(root(objectSymbol)) ?? stableProperties.get(root(objectSymbol)))?.get(expression.name.text) : undefined;
      return target ? { targets: new Set([target]), unstable: false } : emptyResolution();
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression
      && (ts.isStringLiteralLike(unwrapped(expression.argumentExpression)) || ts.isNumericLiteral(unwrapped(expression.argumentExpression)))
      && ts.isIdentifier(unwrapped(expression.expression))) {
      const receiver = unwrapped(expression.expression) as ts.Identifier;
      const key = unwrapped(expression.argumentExpression) as ts.StringLiteralLike | ts.NumericLiteral;
      const objectSymbol = symbolAt(receiver);
      const unstableTargets = objectSymbol ? unstableIteratorAliases.get(objectSymbol) : undefined;
      if (unstableTargets) return { targets: new Set(unstableTargets), unstable: true };
      const target = objectSymbol ? (frozenProperties.get(root(objectSymbol)) ?? stableProperties.get(root(objectSymbol)))?.get(key.text) : undefined;
      return target ? { targets: new Set([target]), unstable: false } : emptyResolution();
    }
    return emptyResolution();
  };
  const iteratorSymbolAtExpression = (expression: ts.Expression, at: ts.Node = expression): ts.Symbol | undefined => {
    const resolution = iteratorResolutionAtExpression(expression, at);
    return !resolution.unstable && resolution.targets.size === 1 ? [...resolution.targets][0] : undefined;
  };
  const possibleIteratorSymbolAtExpression = (expression: ts.Expression): ts.Symbol | undefined => {
    const exact = iteratorSymbolAtExpression(expression);
    if (exact) return exact;
    expression = unwrapped(expression);
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
    const receiver = unwrapped(expression.expression);
    if (!ts.isIdentifier(receiver)) return undefined;
    const objectSymbol = symbolAt(receiver);
    if (!objectSymbol) return undefined;
    const rootObject = root(objectSymbol);
    const maps = [frozenProperties.get(rootObject), unstableProperties.get(rootObject)].filter((item): item is Map<string, ts.Symbol> => !!item);
    if (ts.isPropertyAccessExpression(expression)) return maps.map((properties) => properties.get(expression.name.text)).find(Boolean);
    const keyExpression = expression.argumentExpression && unwrapped(expression.argumentExpression);
    if (keyExpression && ts.isStringLiteralLike(keyExpression)) return maps.map((properties) => properties.get(keyExpression.text)).find(Boolean);
    const candidates = new Set(maps.flatMap((properties) => [...properties.values()]));
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const aggregateIteratorTargets = (expression: ts.Expression): ReadonlySet<ts.Symbol> => {
    expression = unwrapped(expression);
    if (!ts.isIdentifier(expression)) return new Set();
    const objectSymbol = symbolAt(expression);
    if (!objectSymbol) return new Set();
    const objectRoot = root(objectSymbol);
    const properties = frozenProperties.get(objectRoot) ?? stableProperties.get(objectRoot) ?? unstableProperties.get(objectRoot);
    return new Set(properties?.values() ?? []);
  };
  for (const [symbol, binding] of bindings) {
    const operations: ManualIteratorOperation[] = [];
    const bindingOwner = enclosingFunction(binding.declaration);
    const referencesBinding = (candidate: ts.Node): boolean => {
      let found = false;
      const scan = (child: ts.Node): void => {
        if (found) return;
        if ((ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child))
          && iteratorSymbolAtExpression(child, child) === symbol) { found = true; return; }
        if (ts.isIdentifier(child)) {
          const candidateSymbol = symbolAt(child);
          if (candidateSymbol && root(candidateSymbol) === symbol) { found = true; return; }
        }
        ts.forEachChild(child, scan);
      };
      scan(candidate);
      return found;
    };
    const unstableAggregateCapturesBinding = (candidate: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
      candidate = unwrapped(candidate);
      if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)
        || ts.isObjectLiteralExpression(candidate) || ts.isArrayLiteralExpression(candidate)) {
        let found = false;
        const scan = (node: ts.Node): void => {
          if (found || node !== candidate && ts.isFunctionLike(node)) return;
          if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
            && !iteratorSymbolAtExpression(node, node) && possibleIteratorSymbolAtExpression(node) === symbol) { found = true; return; }
          ts.forEachChild(node, scan);
        };
        scan(candidate);
        return found;
      }
      if (!ts.isIdentifier(candidate)) return false;
      const candidateSymbol = symbolAt(candidate), declaration = candidateSymbol?.valueDeclaration;
      if (!candidateSymbol || seen.has(candidateSymbol) || !declaration || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
      return unstableAggregateCapturesBinding(declaration.initializer, new Set([...seen, candidateSymbol]));
    };
    const immutableClosureCapturesBinding = (candidate: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
      candidate = unwrapped(candidate);
      if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return referencesBinding(candidate);
      if (ts.isObjectLiteralExpression(candidate)) return candidate.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          const propertySymbol = symbolAt(property.name);
          return !!propertySymbol && root(propertySymbol) === symbol;
        }
        return ts.isPropertyAssignment(property) && immutableClosureCapturesBinding(property.initializer, seen);
      });
      if (ts.isArrayLiteralExpression(candidate)) return candidate.elements.some((element) =>
        ts.isExpression(element) && immutableClosureCapturesBinding(element, seen));
      if (!ts.isIdentifier(candidate)) return false;
      const candidateSymbol = symbolAt(candidate), declaration = candidateSymbol?.valueDeclaration;
      if (candidateSymbol && root(candidateSymbol) === symbol) return true;
      if (!candidateSymbol || seen.has(candidateSymbol) || !declaration || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
      return immutableClosureCapturesBinding(declaration.initializer, new Set([...seen, candidateSymbol]));
    };
    const visit = (node: ts.Node): void => {
      const callee = ts.isCallExpression(node) ? unwrapped(node.expression) : undefined;
      if (ts.isCallExpression(node) && callee && ts.isPropertyAccessExpression(callee)
        && (callee.name.text === "next" || callee.name.text === "return" || callee.name.text === "throw")) {
        const receiver = iteratorResolutionAtExpression(callee.expression, node);
        const receiverSymbol = !receiver.unstable && receiver.targets.size === 1 ? [...receiver.targets][0] : undefined;
        if (receiverSymbol === symbol && enclosingFunction(node) === bindingOwner) {
          const kind = callee.name.text === "return" ? "release" as const : "use" as const;
          operations.push({ kind, node, awaited: protocol === "sync" || awaitedCall(node), conditional: kind === "use" ? false : conditionallyExecuted(node, binding.declaration) });
          if (callee.name.text === "next") {
            const exhaustion = canonicalExhaustionLoop(node);
            if (exhaustion) operations.push({ kind: "consume", node: exhaustion, at: exhaustion.getEnd(), awaited: true, conditional: false, naturalExhaustion: true });
            else {
              const doneBreak = canonicalBoundDoneBreak(node, checker);
              if (doneBreak) operations.push({ kind: "consume", node: doneBreak, awaited: true, conditional: false, naturalExhaustion: true });
              else {
                const forLoop = canonicalForResultLoop(node, checker);
                if (forLoop) {
                  const updateCallee = unwrapped(forLoop.updateCall.expression);
                  if (ts.isPropertyAccessExpression(updateCallee)
                    && iteratorSymbolAtExpression(updateCallee.expression, forLoop.updateCall) === symbol) operations.push({
                    kind: "consume", node: forLoop.loop, at: forLoop.loop.getEnd(), awaited: true,
                    conditional: false, naturalExhaustion: true,
                  });
                }
              }
            }
          }
        } else if (receiver.targets.has(symbol) && enclosingFunction(node) === bindingOwner) {
          const kind = callee.name.text === "return" ? "release" as const : "use" as const;
          operations.push({ kind, node, awaited: protocol === "sync" || awaitedCall(node), conditional: true, evidence: "unknown", unstableAlias: true });
        } else if (possibleIteratorSymbolAtExpression(callee.expression) === symbol && enclosingFunction(node) === bindingOwner) {
          const kind = callee.name.text === "return" ? "release" as const : "use" as const;
          operations.push({ kind, node, awaited: protocol === "sync" || awaitedCall(node), conditional: true, evidence: "unknown", unstableProperty: true });
        }
      }
      if (ts.isReturnStatement(node) && node.expression && enclosingFunction(node) === bindingOwner) {
        const returned = unwrapped(node.expression), returnedResolution = iteratorResolutionAtExpression(returned, node);
        const returnedSymbol = !returnedResolution.unstable && returnedResolution.targets.size === 1 ? [...returnedResolution.targets][0] : undefined;
        if (returnedSymbol === symbol) operations.push({ kind: "escape", node, awaited: true, conditional: conditionallyExecuted(node, binding.declaration) });
        else if (returnedResolution.targets.has(symbol)) operations.push({
          kind: "escape", node, awaited: true, conditional: true, evidence: "unknown", unstableAlias: true,
        });
        else if (ts.isIdentifier(returned)) {
          const aggregateSymbol = symbolAt(returned), aggregateRoot = aggregateSymbol ? root(aggregateSymbol) : undefined;
          const frozen = aggregateRoot ? frozenProperties.get(aggregateRoot) : undefined;
          const unstable = aggregateRoot ? unstableProperties.get(aggregateRoot) : undefined;
          if (frozen && [...frozen.values()].includes(symbol)) operations.push({ kind: "escape", node, awaited: true, conditional: conditionallyExecuted(node, binding.declaration) });
          else if (unstable && [...unstable.values()].includes(symbol)) operations.push({ kind: "escape", node, awaited: true, conditional: true, evidence: "unknown", unstableProperty: true });
          else if (immutableClosureCapturesBinding(returned)) operations.push({ kind: "escape", node, awaited: true, conditional: conditionallyExecuted(node, binding.declaration) });
          else if (unstableAggregateCapturesBinding(returned)) operations.push({ kind: "escape", node, awaited: true, conditional: true, evidence: "unknown", unstableProperty: true });
        }
        else if (immutableClosureCapturesBinding(returned)) {
          operations.push({ kind: "escape", node, awaited: true, conditional: conditionallyExecuted(node, binding.declaration) });
        } else if (unstableAggregateCapturesBinding(returned)) {
          operations.push({ kind: "escape", node, awaited: true, conditional: true, evidence: "unknown", unstableProperty: true });
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(unwrapped(node.left)) || ts.isElementAccessExpression(unwrapped(node.left)))
        && aggregateIteratorTargets(node.right).has(symbol) && enclosingFunction(node) === bindingOwner) {
        operations.push({ kind: "escape", node: node.right, awaited: true, conditional: true, evidence: "unknown", unstableProperty: true });
      }
      if (ts.isCallExpression(node) && enclosingFunction(node) === bindingOwner) for (const [argumentIndex, argument] of node.arguments.entries()) {
        if (aggregateIteratorTargets(argument).has(symbol)) {
          operations.push({ kind: "escape", node: argument, awaited: true, conditional: true, evidence: "unknown", unstableProperty: true });
          continue;
        }
        const argumentResolution = iteratorResolutionAtExpression(argument, node);
        if (!argumentResolution.targets.has(symbol)) continue;
        if (isStandardIteratorConsumer(checker, node, argumentIndex, protocol)) {
          operations.push({ kind: "consume", node: argument, awaited: true, conditional: false, evidence: "exact" });
          continue;
        }
        if (argumentResolution.unstable || argumentResolution.targets.size !== 1) {
          operations.push({ kind: "escape", node: argument, awaited: true, conditional: true, evidence: "unknown", unstableAlias: true });
          continue;
        }
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const declarationSource = declaration?.getSourceFile();
        const summary = declaration && declarationSource
          ? callableSummaries.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`) : undefined;
        const declared = summary?.operations.filter((operation) => operation.subject.kind === "parameter" && operation.subject.index === argumentIndex) ?? [];
        if (declared.length === 0) operations.push({ kind: "escape", node: argument, awaited: true, conditional: true, evidence: "unknown", uncontractedCall: true });
        else for (const operation of declared) {
          if (operation.kind === "acquire") {
            operations.push({ kind: "escape", node: argument, awaited: true, conditional: true, evidence: "unknown", uncontractedCall: true });
            continue;
          }
          operations.push({
            kind: operation.kind === "borrow" ? "use" : operation.kind,
            node: argument, awaited: true, conditional: operation.kind === "borrow" ? false : conditionallyExecuted(node, binding.declaration), evidence: summary!.evidence === "verified" ? "exact" : "trusted",
          });
        }
      }
      if (ts.isNewExpression(node) && enclosingFunction(node) === bindingOwner) for (const [argumentIndex, argument] of (node.arguments ?? []).entries()) {
        const argumentResolution = iteratorResolutionAtExpression(argument, node);
        if (!argumentResolution.targets.has(symbol)) continue;
        if (isStandardIteratorConstructConsumer(checker, node, argumentIndex, protocol)) {
          operations.push({ kind: "consume", node: argument, awaited: true, conditional: false, evidence: "exact" });
        } else {
          operations.push({ kind: "escape", node: argument, awaited: true, conditional: true, evidence: "unknown", uncontractedCall: true });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    normalizeManualIteratorBranches(operations, binding.declaration);
    if (operations.length === 0) continue;
    operations.sort((left, right) => (left.at ?? left.node.getStart(source)) - (right.at ?? right.node.getStart(source)));
    const close = operations.find(({ kind }) => kind === "release");
    const terminal = operations.find(({ kind }) => kind === "escape" || kind === "consume" || kind === "transfer");
    const resource = `${protocol === "async" ? "async-iterator" : "iterator"}:${source.fileName}:${binding.declaration.getStart(source)}`;
    const owner = functionName(binding.declaration);
    const unknownReasons: AsyncIteratorCleanupUnknown[] = [];
    if (!close && !terminal) unknownReasons.push("manual-iterator-not-closed");
    if (operations.some(({ awaited }) => !awaited)) unknownReasons.push("unawaited-iterator-operation");
    if (operations.some(({ conditional, uncontractedCall, unstableProperty, unstableAlias }) => conditional && !uncontractedCall && !unstableProperty && !unstableAlias)) unknownReasons.push("conditional-manual-protocol");
    if (operations.some(({ uncontractedCall }) => uncontractedCall)) unknownReasons.push("iterator-passed-to-call");
    if (operations.some(({ unstableProperty }) => unstableProperty)) unknownReasons.push("unstable-iterator-property");
    if (operations.some(({ unstableAlias }) => unstableAlias)) unknownReasons.push("unstable-iterator-alias");
    cleanups.push({
      protocol, owner, resource, iterable: binding.initializer.getText(source),
      loopSpan: { start: binding.declaration.getStart(source), end: (operations.at(-1)?.node ?? binding.declaration).getEnd() },
      coverage: "reviewed-manual-protocol", unknownReasons,
      scenarios: [{
        exit: terminal?.kind === "consume" ? terminal.naturalExhaustion ? "manual-exhausted" : "manual-consume" : terminal?.kind === "transfer" ? "manual-transfer" : terminal?.kind === "escape" ? "manual-escape" : close ? "manual-return" : "manual-open",
        model: {
          schema: "uneffect-resource-protocol/v1",
          resources: [{ id: resource, label: binding.initializer.getText(source), kind: protocol === "async" ? "AsyncIterator" : "Iterator", initialState: "available", requiredTerminalStates: ["released", "escaped", "consumed", "transferred"] }],
          transitions: operations.map(({ kind, node, at, conditional, evidence }) => ({ kind, resource, at: at ?? node.getStart(source), evidence: conditional ? "unknown" as const : evidence ?? "exact" as const, ...(conditional ? { conditional: true } : {}) })),
        },
        ...(close ? { close: { lookupLane: "inline" as const, resultLane: protocol === "sync" ? "inline" as const : close.awaited ? "microtask" as const : "unobserved" as const, method: "return" as const, propertyAccessMayInvokeUserCode: true as const, failure: protocol === "sync" ? "throw" as const : "reject" as const, span: { start: close.node.getStart(source), end: close.node.getEnd() } } } : {}),
      }],
    });
  }
  return cleanups;
}

/** Extracts direct, awaited manual AsyncIterator protocol use with TypeChecker-backed identity. */
export function analyzeAsyncIteratorCleanupInProgram(program: ts.Program, source: ts.SourceFile): readonly AsyncIteratorCleanup[] {
  return analyzeIteratorProtocolCleanupInProgram(program, source, "async");
}

function syncScenario(resource: string, loop: ts.ForOfStatement, exit: AsyncIteratorExit, at: number): AsyncIteratorCleanupScenario {
  const abrupt = exit !== "exhausted";
  return {
    exit,
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: resource, label: loop.expression.getText(), kind: "Iterator", initialState: "available", requiredTerminalStates: ["consumed", "released"] }],
      transitions: [{ kind: abrupt ? "release" : "consume", resource, at, evidence: "exact" }],
    },
    ...(abrupt ? { close: {
      lookupLane: "inline" as const, resultLane: "inline" as const,
      method: "return-if-present" as const, propertyAccessMayInvokeUserCode: true as const,
      failure: "throw" as const,
      span: { start: at, end: at + (exit === "break" ? 5 : exit === "return" ? 6 : 5) },
    } } : {}),
  };
}

/** Extracts the synchronous `for...of` IteratorClose fragment. */
export function analyzeSynchronousIteratorCleanup(source: ts.SourceFile): readonly AsyncIteratorCleanup[] {
  const cleanups: AsyncIteratorCleanup[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && !node.awaitModifier) {
      const resource = `iterator:${source.fileName}:${node.getStart(source)}`;
      const exits = new Map<AsyncIteratorExit, number>([["exhausted", node.getEnd()]]);
      const unknownReasons = new Set<AsyncIteratorCleanupUnknown>();
      const scan = (child: ts.Node): void => {
        if (child !== node.statement && ts.isFunctionLike(child)) return;
        const exit = ts.isBreakStatement(child) && breakTargetsLoop(child, node) ? "break"
          : ts.isReturnStatement(child) ? "return"
          : ts.isThrowStatement(child) && throwEscapesLoop(child, node) ? "throw" : undefined;
        if (exit && crossesFinally(child, node)) unknownReasons.add("abrupt-through-finally");
        else if (exit) {
          const projected = projectAbruptExitThroughFinally(child, node, exit);
          if (projected) exits.set(projected, child.getStart(source));
        }
        else if (mayImplicitlyThrow(child) && throwEscapesLoop(child, node) && !crossesFinally(child, node)
          && !exits.has("throw")) exits.set("throw", child.getStart(source));
        ts.forEachChild(child, scan);
      };
      scan(node.statement);
      cleanups.push({
        protocol: "sync", owner: functionName(node), resource,
        iterable: node.expression.getText(source), loopSpan: { start: node.getStart(source), end: node.getEnd() },
        coverage: "reviewed-explicit-completions", unknownReasons: [...unknownReasons],
        scenarios: [...exits].map(([exit, at]) => syncScenario(resource, node, exit, at)),
      });
      ts.forEachChild(node.statement, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return cleanups;
}

/** Unified Iterator/AsyncIterator cleanup analysis used by the CLI. */
export function analyzeIteratorCleanupInProgram(program: ts.Program, source: ts.SourceFile): readonly AsyncIteratorCleanup[] {
  const callableSummaries = new Map(analyzeResourceCallableSummaries(program).summaries.map((summary) => [summary.id, summary] as const));
  return [
    ...analyzeIteratorProtocolCleanupInProgram(program, source, "async", callableSummaries),
    ...analyzeSynchronousIteratorCleanup(source),
    ...analyzeIteratorProtocolCleanupInProgram(program, source, "sync", callableSummaries),
  ]
    .sort((left, right) => left.loopSpan.start - right.loopSpan.start);
}
