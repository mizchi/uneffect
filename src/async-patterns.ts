import ts from "typescript";
import { basename, dirname } from "node:path";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import type { PromiseCombinator } from "./builtin-contracts.js";
import type { PromiseChainModel } from "./promise-chains.js";
import type { TemporalComposition } from "./temporal-compose.js";
import { formatTemporalValueType, generateQuintExpression } from "./temporal-expressions.js";
import { evaluateStaticPrimitive } from "./static-evaluation.js";

export interface TimerPattern {
  owner: string;
  callback: string;
  delay?: number;
  recursive: boolean;
  repeats: boolean;
  queue: "timer" | "microtask" | "animation-frame" | "scheduler-task" | "next-tick" | "poll" | "check" | "close";
  enqueuedBy?: number;
  handle?: string;
  handleKind?: "number" | "object" | "unknown";
  handleFamily?: "timeout" | "immediate" | "animation-frame";
  kind?: "abort-timeout" | "scheduler-post-task" | "scheduler-yield";
  abortReason?: "TimeoutError";
  priority?: "user-blocking" | "user-visible" | "background";
  priorityMutable?: true;
  priorityChanges?: Array<"user-blocking" | "user-visible" | "background">;
  initiallyCancelled?: boolean;
  abortTimer?: number;
  abortComposition?: number;
  externalAbortSignal?: boolean;
  externallyReady?: boolean;
  callbackAlternatives?: string[];
  parentAlternative?: number;
  span: { start: number; end: number };
}

export interface PromiseCombinatorPattern {
  owner: string;
  combinator: PromiseCombinator;
  branches: string[];
  branchKinds: ("value" | "thenable" | "unknown")[];
  branchAlternatives?: string[][];
  branchPresence?: ("always" | "when-true" | "when-false")[];
  /** Complete, correlated iterable executions. Path order is stable and drives the Quint choice index. */
  iterablePaths?: Array<{
    branches: string[];
    branchKinds: ("value" | "thenable" | "unknown")[];
    iteratorFailure?: "acquire" | "step";
  }>;
  staticIterable: boolean;
  iteratorKind: "array" | "set" | "local" | "dynamic";
  iteratorEffects: [] | ["InvokeUserCode"];
  iteratorFailure?: "acquire" | "step";
  iteratorFailurePresence?: "when-true" | "when-false";
  unsupportedReason?: UnsupportedIterableReason;
  aggregateErrorOrder?: number[];
  aggregateErrorReasons?: Array<PromiseRejectionReason | null>;
  aggregateErrorReasonPaths?: Array<Array<PromiseRejectionReason | null>>;
  awaited: boolean;
  catchesRejection: boolean;
  span: { start: number; end: number };
}
export type PromiseRejectionReason =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "error"; errorType: string; message?: string };
export type UnsupportedIterableReason = "dynamic-cardinality" | "finite-element-limit" | "finite-path-limit" | "unsupported-generator-control-flow";

export interface TimerCancellation {
  owner: string;
  handle: string;
  timer?: number;
  definite: boolean;
  clearFamily?: "timeout" | "immediate" | "animation-frame";
  compatible?: boolean;
  span: { start: number; end: number };
}

export interface AbortCompositionPattern {
  owner: string;
  handle?: string;
  sources: string[];
  sourceTimers: (number | undefined)[];
  sourceCompositions?: (number | undefined)[];
  sourceReasons: (string | undefined)[];
  initiallyAbortedSource?: number;
  sourcePaths?: number[][];
  initiallyAbortedSources?: (number | undefined)[];
  span: { start: number; end: number };
}
type AbortTarget = { timer?: number; composition?: number; alreadyAborted?: boolean; reason?: string };

export interface TimerHandleEscape {
  owner: string;
  kind: "argument" | "property" | "return" | "closure";
  handle: string;
  timer: number;
  span: { start: number; end: number };
}

export interface AsyncPatternModel {
  timers: TimerPattern[];
  combinators: PromiseCombinatorPattern[];
  cancellations: TimerCancellation[];
  abortCompositions: AbortCompositionPattern[];
  timerEscapes: TimerHandleEscape[];
}

function functionName(node: ts.FunctionLikeDeclaration | ts.SourceFile): string {
  if (ts.isSourceFile(node)) return "<module>";
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}

export function analyzeAsyncPatternsInProgram(program: ts.Program, source: ts.SourceFile): AsyncPatternModel {
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true });
  const defaultLibDirectory = dirname(ts.getDefaultLibFilePath(program.getCompilerOptions()));
  const timers: TimerPattern[] = [], combinators: PromiseCombinatorPattern[] = [], cancellations: TimerCancellation[] = [], abortCompositions: AbortCompositionPattern[] = [], timerEscapes: TimerHandleEscape[] = [];
  const branchKind = (element: ts.Expression | ts.OmittedExpression): "value" | "thenable" | "unknown" => {
    if (ts.isOmittedExpression(element)) return "value";
    if (ts.isYieldExpression(element) && !element.expression) return "value";
    if (ts.isCallExpression(element) && ts.isPropertyAccessExpression(element.expression)
      && ["resolve", "reject"].includes(element.expression.name.text)) {
      const symbol = resolvedSymbol(element.expression.name);
      if (symbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
        && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "PromiseConstructor")) return "thenable";
    }
    const type = checker.getTypeAtLocation(element);
    const members = type.isUnion() ? type.types : [type];
    if (members.some((member) => Boolean(member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))) return "unknown";
    const thenable = members.map((member) => Boolean(checker.getPropertyOfType(member, "then")));
    return thenable.every(Boolean) ? "thenable" : thenable.some(Boolean) ? "unknown" : "value";
  };
  const branchText = (element: ts.Expression | ts.OmittedExpression): string => ts.isOmittedExpression(element) ? "<hole>"
    : ts.isYieldExpression(element) && !element.expression ? "undefined"
      : element.pos < 0 ? printer.printNode(ts.EmitHint.Expression, element, source) : element.getText(element.getSourceFile());
  const resolvedSymbol = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const staticNumber = (expression: ts.Expression | undefined): number | undefined => {
    if (!expression) return undefined;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
      if (expression.operator === ts.SyntaxKind.MinusToken) return -Number(expression.operand.text);
      if (expression.operator === ts.SyntaxKind.PlusToken) return Number(expression.operand.text);
    }
    if (ts.isIdentifier(expression) && expression.text === "NaN"
      && resolvedSymbol(expression)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile)) return Number.NaN;
    return undefined;
  };
  const literalReason = (expression: ts.Expression): string | number | boolean | undefined => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) return -Number(expression.operand.text);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literalReason(expression.left), right = literalReason(expression.right);
      if (left !== undefined && right !== undefined
        && (typeof left === "string" || typeof left === "number")
        && (typeof right === "string" || typeof right === "number")) {
        return typeof left === "string" || typeof right === "string"
          ? String(left) + String(right) : left + right;
      }
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const embedded = literalReason(span.expression);
        if (embedded === undefined) return undefined;
        value += String(embedded) + span.literal.text;
      }
      return value;
    }
    return undefined;
  };
  const immutableInitializer = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression => {
    if (!ts.isIdentifier(expression)) return expression;
    const symbol = resolvedSymbol(expression);
    if (!symbol || seen.has(symbol)) return expression;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return expression;
    seen.add(symbol);
    return immutableInitializer(declaration.initializer, seen);
  };
  const rejectionReason = (expression: ts.Expression | ts.OmittedExpression): PromiseRejectionReason | null => {
    if (ts.isOmittedExpression(expression) || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== "reject") return null;
    const symbol = resolvedSymbol(expression.expression.name);
    const standard = symbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "PromiseConstructor");
    if (!standard || !expression.arguments[0]) return null;
    const argument = immutableInitializer(expression.arguments[0]), literal = literalReason(argument);
    if (literal !== undefined) return { kind: "literal", value: literal };
    if (ts.isNewExpression(argument) && ts.isIdentifier(argument.expression)) {
      const message = argument.arguments?.[0] && literalReason(argument.arguments[0]);
      return { kind: "error", errorType: argument.expression.text, ...(typeof message === "string" ? { message } : {}) };
    }
    return null;
  };
  type StaticArrayExpansionEvidence = {
    invokesUserCode: boolean;
    paths?: FiniteIterablePath[];
    alternatives?: readonly [(ts.Expression | ts.OmittedExpression)[], (ts.Expression | ts.OmittedExpression)[]];
    failure?: "acquire" | "step";
    failurePresence?: "when-true" | "when-false";
    unsupportedReason?: Exclude<UnsupportedIterableReason, "dynamic-cardinality">;
  };
  type FiniteIterablePath = {
    branches: (ts.Expression | ts.OmittedExpression)[];
    failure?: "acquire" | "step";
    conditions?: Map<ts.Symbol | string, boolean>;
  };
  const MAX_FINITE_ITERABLE_PATHS = 32;
  const MAX_FINITE_ITERABLE_ELEMENTS = 256;
  function expandStaticArray(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
    evidence?: StaticArrayExpansionEvidence,
  ): (ts.Expression | ts.OmittedExpression)[] | undefined {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isIdentifier(expression)) {
      const symbol = resolvedSymbol(expression);
      const declaration = symbol?.valueDeclaration;
      if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
      let initializer = declaration.initializer;
      while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
      if (ts.isArrayLiteralExpression(initializer)) return undefined;
      seen.add(symbol);
      const expanded = expandStaticArray(initializer, seen, evidence);
      seen.delete(symbol);
      return expanded;
    }
    if (ts.isAsExpression(expression) && expression.type.getText(expression.getSourceFile()) === "const") {
      return expandStaticArray(expression.expression, seen, evidence);
    }
    if (!ts.isArrayLiteralExpression(expression)) return undefined;
    let paths: FiniteIterablePath[] = [{ branches: [] }];
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) {
        for (const path of paths) if (!path.failure) path.branches.push(element);
      }
      else {
        const nestedEvidence: StaticArrayExpansionEvidence = { invokesUserCode: false };
        let nested = expandStaticArray(element.expression, seen, nestedEvidence) ?? expandStaticSet(element.expression);
        let nestedPathEvidence = nestedEvidence.paths;
        let alternatives = nestedEvidence.alternatives;
        let invokesUserCode = nestedEvidence.invokesUserCode;
        let failure = nestedEvidence.failure;
        let failurePresence = nestedEvidence.failurePresence;
        if (!nested) {
          const local = localIterable(element.expression);
          if (local) {
            if (local.unsupportedReason) {
              if (evidence) evidence.unsupportedReason = local.unsupportedReason;
              return undefined;
            }
            nested = local.branches;
            nestedPathEvidence = local.paths;
            alternatives = local.alternatives;
            invokesUserCode = true;
            failure = local.failure;
            failurePresence = local.failurePresence;
          }
        }
        if (!nested) return undefined;
        const nestedPaths: FiniteIterablePath[] = nestedPathEvidence
          ?? (alternatives ? [
            { branches: alternatives[0], ...(failurePresence === "when-true" && failure ? { failure } : {}) },
            { branches: alternatives[1], ...(failurePresence === "when-false" && failure ? { failure } : {}) },
          ] : [{ branches: nested, ...(failure ? { failure } : {}) }]);
        const product = paths.flatMap((prefix) => {
          if (prefix.failure) return [prefix];
          return nestedPaths.flatMap((suffix) => {
            const conditions = new Map(prefix.conditions);
            for (const [key, value] of suffix.conditions ?? []) {
              const existing = conditions.get(key);
              if (existing !== undefined && existing !== value) return [];
              conditions.set(key, value);
            }
            return [{
              branches: [...prefix.branches, ...suffix.branches],
              failure: suffix.failure,
              ...(conditions.size ? { conditions } : {}),
            }];
          });
        });
        if (product.length > MAX_FINITE_ITERABLE_PATHS) {
          if (evidence) evidence.unsupportedReason = "finite-path-limit";
          return undefined;
        }
        paths = product;
        if (evidence) {
          evidence.invokesUserCode ||= invokesUserCode;
          evidence.failure ??= failure;
          evidence.failurePresence ??= failurePresence;
        }
      }
    }
    if (evidence && paths.length > 1) {
      evidence.paths = paths;
      if (paths.length === 2) {
        evidence.alternatives = [paths[0]!.branches, paths[1]!.branches];
        const trueFailure = paths[0]!.failure, falseFailure = paths[1]!.failure;
        evidence.failure = trueFailure ?? falseFailure;
        evidence.failurePresence = Boolean(trueFailure) !== Boolean(falseFailure)
          ? trueFailure ? "when-true" : "when-false" : undefined;
      }
    }
    return paths[0]!.branches;
  }
  function expandStaticSet(expression: ts.Expression): (ts.Expression | ts.OmittedExpression)[] | undefined {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "Set"
      || (expression.arguments?.length ?? 0) > 1
      || !(resolvedSymbol(expression.expression)?.declarations?.some((declaration) => {
        const declarationFile = declaration.getSourceFile();
        return declarationFile.isDeclarationFile
          && dirname(declarationFile.fileName) === defaultLibDirectory
          && /^lib\..*\.d\.ts$/.test(basename(declarationFile.fileName));
      }) ?? false)) return undefined;
    const entries = expression.arguments?.[0] ? expandStaticArray(expression.arguments[0]) : [];
    if (!entries) return undefined;
    const seen = new Set<string | ts.Symbol>();
    const identity = (entry: ts.Expression | ts.OmittedExpression): string | ts.Symbol | undefined => {
      if (ts.isOmittedExpression(entry)) return "primitive:undefined";
      if (ts.isStringLiteral(entry) || ts.isNumericLiteral(entry) || ts.isBigIntLiteral(entry)) return `primitive:${entry.kind}:${entry.text}`;
      if (entry.kind === ts.SyntaxKind.TrueKeyword || entry.kind === ts.SyntaxKind.FalseKeyword
        || entry.kind === ts.SyntaxKind.NullKeyword) return `primitive:${entry.kind}`;
      if (ts.isIdentifier(entry)) {
        return resolvedSymbol(entry);
      }
      return undefined;
    };
    return entries.filter((entry) => {
      const key = identity(entry);
      if (key === undefined) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  type FiniteIterableExpansion = {
    branches: ts.Expression[];
    paths?: Array<{ branches: ts.Expression[]; failure?: "acquire" | "step"; conditions?: Map<ts.Symbol | string, boolean> }>;
    alternatives?: readonly [ts.Expression[], ts.Expression[]];
    failure?: "acquire" | "step";
    failurePresence?: "when-true" | "when-false";
    unsupportedReason?: Exclude<UnsupportedIterableReason, "dynamic-cardinality">;
  };
  const linearGeneratorBody = (
    body: ts.Block,
    substitutions = new Map<ts.Symbol, ts.Expression>(),
    generatorStack = new Set<ts.Symbol>(),
  ): FiniteIterableExpansion | undefined => {
    const unwrapProjectionBase = (expression: ts.Expression): ts.Expression => {
      while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
      return expression;
    };
    const projectStaticMember = (expression: ts.Expression, key: string): ts.Expression | undefined => {
      const base = unwrapProjectionBase(expression);
      if (ts.isArrayLiteralExpression(base)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || base.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) return undefined;
        const index = Number(key);
        return Number.isSafeInteger(index) ? base.elements[index] as ts.Expression | undefined : undefined;
      }
      if (key === "__proto__" || !ts.isObjectLiteralExpression(base)
        || base.properties.some((property) => !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name))) return undefined;
      const properties = [...base.properties].reverse() as ts.PropertyAssignment[];
      return properties.find((property) => {
        const name = property.name;
        return (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === key;
      })?.initializer;
    };
    const staticPrimitive = (expression: ts.Expression): { kind: "boolean" | "number" | "string" | "null"; value: boolean | number | string | null } | undefined => {
      expression = unwrapProjectionBase(expression);
      if (expression.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
      if (expression.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
      if (expression.kind === ts.SyntaxKind.NullKeyword) return { kind: "null", value: null };
      const literal = literalReason(expression);
      if (typeof literal === "number") return { kind: "number", value: literal };
      if (typeof literal === "string") return { kind: "string", value: literal };
      return undefined;
    };
    const substitute = (expression: ts.Expression, bindings?: Map<ts.Symbol, ts.Expression>, seen = new Set<ts.Symbol>()): ts.Expression => {
      if (ts.isIdentifier(expression)) {
        const symbol = resolvedSymbol(expression);
        if (!symbol || seen.has(symbol)) return expression;
        const replacement = bindings?.get(symbol) ?? substitutions.get(symbol);
        if (!replacement) return expression;
        const nextSeen = new Set(seen);
        nextSeen.add(symbol);
        return substitute(replacement, bindings, nextSeen);
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const base = substitute(expression.expression, bindings, new Set(seen));
        const projected = projectStaticMember(base, expression.name.text);
        if (projected) return substitute(projected, bindings, new Set(seen));
        return base === expression.expression ? expression : ts.factory.createPropertyAccessExpression(base, expression.name);
      }
      if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const base = substitute(expression.expression, bindings, new Set(seen));
        const argument = substitute(expression.argumentExpression, bindings, new Set(seen));
        const key = ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
        const projected = key === undefined ? undefined : projectStaticMember(base, key);
        if (projected) return substitute(projected, bindings, new Set(seen));
        return base === expression.expression && argument === expression.argumentExpression ? expression
          : ts.factory.createElementAccessExpression(base, argument);
      }
      if (ts.isParenthesizedExpression(expression)) {
        const inner = substitute(expression.expression, bindings, seen);
        return inner === expression.expression ? expression : ts.factory.createParenthesizedExpression(inner);
      }
      if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
        const operand = substitute(expression.operand, bindings, new Set(seen));
        if (operand.kind === ts.SyntaxKind.TrueKeyword) return ts.factory.createFalse();
        if (operand.kind === ts.SyntaxKind.FalseKeyword) return ts.factory.createTrue();
        return operand === expression.operand ? expression : ts.factory.createPrefixUnaryExpression(expression.operator, operand);
      }
      if (ts.isConditionalExpression(expression)) {
        const condition = substitute(expression.condition, bindings, new Set(seen));
        const whenTrue = substitute(expression.whenTrue, bindings, new Set(seen));
        const whenFalse = substitute(expression.whenFalse, bindings, new Set(seen));
        if (condition.kind === ts.SyntaxKind.TrueKeyword) return whenTrue;
        if (condition.kind === ts.SyntaxKind.FalseKeyword) return whenFalse;
        return condition === expression.condition && whenTrue === expression.whenTrue && whenFalse === expression.whenFalse
          ? expression
          : ts.factory.createConditionalExpression(condition, expression.questionToken, whenTrue, expression.colonToken, whenFalse);
      }
      if (ts.isCallExpression(expression)) {
        const args = expression.arguments.map((argument) => substitute(argument, bindings, new Set(seen)));
        return args.every((argument, index) => argument === expression.arguments[index]) ? expression
          : ts.factory.createCallExpression(expression.expression, expression.typeArguments, args);
      }
      if (ts.isNewExpression(expression)) {
        const args = expression.arguments?.map((argument) => substitute(argument, bindings, new Set(seen)));
        return args?.every((argument, index) => argument === expression.arguments?.[index]) !== false ? expression
          : ts.factory.createNewExpression(expression.expression, expression.typeArguments, args);
      }
      if (ts.isBinaryExpression(expression)
        && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        const left = substitute(expression.left, bindings, new Set(seen));
        const leftBoolean = left.kind === ts.SyntaxKind.TrueKeyword ? true
          : left.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
        if (leftBoolean !== undefined) {
          if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            return leftBoolean ? substitute(expression.right, bindings, new Set(seen)) : left;
          }
          return leftBoolean ? left : substitute(expression.right, bindings, new Set(seen));
        }
        const right = substitute(expression.right, bindings, new Set(seen));
        return left === expression.left && right === expression.right ? expression
          : ts.factory.createBinaryExpression(left, expression.operatorToken, right);
      }
      if (ts.isBinaryExpression(expression)
        && (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
        const left = substitute(expression.left, bindings, new Set(seen));
        const right = substitute(expression.right, bindings, new Set(seen));
        const leftValue = staticPrimitive(left), rightValue = staticPrimitive(right);
        if (leftValue && rightValue) {
          const equal = leftValue.kind === rightValue.kind && leftValue.value === rightValue.value;
          return equal === (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
            ? ts.factory.createTrue() : ts.factory.createFalse();
        }
        return left === expression.left && right === expression.right ? expression
          : ts.factory.createBinaryExpression(left, expression.operatorToken, right);
      }
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = substitute(expression.left, bindings, new Set(seen));
        const right = substitute(expression.right, bindings, new Set(seen));
        return left === expression.left && right === expression.right ? expression
          : ts.factory.createBinaryExpression(left, expression.operatorToken, right);
      }
      if (ts.isTemplateExpression(expression)) {
        const spans = expression.templateSpans.map((span) => {
          const embedded = substitute(span.expression, bindings, new Set(seen));
          return embedded === span.expression ? span : ts.factory.createTemplateSpan(embedded, span.literal);
        });
        return spans.every((span, index) => span === expression.templateSpans[index]) ? expression
          : ts.factory.createTemplateExpression(expression.head, spans);
      }
      return expression;
    };
    const safeAliasExpression = (expression: ts.Expression): boolean => ts.isIdentifier(expression)
      || ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression)
      || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
      || expression.kind === ts.SyntaxKind.NullKeyword;
    type FlowPath = { branches: ts.Expression[]; failure?: "step"; completes: boolean; conditions?: Map<ts.Symbol | string, boolean>; bindings?: Map<ts.Symbol, ts.Expression> };
    type ConditionConstraint = { key: ts.Symbol | string; value: boolean } | { constant: boolean };
    const conditionConstraint = (expression: ts.Expression, bindings?: Map<ts.Symbol, ts.Expression>): ConditionConstraint | undefined => {
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (expression.kind === ts.SyntaxKind.TrueKeyword) return { constant: true };
      if (expression.kind === ts.SyntaxKind.FalseKeyword) return { constant: false };
      if (ts.isIdentifier(expression)) {
        const bound = bindings?.get(resolvedSymbol(expression)!);
        if (bound) return conditionConstraint(bound, bindings);
        const replacement = substitutions.get(resolvedSymbol(expression)!);
        if (replacement) return conditionConstraint(replacement, bindings);
        return { key: resolvedSymbol(expression) ?? `text:${expression.getText(expression.getSourceFile())}`, value: true };
      }
      if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = conditionConstraint(expression.operand, bindings);
        if (!inner) return undefined;
        return "constant" in inner ? { constant: !inner.constant } : { ...inner, value: !inner.value };
      }
      return undefined;
    };
    const constrain = (path: FlowPath, constraint: ConditionConstraint, branch: boolean): FlowPath | undefined => {
      if ("constant" in constraint) return constraint.constant === branch ? path : undefined;
      const required = branch ? constraint.value : !constraint.value;
      const existing = path.conditions?.get(constraint.key);
      if (existing !== undefined && existing !== required) return undefined;
      const conditions = new Map(path.conditions);
      conditions.set(constraint.key, required);
      return { ...path, conditions };
    };
    const statementsOf = (node: ts.Statement): readonly ts.Statement[] => ts.isBlock(node) ? node.statements : [node];
    let pathLimitExceeded = false;
    const flow = (statements: readonly ts.Statement[], initial: FlowPath[] = [{ branches: [], completes: true }]): FlowPath[] | undefined => {
      let paths = initial;
      for (const statement of statements) {
        const next: FlowPath[] = [];
        for (const path of paths) {
          if (!path.completes) { next.push(path); continue; }
          if (ts.isExpressionStatement(statement) && ts.isYieldExpression(statement.expression)
            && statement.expression.asteriskToken && statement.expression.expression) {
            const evidence: StaticArrayExpansionEvidence = { invokesUserCode: false };
            const operand = statement.expression.expression;
            const delegatedEntries = expandStaticArray(operand, new Set(), evidence)
              ?? expandStaticSet(statement.expression.expression);
            if (delegatedEntries && !evidence.paths && !evidence.failure && !evidence.invokesUserCode) {
              next.push({ ...path, branches: [...path.branches, ...delegatedEntries.map((branch) =>
                ts.isOmittedExpression(branch) ? branch : substitute(branch, path.bindings))] as ts.Expression[] });
            } else {
              const delegatedOperand = ts.isCallExpression(operand)
                ? ts.factory.updateCallExpression(operand, operand.expression, operand.typeArguments,
                  operand.arguments.map((argument) => substitute(argument, path.bindings)))
                : substitute(operand, path.bindings);
              const delegated = localIterable(delegatedOperand, new Set(), generatorStack);
              if (!delegated || delegated.unsupportedReason) return undefined;
              const delegatedPaths = delegated.paths ?? [{
                branches: delegated.branches,
                ...(delegated.failure ? { failure: delegated.failure } : {}),
              }];
              for (const delegatedPath of delegatedPaths) {
                const conditions = new Map(path.conditions);
                let compatible = true;
                for (const [key, value] of delegatedPath.conditions ?? []) {
                  const existing = conditions.get(key);
                  if (existing !== undefined && existing !== value) { compatible = false; break; }
                  conditions.set(key, value);
                }
                if (!compatible) continue;
                next.push({
                  ...path,
                  branches: [...path.branches, ...delegatedPath.branches],
                  ...(delegatedPath.failure ? { failure: "step" as const, completes: false } : {}),
                  ...(conditions.size ? { conditions } : {}),
                });
              }
            }
          } else if (ts.isExpressionStatement(statement) && ts.isYieldExpression(statement.expression)
            && !statement.expression.asteriskToken) {
            next.push({ ...path, branches: [...path.branches, statement.expression.expression
              ? substitute(statement.expression.expression, path.bindings) : statement.expression] });
          } else if (ts.isVariableStatement(statement)
            && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
            && statement.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name)
              && Boolean(declaration.initializer))) {
            const bindings = new Map(path.bindings);
            for (const declaration of statement.declarationList.declarations) {
              const symbol = resolvedSymbol(declaration.name as ts.Identifier);
              if (!symbol || !declaration.initializer) return undefined;
              const value = substitute(declaration.initializer, bindings);
              if (!safeAliasExpression(declaration.initializer) && !staticPrimitive(value)) return undefined;
              bindings.set(symbol, value);
            }
            next.push({ ...path, bindings });
          } else if (ts.isThrowStatement(statement)) next.push({ ...path, failure: "step", completes: false });
          else if (ts.isReturnStatement(statement)) next.push({ ...path, completes: false });
          else if (ts.isIfStatement(statement)) {
            const condition = conditionConstraint(statement.expression, path.bindings);
            if (!condition) return undefined;
            const trueInput = constrain({ ...path, branches: [...path.branches] }, condition, true);
            const falseInput = constrain({ ...path, branches: [...path.branches] }, condition, false);
            const truePaths = trueInput ? flow(statementsOf(statement.thenStatement), [trueInput]) : [];
            const falsePaths = statement.elseStatement
              ? falseInput ? flow(statementsOf(statement.elseStatement), [falseInput]) : []
              : falseInput ? [falseInput] : [];
            if (!truePaths || !falsePaths) return undefined;
            next.push(...[...truePaths, ...falsePaths].map((branchPath) => ({ ...branchPath, bindings: path.bindings })));
          } else if (ts.isForOfStatement(statement) && !statement.awaitModifier
            && ts.isVariableDeclarationList(statement.initializer)
            && statement.initializer.declarations.length === 1
            && ts.isIdentifier(statement.initializer.declarations[0]!.name)) {
            const declaration = statement.initializer.declarations[0]!, symbol = resolvedSymbol(declaration.name);
            const evidence: StaticArrayExpansionEvidence = { invokesUserCode: false };
            const elements = expandStaticArray(statement.expression, new Set(), evidence) ?? expandStaticSet(statement.expression);
            if (!symbol || !elements || elements.some(ts.isOmittedExpression)
              || evidence.paths || evidence.failure || evidence.invokesUserCode) return undefined;
            let loopPaths: FlowPath[] = [path];
            for (const element of elements) {
              const inputs = loopPaths.map((loopPath) => {
                if (!loopPath.completes) return loopPath;
                const bindings = new Map(loopPath.bindings);
                bindings.set(symbol, substitute(element as ts.Expression, loopPath.bindings));
                return { ...loopPath, bindings };
              });
              const iteration = flow(statementsOf(statement.statement), inputs);
              if (!iteration) return undefined;
              loopPaths = iteration.map((iterationPath) => {
                const bindings = new Map(path.bindings);
                if (iterationPath.completes) bindings.set(symbol, substitute(element as ts.Expression, path.bindings));
                return { ...iterationPath, bindings };
              });
            }
            next.push(...loopPaths.map((loopPath) => ({ ...loopPath, bindings: path.bindings })));
          } else if (ts.isBlock(statement)) {
            const scoped = flow(statement.statements, [{ ...path, bindings: path.bindings }]);
            if (!scoped) return undefined;
            next.push(...scoped.map((blockPath) => ({ ...blockPath, bindings: path.bindings })));
          } else if (ts.isEmptyStatement(statement)) next.push(path);
          else return undefined;
        }
        paths = next;
        if (paths.length > MAX_FINITE_ITERABLE_PATHS) { pathLimitExceeded = true; return undefined; }
      }
      return paths;
    };
    const flowed = flow(body.statements);
    if (!flowed?.length) return {
      branches: [],
      unsupportedReason: pathLimitExceeded ? "finite-path-limit" : "unsupported-generator-control-flow",
    };
    const finitePaths = flowed.map(({ branches, failure, conditions }) => ({ branches, ...(failure ? { failure } : {}), ...(conditions?.size ? { conditions } : {}) }));
    if (finitePaths.length === 1) return {
      branches: finitePaths[0]!.branches,
      ...(finitePaths[0]!.failure ? { failure: finitePaths[0]!.failure } : {}),
    };
    const result: FiniteIterableExpansion = { branches: finitePaths[0]!.branches, paths: finitePaths };
    if (finitePaths.length === 2) {
      result.alternatives = [finitePaths[0]!.branches, finitePaths[1]!.branches];
      const trueFailure = finitePaths[0]!.failure, falseFailure = finitePaths[1]!.failure;
      result.failure = trueFailure ?? falseFailure;
      result.failurePresence = Boolean(trueFailure) !== Boolean(falseFailure)
        ? trueFailure ? "when-true" : "when-false" : undefined;
    } else result.failure = finitePaths.find((path) => path.failure)?.failure;
    return result;
  };
  function localIterable(
    expression: ts.Expression | undefined,
    seen = new Set<ts.Symbol>(),
    generatorStack = new Set<ts.Symbol>(),
  ): FiniteIterableExpansion | undefined {
    if (!expression) return undefined;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return localIterable(expression.expression, seen, generatorStack);
    }
    let declaration: ts.Declaration | undefined;
    let expressionSymbol: ts.Symbol | undefined;
    if (ts.isIdentifier(expression)) {
      const symbol = resolvedSymbol(expression);
      expressionSymbol = symbol;
      if (symbol && seen.has(symbol)) return undefined;
      declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isVariableDeclaration);
    }
    else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) declaration = resolvedSymbol(expression.expression)?.valueDeclaration;
    if (expressionSymbol && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && !ts.isObjectLiteralExpression(declaration.initializer) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(expressionSymbol);
      return localIterable(declaration.initializer, nextSeen, generatorStack);
    }
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
      const iterator = declaration.initializer.properties.find((property) => {
        if (!property.name || !ts.isComputedPropertyName(property.name) || !ts.isPropertyAccessExpression(property.name.expression)) return false;
        const access = property.name.expression;
        return access.expression.getText() === "Symbol" && access.name.text === "iterator"
          && (resolvedSymbol(access.name)?.declarations?.some((item) => item.getSourceFile().isDeclarationFile) ?? false);
      });
      if (iterator && ts.isMethodDeclaration(iterator) && iterator.body) {
        if (iterator.asteriskToken) {
          if (expressionSymbol && generatorStack.has(expressionSymbol)) return {
            branches: [],
            unsupportedReason: "unsupported-generator-control-flow",
          };
          const nextGeneratorStack = new Set(generatorStack);
          if (expressionSymbol) nextGeneratorStack.add(expressionSymbol);
          return linearGeneratorBody(iterator.body, new Map(), nextGeneratorStack);
        }
        const containsThrow = (node: ts.Node): boolean => {
          if (ts.isThrowStatement(node)) return true;
          let found = false;
          ts.forEachChild(node, (child) => { if (!found && !(child !== node && ts.isFunctionLike(child))) found = containsThrow(child); });
          return found;
        };
        if (iterator.body.statements.some(containsThrow)) return { branches: [], failure: "acquire" };
        const returned = iterator.body.statements.find((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && Boolean(statement.expression));
        const iteratorObject = returned?.expression && ts.isObjectLiteralExpression(returned.expression) ? returned.expression : undefined;
        const next = iteratorObject?.properties.find((item) => item.name?.getText() === "next");
        if (next && ts.isGetAccessorDeclaration(next) && next.body && containsThrow(next.body)) return { branches: [], failure: "acquire" };
        if (next && ts.isMethodDeclaration(next) && next.body) {
          if (next.body.statements.some(containsThrow)) return { branches: [], failure: "step" };
          const resultReturn = next.body.statements.find((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && Boolean(statement.expression));
          const result = resultReturn?.expression && ts.isObjectLiteralExpression(resultReturn.expression) ? resultReturn.expression : undefined;
          const failingResultGetter = result?.properties.some((item) => item.name && ["done", "value"].includes(item.name.getText())
            && ts.isGetAccessorDeclaration(item) && item.body && containsThrow(item.body));
          if (failingResultGetter) return { branches: [], failure: "step" };
        }
        return { branches: [] };
      }
    }
    if (declaration && ts.isFunctionDeclaration(declaration) && !declaration.asteriskToken && declaration.body
      && ts.isCallExpression(expression) && declaration.body.statements.length === 1) {
      const returned = declaration.body.statements[0];
      const object = ts.isReturnStatement(returned) && returned.expression && ts.isObjectLiteralExpression(returned.expression)
        ? returned.expression : undefined;
      const iterator = object?.properties.find((property) => {
        if (!property.name || !ts.isComputedPropertyName(property.name) || !ts.isPropertyAccessExpression(property.name.expression)) return false;
        const access = property.name.expression;
        return access.expression.getText() === "Symbol" && access.name.text === "iterator"
          && (resolvedSymbol(access.name)?.declarations?.some((item) => item.getSourceFile().isDeclarationFile) ?? false);
      });
      if (iterator && ts.isMethodDeclaration(iterator) && iterator.asteriskToken && iterator.body) {
        const factorySymbol = declaration.name && resolvedSymbol(declaration.name);
        if (factorySymbol && generatorStack.has(factorySymbol)) return {
          branches: [],
          unsupportedReason: "unsupported-generator-control-flow",
        };
        const nextGeneratorStack = new Set(generatorStack);
        if (factorySymbol) nextGeneratorStack.add(factorySymbol);
        const substitutions = new Map<ts.Symbol, ts.Expression>();
        declaration.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name) || !expression.arguments[index]) return;
          const symbol = resolvedSymbol(parameter.name);
          if (symbol) substitutions.set(symbol, expression.arguments[index]);
        });
        return linearGeneratorBody(iterator.body, substitutions, nextGeneratorStack);
      }
    }
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.asteriskToken && declaration.body) {
      const generatorSymbol = declaration.name && resolvedSymbol(declaration.name);
      if (generatorSymbol && generatorStack.has(generatorSymbol)) return {
        branches: [],
        unsupportedReason: "unsupported-generator-control-flow",
      };
      const nextGeneratorStack = new Set(generatorStack);
      if (generatorSymbol) nextGeneratorStack.add(generatorSymbol);
      const substitutions = new Map<ts.Symbol, ts.Expression>();
      if (ts.isCallExpression(expression)) declaration.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || !expression.arguments[index]) return;
        const symbol = resolvedSymbol(parameter.name);
        if (symbol) substitutions.set(symbol, expression.arguments[index]);
      });
      return linearGeneratorBody(declaration.body, substitutions, nextGeneratorStack);
    }
    return undefined;
  }
  const resolveCallback = (callback: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined => {
    if (!callback) return undefined;
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) return callback;
    const location = ts.isPropertyAccessExpression(callback) ? callback.name
      : ts.isElementAccessExpression(callback) && callback.argumentExpression ? callback.argumentExpression
        : callback;
    if (!ts.isIdentifier(callback) && !ts.isPropertyAccessExpression(callback) && !ts.isElementAccessExpression(callback)) return undefined;
    const original = checker.getSymbolAtLocation(location);
    const symbol = original && (original.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(original) : original;
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
      if (ts.isMethodDeclaration(declaration) && declaration.body) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    }
    return undefined;
  };
  const resolveCallbacks = (
    callback: ts.Expression | undefined,
    seen = new Set<ts.Symbol>(),
    substitutions = new Map<ts.Symbol, ts.Expression>(),
    receiver?: ts.Expression,
  ): ts.FunctionLikeDeclaration[] => {
    if (!callback) return [];
    if (ts.isIdentifier(callback)) {
      const symbol = resolvedSymbol(callback), replacement = symbol && substitutions.get(symbol);
      if (symbol && replacement) {
        const nextSubstitutions = new Map(substitutions);
        nextSubstitutions.delete(symbol);
        return resolveCallbacks(replacement, seen, nextSubstitutions, receiver);
      }
    }
    if (ts.isParenthesizedExpression(callback) || ts.isAsExpression(callback) || ts.isTypeAssertionExpression(callback) || ts.isNonNullExpression(callback)) {
      return resolveCallbacks(callback.expression, seen, substitutions, receiver);
    }
    if (ts.isConditionalExpression(callback)) {
      const whenTrue = resolveCallbacks(callback.whenTrue, new Set(seen), new Map(substitutions), receiver);
      const whenFalse = resolveCallbacks(callback.whenFalse, new Set(seen), new Map(substitutions), receiver);
      return whenTrue.length > 0 && whenFalse.length > 0 ? [...new Set([...whenTrue, ...whenFalse])] : [];
    }
    if (ts.isCallExpression(callback)) {
      const factory = resolvedSymbol(callback.expression);
      if (!factory || seen.has(factory)) return [];
      type ReturnFlow = { expressions: ts.Expression[]; definite: boolean };
      const statementFlow = (statement: ts.Statement): ReturnFlow | undefined => {
        if (ts.isReturnStatement(statement)) return { expressions: statement.expression ? [statement.expression] : [], definite: true };
        if (ts.isThrowStatement(statement)) return { expressions: [], definite: true };
        if (ts.isBlock(statement)) return blockFlow(statement);
        if (ts.isIfStatement(statement)) {
          const whenTrue = statementFlow(statement.thenStatement), whenFalse = statement.elseStatement
            ? statementFlow(statement.elseStatement) : { expressions: [], definite: false };
          return whenTrue && whenFalse ? {
            expressions: [...whenTrue.expressions, ...whenFalse.expressions],
            definite: whenTrue.definite && whenFalse.definite,
          } : undefined;
        }
        if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement) || ts.isEmptyStatement(statement)) {
          return { expressions: [], definite: false };
        }
        return undefined;
      };
      const blockFlow = (block: ts.Block): ReturnFlow | undefined => {
        const expressions: ts.Expression[] = [];
        for (const statement of block.statements) {
          const flow = statementFlow(statement);
          if (!flow) return undefined;
          expressions.push(...flow.expressions);
          if (flow.definite) return { expressions, definite: true };
        }
        return { expressions, definite: false };
      };
      const flows = factory.declarations?.flatMap((declaration): { flow: ReturnFlow; functionLike: ts.FunctionLikeDeclaration }[] => {
        const functionLike = ts.isFunctionLike(declaration) && "body" in declaration && declaration.body ? declaration
          : ts.isVariableDeclaration(declaration) && declaration.initializer
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? declaration.initializer : undefined;
        if (!functionLike?.body) return [];
        const body = functionLike.body as ts.ConciseBody;
        const flow = ts.isBlock(body) ? blockFlow(body) : { expressions: [body], definite: true };
        return flow ? [{ flow, functionLike }] : [];
      }) ?? [];
      if (flows.length === 0 || flows.some(({ flow }) => !flow.definite || flow.expressions.length === 0)) return [];
      const nextSeen = new Set([...seen, factory]);
      const callReceiver = ts.isPropertyAccessExpression(callback.expression) || ts.isElementAccessExpression(callback.expression)
        ? callback.expression.expression : undefined;
      const callbacks = flows.flatMap(({ flow, functionLike }) => {
        const callSubstitutions = new Map(substitutions);
        for (const [index, parameter] of functionLike.parameters.entries()) {
          if (!ts.isIdentifier(parameter.name) || !callback.arguments[index]) continue;
          const symbol = resolvedSymbol(parameter.name);
          if (symbol) callSubstitutions.set(symbol, callback.arguments[index]);
        }
        return flow.expressions.map((expression) =>
          resolveCallbacks(expression, new Set(nextSeen), new Map(callSubstitutions), callReceiver));
      });
      return callbacks.every((candidates) => candidates.length > 0) ? [...new Set(callbacks.flat())] : [];
    }
    if (ts.isElementAccessExpression(callback) && callback.argumentExpression) {
      const literalKeys = (expression: ts.Expression): string[] | undefined => {
        if (ts.isIdentifier(expression)) {
          const symbol = resolvedSymbol(expression), replacement = symbol && substitutions.get(symbol);
          if (replacement) return literalKeys(replacement);
        }
        const initializer = immutableInitializer(expression);
        if (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
          || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer)) return literalKeys(initializer.expression);
        if (ts.isConditionalExpression(initializer)) {
          const whenTrue = literalKeys(initializer.whenTrue), whenFalse = literalKeys(initializer.whenFalse);
          return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])] : undefined;
        }
        return ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer) ? [initializer.text] : undefined;
      };
      const immutableMemberInitializer = (expression: ts.Expression): ts.Expression => {
        if (!ts.isPropertyAccessExpression(expression)) return immutableInitializer(expression);
        const baseExpression = expression.expression.kind === ts.SyntaxKind.ThisKeyword && receiver
          ? receiver : expression.expression;
        let base = immutableInitializer(baseExpression);
        while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base)
          || ts.isTypeAssertionExpression(base) || ts.isNonNullExpression(base)) base = base.expression;
        if (!ts.isObjectLiteralExpression(base)) return expression;
        const property = base.properties.find((candidate) => candidate.name
          && !ts.isComputedPropertyName(candidate.name)
          && candidate.name.getText(candidate.getSourceFile()).replace(/^['"]|['"]$/g, "") === expression.name.text);
        return property && ts.isPropertyAssignment(property) ? immutableInitializer(property.initializer) : expression;
      };
      const keys = literalKeys(callback.argumentExpression), container = immutableMemberInitializer(callback.expression);
      const object = ts.isAsExpression(container) && container.type.getText(container.getSourceFile()) === "const"
        && ts.isObjectLiteralExpression(container.expression) ? container.expression : undefined;
      if (keys && object) {
        const members = keys.map((key) => object.properties.find((property) => {
          if (!property.name || ts.isComputedPropertyName(property.name)) return false;
          return property.name.getText(property.getSourceFile()).replace(/^['"]|['"]$/g, "") === key;
        })).map((property): ts.Expression | undefined => {
          if (property && ts.isPropertyAssignment(property)) return property.initializer;
          if (property && ts.isShorthandPropertyAssignment(property)) {
            const symbol = checker.getShorthandAssignmentValueSymbol(property);
            return symbol?.valueDeclaration && ts.isVariableDeclaration(symbol.valueDeclaration)
              ? symbol.valueDeclaration.name as ts.Expression : property.name;
          }
          return undefined;
        });
        if (members.every((member): member is ts.Expression => member !== undefined)) {
          const callbacks = members.map((member) => resolveCallbacks(member, new Set(seen), new Map(substitutions), receiver));
          if (callbacks.every((candidates) => candidates.length > 0)) return [...new Set(callbacks.flat())];
        }
      }
    }
    const resolved = resolveCallback(callback);
    return resolved ? [resolved] : [];
  };
  const scheduledCallbacks = new Set<ts.FunctionLikeDeclaration>();
  const invokedSignalFactories = new Set<ts.FunctionLikeDeclaration>();
  const inlineAbortTimeoutTargets = new Map<ts.CallExpression, number>();
  const inlineAbortCompositionTargets = new Map<ts.CallExpression, AbortTarget>();
  const collectScheduledCallbacks = (node: ts.Node, owner?: ts.FunctionLikeDeclaration): void => {
    const currentOwner = ts.isFunctionLike(node) && "body" in node && node.body ? node as ts.FunctionLikeDeclaration : owner;
    if (ts.isCallExpression(node)) {
      const operation = adapter.resolveCall(node)?.operation;
      if (operation?.kind === "timer" || operation?.kind === "scheduler-post-task") {
        for (const callback of resolveCallbacks(node.arguments[operation.callbackArgument])) {
          if (callback !== currentOwner) scheduledCallbacks.add(callback);
        }
      } else if (operation?.kind === "fs" && operation.callbackArgumentFromEnd && operation.callbackQueue) {
        for (const callback of resolveCallbacks(node.arguments[node.arguments.length - operation.callbackArgumentFromEnd])) {
          if (callback !== currentOwner) scheduledCallbacks.add(callback);
        }
      } else if (operation?.kind === "deferred-callback") {
        for (const callback of resolveCallbacks(node.arguments[node.arguments.length - operation.callbackArgumentFromEnd])) {
          if (callback !== currentOwner) scheduledCallbacks.add(callback);
        }
      }
      if (!operation) {
        const type = checker.getTypeAtLocation(node);
        const abortProperty = checker.getPropertyOfType(type, "aborted");
        const isAbortSignal = abortProperty?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
          && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "AbortSignal");
        if (isAbortSignal) for (const declaration of resolvedSymbol(node.expression)?.declarations ?? []) {
          if (ts.isFunctionLike(declaration) && "body" in declaration && declaration.body) invokedSignalFactories.add(declaration as ts.FunctionLikeDeclaration);
        }
      }
    }
    ts.forEachChild(node, (child) => collectScheduledCallbacks(child, currentOwner));
  };
  collectScheduledCallbacks(source);
  const visitFunction = (owner: ts.FunctionLikeDeclaration | ts.SourceFile): void => {
    const ownerBody = ts.isSourceFile(owner) ? owner : owner.body;
    if (!ownerBody) return;
    const ownerName = functionName(owner);
    const handleAliases = new Map<string, string>();
    const handleTargets = new Map<string, number>();
    const abortSignalTargets = new Map<string, AbortTarget>();
    const taskControllers = new Map<string, { priority: NonNullable<TimerPattern["priority"]>; tasks: number[] }>();
    const staticPriority = (expression: ts.Expression | undefined): TimerPattern["priority"] => expression && ts.isStringLiteralLike(expression)
      && (expression.text === "user-blocking" || expression.text === "user-visible" || expression.text === "background") ? expression.text : undefined;
    type StaticOptionResult = { status: "found"; value: ts.Expression } | { status: "missing" | "unknown" };
    const resolveStaticObjectOption = (expression: ts.Expression | undefined, name: string): StaticOptionResult => {
      if (!expression) return { status: "missing" };
      expression = immutableInitializer(expression);
      while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
      if (!ts.isObjectLiteralExpression(expression)) return { status: "unknown" };
      const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined => {
        if (!property.name) return undefined;
        if (!ts.isComputedPropertyName(property.name)) return property.name.getText(property.getSourceFile()).replaceAll(/["']/g, "");
        const key = evaluateStaticPrimitive(property.name.expression, {
          resolveIdentifier: (identifier) => {
            const symbol = resolvedSymbol(identifier);
            if (!symbol) return undefined;
            const initializer = immutableInitializer(identifier);
            return { key: symbol, ...(initializer === identifier ? {} : { expression: initializer }) };
          },
        });
        return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
      };
      for (const property of [...expression.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) {
          const selected = resolveStaticObjectOption(property.expression, name);
          if (selected.status === "found" || selected.status === "unknown") return selected;
          continue;
        }
        const key = propertyName(property);
        if (key === undefined && property.name && ts.isComputedPropertyName(property.name)) return { status: "unknown" };
        if (key !== name) continue;
        if (ts.isPropertyAssignment(property)) return { status: "found", value: property.initializer };
        if (ts.isShorthandPropertyAssignment(property)) return { status: "found", value: property.name };
        return { status: "unknown" };
      }
      return { status: "missing" };
    };
    const staticObjectOption = (expression: ts.Expression | undefined, name: string): ts.Expression | undefined => {
      const result = resolveStaticObjectOption(expression, name);
      return result.status === "found" ? result.value : undefined;
    };
    const taskControllerConstructor = (expression: ts.Expression): boolean => {
      if (!ts.isIdentifier(expression) || expression.text !== "TaskController") return false;
      return resolvedSymbol(expression)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
    };
    const controllerForSignal = (expression: ts.Expression | undefined): { name: string; state: { priority: NonNullable<TimerPattern["priority"]>; tasks: number[] } } | undefined => {
      if (!expression || !ts.isPropertyAccessExpression(expression) || expression.name.text !== "signal" || !ts.isIdentifier(expression.expression)) return undefined;
      const state = taskControllers.get(expression.expression.text);
      return state ? { name: expression.expression.text, state } : undefined;
    };
    const assignedBinding = (call: ts.CallExpression): string | undefined => ts.isVariableDeclaration(call.parent) && call.parent.initializer === call && ts.isIdentifier(call.parent.name) ? call.parent.name.text
      : ts.isBinaryExpression(call.parent) && call.parent.right === call && call.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(call.parent.left) ? call.parent.left.text
        : undefined;
    const timerHandleKind = (call: ts.CallExpression): TimerPattern["handleKind"] => {
      const type = checker.getTypeAtLocation(call);
      const members = type.isUnion() ? type.types : [type];
      if (members.every((member) => Boolean(member.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)))) return "number";
      if (members.every((member) => Boolean(member.flags & ts.TypeFlags.Object))) return "object";
      return "unknown";
    };
    const immediatelyConsumedConstInitializer = (value: ts.Expression, use: ts.Node): ts.Expression | undefined => {
      if (!ts.isIdentifier(value)) return undefined;
      const declaration = resolvedSymbol(value)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0
        || declaration.parent.declarations.length !== 1 || !ts.isVariableStatement(declaration.parent.parent)) return undefined;
      const declarationStatement = declaration.parent.parent;
      let useStatement: ts.Node = use;
      while (useStatement.parent && !ts.isBlock(useStatement.parent) && !ts.isSourceFile(useStatement.parent)) useStatement = useStatement.parent;
      if (declarationStatement.parent !== useStatement.parent || (!ts.isBlock(useStatement.parent) && !ts.isSourceFile(useStatement.parent))) return undefined;
      const statements = useStatement.parent.statements;
      return statements.indexOf(useStatement as ts.Statement) === statements.indexOf(declarationStatement) + 1
        ? declaration.initializer : undefined;
    };
    const abortTarget = (expression: ts.Expression, seen = new Set<ts.Symbol>(), bindings = new Map<ts.Symbol, ts.Expression>()): AbortTarget | undefined => {
      if (ts.isIdentifier(expression)) {
        const symbol = resolvedSymbol(expression);
        const bound = symbol && bindings.get(symbol);
        return bound ? abortTarget(bound, seen, bindings) : abortSignalTargets.get(expression.text);
      }
      if (!ts.isCallExpression(expression)) return undefined;
      const operation = adapter.resolveCall(expression)?.operation;
      if (operation?.kind === "abort-static") return {
        alreadyAborted: true,
        reason: expression.arguments[operation.reasonArgument]?.getText(source) ?? "AbortError",
      };
      if (operation?.kind === "abort-any") {
        const existing = bindings.size === 0 ? inlineAbortCompositionTargets.get(expression) : undefined;
        if (existing !== undefined) return existing;
        const argument = expression.arguments[operation.signalsArgument];
        let normalizedArgument = argument && (immediatelyConsumedConstInitializer(argument, expression) ?? argument);
        while (normalizedArgument && ts.isParenthesizedExpression(normalizedArgument)) normalizedArgument = normalizedArgument.expression;
        const conditionalPaths = normalizedArgument && ts.isConditionalExpression(normalizedArgument)
          ? [expandStaticArray(normalizedArgument.whenTrue), expandStaticArray(normalizedArgument.whenFalse)] : undefined;
        const validConditionalPaths = conditionalPaths?.every((path): path is (ts.Expression | ts.OmittedExpression)[] => Boolean(path))
          ? conditionalPaths as (ts.Expression | ts.OmittedExpression)[][] : undefined;
        const singlePath = validConditionalPaths ? undefined : argument ? expandStaticArray(argument) : undefined;
        const paths = validConditionalPaths ?? (singlePath ? [singlePath] : undefined);
        if (!paths || !paths.flat().every((element): element is ts.Expression => !ts.isOmittedExpression(element))) return undefined;
        const elements = paths.flat() as ts.Expression[];
        const targets = elements.map((element) => abortTarget(element, seen, bindings));
        let offset = 0;
        const sourcePaths = paths.map((path) => {
          const start = offset;
          offset += path.length;
          return Array.from({ length: path.length }, (_, index) => start + index);
        });
        const initiallyAbortedSources = sourcePaths.map((path) => path.find((source) => targets[source]?.alreadyAborted));
        const composition = abortCompositions.length;
        const initiallyAbortedSource = validConditionalPaths ? -1 : targets.findIndex((target) => target?.alreadyAborted);
        const expressionSource = expression.getSourceFile();
        abortCompositions.push({
          owner: ownerName,
          sources: elements.map((element) => element.getText(expressionSource)),
          sourceTimers: targets.map((target) => target?.timer),
          sourceCompositions: targets.map((target) => target?.composition),
          sourceReasons: targets.map((target) => target?.reason),
          initiallyAbortedSource: initiallyAbortedSource < 0 ? undefined : initiallyAbortedSource,
          ...(validConditionalPaths ? { sourcePaths, initiallyAbortedSources } : {}),
          span: { start: expression.getStart(expressionSource), end: expression.getEnd() },
        });
        const target: AbortTarget = {
          composition,
          alreadyAborted: initiallyAbortedSource >= 0,
          reason: initiallyAbortedSource < 0 ? undefined : targets[initiallyAbortedSource]?.reason,
        };
        if (bindings.size === 0) inlineAbortCompositionTargets.set(expression, target);
        return target;
      }
      if (operation?.kind !== "abort-timeout") {
        const factory = resolvedSymbol(expression.expression);
        if (!factory || seen.has(factory)) return undefined;
        seen.add(factory);
        const declarations = factory.declarations?.filter((declaration): declaration is ts.FunctionLikeDeclaration =>
          ts.isFunctionLike(declaration) && "body" in declaration && Boolean(declaration.body)) ?? [];
        const returned = declarations.flatMap((declaration) => {
          const body = declaration.body as ts.ConciseBody;
          if (!ts.isBlock(body)) return [body];
          return body.statements.flatMap((statement) =>
            ts.isReturnStatement(statement) && statement.expression ? [statement.expression] : []);
        }) ?? [];
        if (declarations.length !== 1 || returned.length !== 1) return undefined;
        const nextBindings = new Map(bindings);
        declarations[0]!.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name) || !expression.arguments[index]) return;
          const parameterSymbol = resolvedSymbol(parameter.name);
          if (parameterSymbol) nextBindings.set(parameterSymbol, expression.arguments[index]!);
        });
        return abortTarget(returned[0], seen, nextBindings);
      }
      const existing = bindings.size === 0 ? inlineAbortTimeoutTargets.get(expression) : undefined;
      if (existing !== undefined) return { timer: existing, reason: "TimeoutError" };
      const delayNode = expression.arguments[0];
      const timer = timers.length;
      timers.push({
        owner: ownerName,
        callback: "<abort>",
        delay: delayNode && ts.isNumericLiteral(delayNode) ? Number(delayNode.text) : undefined,
        recursive: false,
        repeats: false,
        queue: "timer",
        kind: "abort-timeout",
        abortReason: "TimeoutError",
        span: { start: expression.getStart(source), end: expression.getEnd() },
      });
      if (bindings.size === 0) inlineAbortTimeoutTargets.set(expression, timer);
      return { timer, reason: "TimeoutError" };
    };
    const resolveHandle = (name: string): string => {
      const seen = new Set<string>();
      let current = name;
      while (handleAliases.has(current) && !seen.has(current)) { seen.add(current); current = handleAliases.get(current)!; }
      return current;
    };
    const recordEscape = (identifier: ts.Identifier, kind: TimerHandleEscape["kind"], node: ts.Node): void => {
      const timer = handleTargets.get(identifier.text);
      if (timer === undefined) return;
      timerEscapes.push({ owner: ownerName, kind, handle: resolveHandle(identifier.text), timer, span: { start: node.getStart(source), end: node.getEnd() } });
    };
    const recordEscapesInValue = (expression: ts.Expression, kind: TimerHandleEscape["kind"], node: ts.Node, visited = new Set<ts.Declaration>()): void => {
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isIdentifier(expression)) {
        if (handleTargets.has(expression.text)) recordEscape(expression, kind, node);
        else {
          const declaration = resolvedSymbol(expression)?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
            && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
            && !visited.has(declaration)) {
            visited.add(declaration);
            recordEscapesInValue(declaration.initializer, kind, node, visited);
            visited.delete(declaration);
          }
        }
      } else if (ts.isArrayLiteralExpression(expression)) {
        for (const element of expression.elements) if (!ts.isOmittedExpression(element)) {
          recordEscapesInValue(ts.isSpreadElement(element) ? element.expression : element, kind, node, visited);
        }
      } else if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (ts.isPropertyAssignment(property)) recordEscapesInValue(property.initializer, kind, node, visited);
          else if (ts.isShorthandPropertyAssignment(property)) recordEscapesInValue(property.name, kind, node, visited);
          else if (ts.isSpreadAssignment(property)) recordEscapesInValue(property.expression, kind, node, visited);
        }
      } else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        const seen = new Set<number>();
        const scanCapture = (child: ts.Node): void => {
          if (child !== expression && ts.isFunctionLike(child)) return;
          if (ts.isIdentifier(child)) {
            const timer = handleTargets.get(child.text);
            if (timer !== undefined && !seen.has(timer)) {
              seen.add(timer);
              recordEscape(child, "closure", node);
            }
          }
          ts.forEachChild(child, scanCapture);
        };
        scanCapture(expression.body);
      }
    };
    const collectNestedJobs = (callbackExpression: ts.Expression | undefined, parent: number, visited = new Set<ts.FunctionLikeDeclaration>()): void => {
      const callbacks = resolveCallbacks(callbackExpression);
      if (callbacks.length > 1) timers[parent]!.callbackAlternatives = callbacks.map((callback) => functionName(callback));
      for (const [parentAlternative, callback] of callbacks.entries()) {
        if (!callback.body || visited.has(callback)) continue;
        visited.add(callback);
        const scan = (node: ts.Node): void => {
          if (node !== callback && ts.isFunctionLike(node)) return;
          if (ts.isCallExpression(node)) {
            const operation = adapter.resolveCall(node)?.operation;
            if (operation?.kind === "timer" && (operation.queue === "microtask" || operation.queue === "next-tick" || operation.queue === "timer" || operation.queue === "check")) {
              if (operation.queue === "timer" && node.getStart(node.getSourceFile()) === timers[parent]!.span.start) return;
              const child = timers.length;
              const callbackNode = node.arguments[operation.callbackArgument];
              const delayNode = operation.delayArgument === undefined ? undefined : node.arguments[operation.delayArgument];
              const childSource = node.getSourceFile();
              timers.push({ owner: ownerName, callback: callbackNode?.getText(childSource) ?? "<unknown>", delay: operation.delayArgument === undefined ? 0 : staticNumber(delayNode), recursive: false, repeats: operation.repeats, queue: operation.queue, enqueuedBy: parent, ...(callbacks.length > 1 ? { parentAlternative } : {}), handleFamily: operation.queue === "timer" ? "timeout" : operation.queue === "check" ? "immediate" : undefined, span: { start: node.getStart(childSource), end: node.getEnd() } });
              collectNestedJobs(callbackNode, child, visited);
              return;
            } else if (operation?.kind === "scheduler-yield") {
              const childSource = node.getSourceFile();
              timers.push({
                owner: ownerName,
                callback: "<continuation>",
                delay: 0,
                recursive: false,
                repeats: false,
                queue: "scheduler-task",
                enqueuedBy: parent,
                ...(callbacks.length > 1 ? { parentAlternative } : {}),
                kind: "scheduler-yield",
                priority: timers[parent]?.priority ?? "user-visible",
                abortTimer: timers[parent]?.abortTimer,
                abortComposition: timers[parent]?.abortComposition,
                externalAbortSignal: timers[parent]?.externalAbortSignal,
                span: { start: node.getStart(childSource), end: node.getEnd() },
              });
              return;
            }
          }
          ts.forEachChild(node, scan);
        };
        scan(callback.body);
        visited.delete(callback);
      }
    };
    const visit = (node: ts.Node): void => {
      if (node !== ownerBody && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        handleAliases.set(node.name.text, resolveHandle(node.initializer.text));
        const target = handleTargets.get(node.initializer.text);
        if (target !== undefined) handleTargets.set(node.name.text, target);
        const signal = abortSignalTargets.get(node.initializer.text);
        if (signal) abortSignalTargets.set(node.name.text, signal);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isNewExpression(node.initializer) && taskControllerConstructor(node.initializer.expression)) {
        const options = node.initializer.arguments?.[0];
        const priorityProperty = options && ts.isObjectLiteralExpression(options) ? options.properties.find((property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source).replaceAll(/["']/g, "") === "priority") : undefined;
        const priority = priorityProperty && ts.isPropertyAssignment(priorityProperty) ? staticPriority(priorityProperty.initializer) : "user-visible";
        if (priority) taskControllers.set(node.name.text, { priority, tasks: [] });
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        handleAliases.delete(node.left.text);
        handleTargets.delete(node.left.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const signal = abortTarget(node.initializer);
        if (signal) abortSignalTargets.set(node.name.text, signal);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) recordEscapesInValue(node.right, "property", node);
      if (ts.isReturnStatement(node) && node.expression) recordEscapesInValue(node.expression, "return", node);
      if (ts.isCallExpression(node)) {
        const operation = adapter.resolveCall(node)?.operation;
        if (!operation && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setPriority"
          && ts.isIdentifier(node.expression.expression)) {
          const controller = taskControllers.get(node.expression.expression.text);
          const priority = staticPriority(node.arguments[0]);
          const standard = resolvedSymbol(node.expression.name)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
          if (controller && priority && standard) {
            controller.priority = priority;
            for (const task of controller.tasks) (timers[task]!.priorityChanges ??= []).push(priority);
          }
        }
        if (operation?.kind !== "timer-clear") for (const argument of node.arguments) recordEscapesInValue(argument, "argument", node);
        if (operation?.kind === "timer") {
          const callbackNode = node.arguments[operation.callbackArgument];
          const delayNode = operation.delayArgument === undefined ? undefined : node.arguments[operation.delayArgument];
          const callback = callbackNode?.getText(source) ?? "<unknown>";
          const declaration = assignedBinding(node);
          const timerIndex = timers.length;
          timers.push({
            owner: ownerName,
            callback,
            delay: operation.delayArgument === undefined ? 0 : staticNumber(delayNode),
            recursive: callback === ownerName,
            repeats: operation.repeats,
            queue: operation.queue,
            handle: declaration,
            handleKind: timerHandleKind(node),
            handleFamily: operation.queue === "timer" ? "timeout" : operation.queue === "check" ? "immediate" : operation.queue === "animation-frame" ? "animation-frame" : undefined,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          if (declaration) handleTargets.set(declaration, timerIndex);
          collectNestedJobs(callbackNode, timerIndex);
        } else if (operation?.kind === "fs" && operation.callbackArgumentFromEnd && operation.callbackQueue) {
          const callbackNode = node.arguments[node.arguments.length - operation.callbackArgumentFromEnd];
          const timerIndex = timers.length;
          timers.push({
            owner: ownerName,
            callback: callbackNode?.getText(source) ?? "<unknown>",
            delay: 0,
            recursive: false,
            repeats: false,
            queue: operation.callbackQueue,
            externallyReady: true,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          collectNestedJobs(callbackNode, timerIndex);
        } else if (operation?.kind === "deferred-callback") {
          const callbackNode = node.arguments[node.arguments.length - operation.callbackArgumentFromEnd];
          const timerIndex = timers.length;
          timers.push({
            owner: ownerName,
            callback: callbackNode?.getText(source) ?? "<unknown>",
            delay: 0,
            recursive: false,
            repeats: false,
            queue: operation.queue,
            externallyReady: true,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          collectNestedJobs(callbackNode, timerIndex);
        } else if (operation?.kind === "abort-timeout") {
          const delayNode = node.arguments[operation.delayArgument];
          const declaration = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
          const existing = inlineAbortTimeoutTargets.get(node);
          const timer = existing ?? timers.length;
          if (existing === undefined) timers.push({
            owner: ownerName,
            callback: "<abort>",
            delay: delayNode && ts.isNumericLiteral(delayNode) ? Number(delayNode.text) : undefined,
            recursive: false,
            repeats: false,
            queue: "timer",
            handle: declaration,
            kind: "abort-timeout",
            abortReason: "TimeoutError",
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          inlineAbortTimeoutTargets.set(node, timer);
          if (declaration && timers[timer]) timers[timer]!.handle = declaration;
          if (declaration) abortSignalTargets.set(declaration, { timer, reason: "TimeoutError" });
        } else if (operation?.kind === "abort-static") {
          const declaration = assignedBinding(node);
          if (declaration) abortSignalTargets.set(declaration, { alreadyAborted: true, reason: node.arguments[operation.reasonArgument]?.getText(source) ?? "AbortError" });
        } else if (operation?.kind === "abort-any") {
          const declaration = assignedBinding(node);
          const target = abortTarget(node);
          if (target?.composition !== undefined && declaration) {
            abortCompositions[target.composition]!.handle = declaration;
            abortSignalTargets.set(declaration, target);
          }
        } else if (operation?.kind === "scheduler-post-task") {
          const callbackNode = node.arguments[operation.callbackArgument];
          const optionsNode = node.arguments[operation.optionsArgument];
          const option = (name: string): ts.Expression | undefined => staticObjectOption(optionsNode, name);
          const priorityNode = option("priority");
          const signalNode = option("signal");
          const taskController = !priorityNode ? controllerForSignal(signalNode) : undefined;
          const signalSymbol = signalNode && ts.isIdentifier(signalNode) ? resolvedSymbol(signalNode) : undefined;
          const signalType = signalNode ? signalSymbol?.valueDeclaration
            ? checker.getTypeOfSymbolAtLocation(signalSymbol, signalSymbol.valueDeclaration)
            : checker.getTypeAtLocation(signalNode) : undefined;
          const signalSetsPriority = Boolean(!priorityNode && signalType && checker.getPropertyOfType(signalType, "priority"));
          const externalAbortSignal = Boolean(signalNode && !taskController && !abortTarget(signalNode) && signalType
            && checker.getPropertyOfType(signalType, "aborted")?.declarations?.some((declaration) =>
              declaration.getSourceFile().isDeclarationFile && ts.isInterfaceDeclaration(declaration.parent)
              && declaration.parent.name.text === "AbortSignal"));
          const priority = taskController?.state.priority
            ?? (priorityNode ? staticPriority(priorityNode) : signalSetsPriority ? undefined : "user-visible");
          const delayNode = option("delay");
          const delay = delayNode && ts.isNumericLiteral(delayNode) ? Number(delayNode.text) : delayNode ? undefined : 0;
          const signal = signalNode && ts.isIdentifier(signalNode) ? abortSignalTargets.get(signalNode.text) : undefined;
          const timerIndex = timers.length;
          timers.push({
            owner: ownerName,
            callback: callbackNode?.getText(source) ?? "<unknown>",
            delay,
            recursive: false,
            repeats: false,
            queue: "scheduler-task",
            kind: "scheduler-post-task",
            priority,
            priorityMutable: taskController ? true : undefined,
            priorityChanges: taskController ? [] : undefined,
            initiallyCancelled: signal?.alreadyAborted,
            abortTimer: signal?.timer,
            abortComposition: signal?.composition,
            externalAbortSignal,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          if (taskController) taskController.state.tasks.push(timerIndex);
          collectNestedJobs(callbackNode, timerIndex);
        } else if (operation?.kind === "scheduler-yield") {
          timers.push({
            owner: ownerName,
            callback: "<continuation>",
            delay: 0,
            recursive: false,
            repeats: false,
            queue: "scheduler-task",
            kind: "scheduler-yield",
            priority: "user-visible",
            span: { start: node.getStart(source), end: node.getEnd() },
          });
        } else if (operation?.kind === "timer-clear") {
          const handleNode = node.arguments[operation.handleArgument];
          const handle = handleNode && ts.isIdentifier(handleNode) ? resolveHandle(handleNode.text) : handleNode?.getText(source) ?? "<unknown>";
          let current: ts.Node = node;
          let definite = true;
          while (current.parent && current.parent !== ownerBody) {
            current = current.parent;
            if (ts.isIfStatement(current) || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
              || ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isTryStatement(current) || ts.isConditionalExpression(current)) definite = false;
          }
          const candidate = handleNode && ts.isIdentifier(handleNode) ? handleTargets.get(handleNode.text) : undefined;
          const compatible = candidate !== undefined && timers[candidate]?.handleFamily === operation.family;
          cancellations.push({ owner: ownerName, handle, timer: compatible ? candidate : undefined, definite, clearFamily: operation.family, compatible, span: { start: node.getStart(source), end: node.getEnd() } });
        } else if (operation?.kind === "promise-combinator") {
          const iterable = node.arguments[operation.iterableArgument];
          const arrayEvidence: StaticArrayExpansionEvidence = { invokesUserCode: false };
          const array = iterable ? expandStaticArray(iterable, new Set(), arrayEvidence) : undefined;
          const set = iterable ? expandStaticSet(iterable) : undefined;
          let conditional = iterable;
          while (conditional && ts.isParenthesizedExpression(conditional)) conditional = conditional.expression;
          const conditionalArrays = conditional && ts.isConditionalExpression(conditional)
            ? [expandStaticArray(conditional.whenTrue), expandStaticArray(conditional.whenFalse)] as const : undefined;
          const boundedConditionalArrays = conditionalArrays?.[0] && conditionalArrays[1]
            ? conditionalArrays as readonly [NonNullable<typeof conditionalArrays[0]>, NonNullable<typeof conditionalArrays[1]>] : undefined;
          const boundedElements = array ?? set ?? boundedConditionalArrays?.[0];
          const local = boundedElements ? undefined : localIterable(iterable);
          const candidatePaths: FiniteIterablePath[] | undefined = boundedConditionalArrays
            ? boundedConditionalArrays.map((branches) => ({ branches }))
            : array ? arrayEvidence.paths
              : local?.paths;
          const finiteElementLimitExceeded = candidatePaths
            ? candidatePaths.some((path) => path.branches.length > MAX_FINITE_ITERABLE_ELEMENTS)
            : (boundedElements?.length ?? local?.branches.length ?? 0) > MAX_FINITE_ITERABLE_ELEMENTS;
          const staticIterable = !finiteElementLimitExceeded && Boolean(boundedElements || (local && !local.unsupportedReason));
          const branchNodes = finiteElementLimitExceeded || local?.unsupportedReason ? undefined : local?.branches;
          const expressionPaths = finiteElementLimitExceeded ? undefined : candidatePaths;
          const modelElements = finiteElementLimitExceeded ? undefined : boundedElements;
          const iterableAlternatives = expressionPaths?.length === 2
            ? [expressionPaths[0]!.branches, expressionPaths[1]!.branches] as const
            : boundedConditionalArrays ?? (array ? arrayEvidence.alternatives : undefined) ?? local?.alternatives;
          const branchAlternatives = iterableAlternatives ? Array.from({ length: Math.max(iterableAlternatives[0].length, iterableAlternatives[1].length) }, (_, index) =>
            [iterableAlternatives[0][index], iterableAlternatives[1][index]].map((candidate) => candidate === undefined ? "<absent>" : branchText(candidate))) : undefined;
          const branchPresence = iterableAlternatives ? branchAlternatives!.map((_, index) =>
            iterableAlternatives[0][index] === undefined ? "when-false" : iterableAlternatives[1][index] === undefined ? "when-true" : "always" as const) : undefined;
          const pathWidth = expressionPaths ? Math.max(...expressionPaths.map((path) => path.branches.length)) : 0;
          const branches = expressionPaths && expressionPaths.length > 2
            ? Array.from({ length: pathWidth }, (_, index) => expressionPaths
              .flatMap((path) => path.branches[index] === undefined ? [] : [branchText(path.branches[index]!)])
              .filter((value, itemIndex, values) => values.indexOf(value) === itemIndex).join(" | "))
            : branchAlternatives ? branchAlternatives.map((alternatives) => alternatives.join(" | "))
            : modelElements ? modelElements.map(branchText) : branchNodes?.map(branchText) ?? [];
          const branchKinds = expressionPaths && expressionPaths.length > 2
            ? branches.map((_, index) => {
              const kinds = expressionPaths.flatMap((path) => path.branches[index] === undefined ? [] : [branchKind(path.branches[index]!)]);
              return kinds.every((kind) => kind === kinds[0]) ? kinds[0]! : "unknown";
            })
            : iterableAlternatives ? branchAlternatives!.map((_, index) => {
            const kinds = [iterableAlternatives[0][index], iterableAlternatives[1][index]].flatMap((item) => item === undefined ? [] : [branchKind(item)]);
            return kinds.every((kind) => kind === kinds[0]) ? kinds[0]! : "unknown";
          }) : (modelElements ? modelElements.map(branchKind) : branchNodes?.map(branchKind) ?? []);
          let current: ts.Node = node;
          while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
          const awaited = ts.isAwaitExpression(current.parent);
          if (awaited) current = current.parent;
          let catchesRejection = false;
          while (current.parent && current.parent !== ownerBody) {
            if (ts.isTryStatement(current.parent) && current.parent.tryBlock === current && current.parent.catchClause) catchesRejection = true;
            current = current.parent;
          }
          const iterablePaths = expressionPaths ? expressionPaths.map((path) => ({
            branches: path.branches.map(branchText),
            branchKinds: path.branches.map(branchKind),
            ...(path.failure ? { iteratorFailure: path.failure } : {}),
          })) : undefined;
          const pathFailure = expressionPaths?.find((path) => path.failure)?.failure;
          combinators.push({ owner: ownerName, combinator: operation.combinator, branches, branchKinds, ...(branchAlternatives ? { branchAlternatives, branchPresence } : {}), ...(iterablePaths ? { iterablePaths } : {}), staticIterable,
            iteratorKind: set ? "set" : array || boundedConditionalArrays ? "array" : local && !local.unsupportedReason ? "local" : "dynamic",
            iteratorEffects: boundedElements ? arrayEvidence.invokesUserCode ? ["InvokeUserCode"] : [] : ["InvokeUserCode"],
            iteratorFailure: pathFailure ?? arrayEvidence.failure ?? local?.failure,
            iteratorFailurePresence: arrayEvidence.failurePresence ?? local?.failurePresence,
            unsupportedReason: staticIterable ? undefined : finiteElementLimitExceeded ? "finite-element-limit" : arrayEvidence.unsupportedReason ?? local?.unsupportedReason ?? "dynamic-cardinality",
            aggregateErrorOrder: operation.combinator === "any" ? branches.map((_, index) => index) : undefined,
            aggregateErrorReasons: operation.combinator === "any" && !expressionPaths && !finiteElementLimitExceeded && (array ?? set ?? (local?.alternatives ? undefined : branchNodes))
              ? (array ?? set ?? branchNodes)!.map(rejectionReason) : undefined,
            aggregateErrorReasonPaths: operation.combinator === "any" && expressionPaths
              ? expressionPaths.map((path) => path.branches.map(rejectionReason)) : undefined,
            awaited, catchesRejection, span: { start: node.getStart(source), end: node.getEnd() } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ownerBody);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const parentCall = ts.isCallExpression(node.parent) ? node.parent : undefined;
      const operation = parentCall ? adapter.resolveCall(parentCall)?.operation : undefined;
      const scheduledCallback = Boolean(parentCall && (
        ((operation?.kind === "timer" || operation?.kind === "scheduler-post-task") && parentCall.arguments[operation.callbackArgument] === node)
        || (operation?.kind === "fs" && operation.callbackArgumentFromEnd && parentCall.arguments[parentCall.arguments.length - operation.callbackArgumentFromEnd] === node)
      ));
      if (!scheduledCallback && !scheduledCallbacks.has(node as ts.FunctionLikeDeclaration) && !invokedSignalFactories.has(node as ts.FunctionLikeDeclaration)) visitFunction(node as ts.FunctionLikeDeclaration);
    }
    ts.forEachChild(node, visit);
  };
  visitFunction(source);
  visit(source);
  for (const cancellation of cancellations) {
    if (cancellation.timer !== undefined) continue;
    const timer = timers.findIndex((item) => item.owner === cancellation.owner && item.handle === cancellation.handle && item.handleFamily === cancellation.clearFamily);
    if (timer >= 0) {
      cancellation.timer = timer;
      cancellation.compatible = true;
    }
  }
  for (const timer of timers) {
    if (timer.kind !== "scheduler-yield" || timer.enqueuedBy === undefined) continue;
    const parent = timers[timer.enqueuedBy];
    if (!parent?.priorityMutable) continue;
    timer.priorityMutable = true;
    timer.priority = parent.priorityChanges?.at(-1) ?? parent.priority;
  }
  return { timers, combinators, cancellations, abortCompositions, timerEscapes };
}

export function analyzeAsyncPatterns(fileName: string, text: string): AsyncPatternModel {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, version, true, ts.ScriptKind.TS) : original(name, version, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return analyzeAsyncPatternsInProgram(program, program.getSourceFile(fileName)!);
}

function safe(name: string): string { return name.replace(/[^A-Za-z0-9_]/g, "_"); }
function timerAction(kind: "fire" | "run", timer: TimerPattern, index: number): string {
  if (timer.kind === "abort-timeout") return kind === "fire" ? `fire_abort_timeout_${index}` : `run_abort_timeout_task_${index}`;
  if (timer.kind === "scheduler-post-task") return kind === "fire" ? `fire_scheduler_task_${index}` : `run_scheduler_task_${index}`;
  if (timer.kind === "scheduler-yield") return kind === "fire" ? `fire_scheduler_yield_${index}` : `run_scheduler_yield_${index}`;
  return kind === "fire" ? `fire_timer_${index}` : `run_timer_task_${index}`;
}

export function generateAsyncPatternsQuint(moduleName: string, model: AsyncPatternModel, options: { allowEarlyTimer?: boolean; allowEarlyJoin?: boolean; allowSpuriousReject?: boolean; allowFireAfterCancel?: boolean; allowMacroBeforeMicrotask?: boolean } = {}): string {
  for (const timer of model.timers) {
    if (timer.delay === undefined || timer.delay < 0) throw new Error(`${timer.owner}: timer model requires a static non-negative delay`);
    if (timer.kind === "abort-timeout" && timer.delay > Number.MAX_SAFE_INTEGER) throw new Error(`${timer.owner}: AbortSignal.timeout delay exceeds Number.MAX_SAFE_INTEGER`);
    if (timer.kind === "scheduler-post-task" && timer.priority === undefined) throw new Error(`${timer.owner}: scheduler.postTask model requires a static priority`);
  }
  for (const join of model.combinators) if (!join.staticIterable) throw new Error(`${join.owner}: Promise.${join.combinator} model requires a statically bounded iterable (${join.unsupportedReason ?? "dynamic-cardinality"})`);
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int"];
  model.timers.forEach((_, index) => lines.push(`  var timer_${index}_scheduled: bool`, `  var timer_${index}_cancelled: bool`, `  var timer_${index}_due: int`, `  var timer_${index}_early: bool`, `  var timer_${index}_after_cancel: bool`, `  var timer_${index}_macro_first: bool`, `  var timer_${index}_fires: int`));
  model.combinators.forEach((join, index) => {
    join.branches.forEach((_, branch) => lines.push(`  var join_${index}_branch_${branch}: int`));
    const hasChoice = Boolean(join.iterablePaths?.length || join.branchPresence?.some((presence) => presence !== "always"));
    if (hasChoice) lines.push(`  var join_${index}_iterable_choice: int`);
    lines.push(`  var join_${index}_result: int`, `  var join_${index}_iterator_failed: bool`, `  var join_${index}_rejection_escapes: bool`);
    if (join.aggregateErrorOrder) {
      const hasConditionalPresence = hasChoice;
      if (hasConditionalPresence) {
        if (join.iterablePaths) {
          const choices = join.iterablePaths.map((path, pathIndex) => `if (join_${index}_iterable_choice == ${pathIndex}) ${path.branches.length} else `).join("");
          lines.push(`  def join_${index}_aggregate_error_count = if (join_${index}_iterable_choice == -1) 0 else ${choices}0`);
        } else {
          const trueCount = join.branchPresence!.filter((presence) => presence !== "when-false").length;
          const falseCount = join.branchPresence!.filter((presence) => presence !== "when-true").length;
          lines.push(`  def join_${index}_aggregate_error_count = if (join_${index}_iterable_choice == -1) 0 else if (join_${index}_iterable_choice == 1) ${trueCount} else ${falseCount}`);
        }
      } else lines.push(`  val join_${index}_aggregate_error_count = ${join.aggregateErrorOrder.length}`);
      join.aggregateErrorOrder.forEach((slot, rank) => lines.push(`  val join_${index}_aggregate_error_slot_${rank} = ${slot}`));
      join.aggregateErrorReasons?.forEach((reason, rank) => {
        const encoded = reason?.kind === "literal" ? `literal:${typeof reason.value}:${String(reason.value)}`
          : reason?.kind === "error" ? `error:${reason.errorType}:${reason.message ?? ""}` : "unknown";
        lines.push(`  val join_${index}_aggregate_error_reason_${rank} = ${JSON.stringify(encoded)}`);
      });
      join.aggregateErrorReasonPaths?.forEach((reasons, path) => reasons.forEach((reason, rank) => {
        const encoded = reason?.kind === "literal" ? `literal:${typeof reason.value}:${String(reason.value)}`
          : reason?.kind === "error" ? `error:${reason.errorType}:${reason.message ?? ""}` : "unknown";
        lines.push(`  val join_${index}_path_${path}_aggregate_error_reason_${rank} = ${JSON.stringify(encoded)}`);
      }));
    }
  });
  lines.push("", "  action init = all {", "    clock' = 0,");
  model.timers.forEach((timer, index) => {
    const cancelled = timer.initiallyCancelled || model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    timer_${index}_scheduled' = ${!cancelled},`, `    timer_${index}_cancelled' = ${cancelled},`, `    timer_${index}_due' = ${timer.delay},`, `    timer_${index}_early' = false,`, `    timer_${index}_after_cancel' = false,`, `    timer_${index}_macro_first' = false,`, `    timer_${index}_fires' = 0,`);
  });
  model.combinators.forEach((join, index) => { join.branches.forEach((_, branch) => lines.push(`    join_${index}_branch_${branch}' = 0,`)); if (join.iterablePaths?.length || join.branchPresence?.some((presence) => presence !== "always")) lines.push(`    join_${index}_iterable_choice' = -1,`); lines.push(`    join_${index}_result' = 0,`, `    join_${index}_iterator_failed' = false,`, `    join_${index}_rejection_escapes' = false,`); });
  lines.push("  }");
  const allVars = ["clock", ...model.timers.flatMap((_, i) => [`timer_${i}_scheduled`, `timer_${i}_cancelled`, `timer_${i}_due`, `timer_${i}_early`, `timer_${i}_after_cancel`, `timer_${i}_macro_first`, `timer_${i}_fires`]), ...model.combinators.flatMap((join, i) => [...join.branches.map((_, b) => `join_${i}_branch_${b}`), ...(join.iterablePaths?.length || join.branchPresence?.some((presence) => presence !== "always") ? [`join_${i}_iterable_choice`] : []), `join_${i}_result`, `join_${i}_iterator_failed`, `join_${i}_rejection_escapes`])];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    lines.push("", `  action ${name} = all {`);
    guards.forEach((guard) => lines.push(`    ${guard},`));
    allVars.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  action("tick", [], new Map([["clock", "clock + 1"]]));
  model.timers.forEach((timer, index) => {
    const pendingMicrotasks = model.timers.flatMap((candidate, candidateIndex) => candidate.owner === timer.owner && candidate.queue === "microtask" ? [`timer_${candidateIndex}_scheduled`] : []);
    action(timerAction("fire", timer, index), [...(options.allowFireAfterCancel ? [] : [`timer_${index}_scheduled`]), ...(options.allowEarlyTimer ? [] : [`clock >= timer_${index}_due`]), ...(timer.queue === "timer" && !options.allowMacroBeforeMicrotask ? pendingMicrotasks.map((name) => `not(${name})`) : [])], new Map([
    [`timer_${index}_scheduled`, timer.recursive || timer.repeats ? "true" : "false"],
    [`timer_${index}_early`, `clock < timer_${index}_due`],
    [`timer_${index}_after_cancel`, `timer_${index}_cancelled`],
    [`timer_${index}_macro_first`, timer.queue === "timer" && pendingMicrotasks.length ? pendingMicrotasks.join(" or ") : "false"],
    [`timer_${index}_fires`, `timer_${index}_fires + 1`],
    [`timer_${index}_due`, timer.recursive || timer.repeats ? `clock + ${timer.delay}` : `timer_${index}_due`],
    ]));
  });
  model.combinators.forEach((join, index) => {
    const hasChoice = Boolean(join.iterablePaths?.length || join.branchPresence?.some((presence) => presence !== "always"));
    if (hasChoice) {
      if (join.iterablePaths) join.iterablePaths.forEach((_, path) =>
        action(`choose_iterable_${index}_path_${path}`, [`join_${index}_iterable_choice == -1`], new Map([[`join_${index}_iterable_choice`, String(path)]])));
      else {
        action(`choose_iterable_${index}_true`, [`join_${index}_iterable_choice == -1`], new Map([[`join_${index}_iterable_choice`, "1"]]));
        action(`choose_iterable_${index}_false`, [`join_${index}_iterable_choice == -1`], new Map([[`join_${index}_iterable_choice`, "0"]]));
      }
    }
    const presence = (branch: number): string => join.iterablePaths
      ? `(${join.iterablePaths.flatMap((path, pathIndex) => path.branches[branch] === undefined ? [] : [`join_${index}_iterable_choice == ${pathIndex}`]).join(" or ") || "false"})`
      : join.branchPresence?.[branch] === "when-true" ? `join_${index}_iterable_choice == 1`
      : join.branchPresence?.[branch] === "when-false" ? `join_${index}_iterable_choice == 0` : "true";
    const failurePresence = join.iterablePaths
      ? `(${join.iterablePaths.flatMap((path, pathIndex) => path.iteratorFailure ? [`join_${index}_iterable_choice == ${pathIndex}`] : []).join(" or ") || "false"})`
      : join.iteratorFailurePresence === "when-true" ? `join_${index}_iterable_choice == 1`
      : join.iteratorFailurePresence === "when-false" ? `join_${index}_iterable_choice == 0` : "true";
    if (join.iteratorFailure) action(`fail_iterator_${index}`, [
      `join_${index}_result == 0`, ...(failurePresence === "true" ? [] : [failurePresence]),
    ], new Map([
      [`join_${index}_result`, "2"],
      [`join_${index}_iterator_failed`, "true"],
      [`join_${index}_rejection_escapes`, String(!join.catchesRejection)],
    ]));
    join.branches.forEach((_, branch) => {
      const kind = join.branchKinds?.[branch] ?? "unknown";
      const raceGuard = [...(presence(branch) === "true" ? [] : [presence(branch)]), ...(join.combinator === "race" ? [`join_${index}_result == 0`] : [])];
      const pathKindGuard = (accepted: Array<"value" | "thenable" | "unknown">): string | undefined => {
        if (!join.iterablePaths) return undefined;
        const choices = join.iterablePaths.flatMap((path, pathIndex) => {
          const candidate = path.branchKinds[branch];
          return candidate && accepted.includes(candidate) ? [`join_${index}_iterable_choice == ${pathIndex}`] : [];
        });
        return choices.length === join.iterablePaths.length ? undefined : `(${choices.join(" or ") || "false"})`;
      };
      const fulfillUpdates = new Map([[`join_${index}_branch_${branch}`, "1"]]);
      const rejectUpdates = new Map([[`join_${index}_branch_${branch}`, "2"]]);
      if (join.combinator === "race") {
        fulfillUpdates.set(`join_${index}_result`, "1");
        rejectUpdates.set(`join_${index}_result`, "2");
        rejectUpdates.set(`join_${index}_rejection_escapes`, String(!join.catchesRejection));
      }
      if (kind === "value") action(`fulfill_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard], fulfillUpdates);
      else {
        const assimilateKind = pathKindGuard(["thenable", "unknown"]);
        action(`assimilate_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard, ...(assimilateKind ? [assimilateKind] : [])], new Map([[`join_${index}_branch_${branch}`, "3"]]));
        const directChoices = pathKindGuard(["value", "unknown"]);
        const adoptedChoices = pathKindGuard(["thenable", "unknown"]);
        const fulfillGuard = join.iterablePaths
          ? `(${directChoices === "false" ? "false" : `(${directChoices ?? "true"} and join_${index}_branch_${branch} == 0)`} or ${adoptedChoices === "false" ? "false" : `(${adoptedChoices ?? "true"} and join_${index}_branch_${branch} == 3)`})`
          : kind === "unknown" ? `(join_${index}_branch_${branch} == 0 or join_${index}_branch_${branch} == 3)` : `join_${index}_branch_${branch} == 3`;
        action(`fulfill_${index}_${branch}`, [fulfillGuard, ...raceGuard], fulfillUpdates);
        action(`reject_${index}_${branch}`, [`join_${index}_branch_${branch} == 3`, ...raceGuard, ...(adoptedChoices ? [adoptedChoices] : [])], rejectUpdates);
      }
    });
    const allFulfilled = join.branches.map((_, branch) => presence(branch) === "true" ? `join_${index}_branch_${branch} == 1` : `(not(${presence(branch)}) or join_${index}_branch_${branch} == 1)`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, branch) => presence(branch) === "true" ? `join_${index}_branch_${branch} == 1` : `(${presence(branch)} and join_${index}_branch_${branch} == 1)`).join(" or ") || "false";
    const allRejected = join.branches.map((_, branch) => presence(branch) === "true" ? `join_${index}_branch_${branch} == 2` : `(not(${presence(branch)}) or join_${index}_branch_${branch} == 2)`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, branch) => presence(branch) === "true" ? `join_${index}_branch_${branch} == 2` : `(${presence(branch)} and join_${index}_branch_${branch} == 2)`).join(" or ") || "false";
    const allSettled = join.branches.map((_, branch) => presence(branch) === "true" ? `(join_${index}_branch_${branch} == 1 or join_${index}_branch_${branch} == 2)` : `(not(${presence(branch)}) or join_${index}_branch_${branch} == 1 or join_${index}_branch_${branch} == 2)`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : join.combinator === "race" ? "false" : anyFulfilled;
    const normalRejected = join.combinator === "all" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    const rejected = `(join_${index}_iterator_failed or (${normalRejected}))`;
    const choiceGuard = hasChoice ? [`join_${index}_iterable_choice != -1`] : [];
    action(`fulfill_join_${index}`, [`join_${index}_result == 0`, ...choiceGuard, ...(options.allowEarlyJoin ? ["true"] : [fulfilled])], new Map([[`join_${index}_result`, "1"]]));
    action(`reject_join_${index}`, [`join_${index}_result == 0`, ...choiceGuard, ...(options.allowSpuriousReject ? ["true"] : [rejected])], new Map([
      [`join_${index}_result`, "2"],
      [`join_${index}_rejection_escapes`, String(!join.catchesRejection)],
    ]));
  });
  const actions = ["tick", ...model.timers.map((timer, i) => timerAction("fire", timer, i)), ...model.combinators.flatMap((join, i) => {
    const conditionalFailure = join.iteratorFailure && (join.iteratorFailurePresence || join.iterablePaths);
    if (join.iteratorFailure && !conditionalFailure) return [`fail_iterator_${i}`];
    const choices = join.iterablePaths
      ? join.iterablePaths.map((_, path) => `choose_iterable_${i}_path_${path}`)
      : join.branchPresence?.some((presence) => presence !== "always") ? [`choose_iterable_${i}_true`, `choose_iterable_${i}_false`] : [];
    return [...choices, ...(conditionalFailure ? [`fail_iterator_${i}`] : []), ...join.branches.flatMap((_, b) => {
    const kind = join.branchKinds?.[b] ?? "unknown";
    return kind === "value" ? [`fulfill_${i}_${b}`]
      : kind === "thenable" ? [`assimilate_${i}_${b}`, `fulfill_${i}_${b}`, `reject_${i}_${b}`]
      : [`fulfill_${i}_${b}`, `assimilate_${i}_${b}`, `reject_${i}_${b}`];
    }), `fulfill_join_${i}`, `reject_join_${i}`];
  })];
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const safeTerms = [...model.timers.flatMap((timer, i) => [`not(timer_${i}_early)`, `not(timer_${i}_after_cancel)`, `not(timer_${i}_macro_first)`, ...(timer.kind === "abort-timeout" ? [`timer_${i}_fires <= 1`] : [])]), ...model.combinators.flatMap((join, i) => {
    const presence = (branch: number): string => join.iterablePaths
      ? `(${join.iterablePaths.flatMap((path, pathIndex) => path.branches[branch] === undefined ? [] : [`join_${i}_iterable_choice == ${pathIndex}`]).join(" or ") || "false"})`
      : join.branchPresence?.[branch] === "when-true" ? `join_${i}_iterable_choice == 1`
      : join.branchPresence?.[branch] === "when-false" ? `join_${i}_iterable_choice == 0` : "true";
    const allFulfilled = join.branches.map((_, b) => presence(b) === "true" ? `join_${i}_branch_${b} == 1` : `(not(${presence(b)}) or join_${i}_branch_${b} == 1)`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, b) => presence(b) === "true" ? `join_${i}_branch_${b} == 1` : `(${presence(b)} and join_${i}_branch_${b} == 1)`).join(" or ") || "false";
    const allRejected = join.branches.map((_, b) => presence(b) === "true" ? `join_${i}_branch_${b} == 2` : `(not(${presence(b)}) or join_${i}_branch_${b} == 2)`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, b) => presence(b) === "true" ? `join_${i}_branch_${b} == 2` : `(${presence(b)} and join_${i}_branch_${b} == 2)`).join(" or ") || "false";
    const allSettled = join.branches.map((_, b) => presence(b) === "true" ? `(join_${i}_branch_${b} == 1 or join_${i}_branch_${b} == 2)` : `(not(${presence(b)}) or join_${i}_branch_${b} == 1 or join_${i}_branch_${b} == 2)`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : anyFulfilled;
    const normalRejected = join.combinator === "all" || join.combinator === "race" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    const rejected = `(join_${i}_iterator_failed or (${normalRejected}))`;
    return [`((join_${i}_result != 1) or (${fulfilled}))`, `((join_${i}_result != 2) or (${rejected}))`];
  })];
  lines.push("", `  val asyncSafe = ${safeTerms.join(" and ") || "true"}`, "}", "");
  return lines.join("\n");
}

/** Node callback-checkpoint profile. ESM top-level evaluation is deliberately outside this initial slice. */
export function generateNodeEventLoopQuint(
  moduleName: string,
  model: AsyncPatternModel,
  options: {
    allowMicrotaskBeforeNextTick?: boolean;
    allowMacroBeforeCheckpoint?: boolean;
    allowWrongPhase?: boolean;
    topLevelMode?: "commonjs" | "esm";
    allowEsmNextTickBeforeMicrotask?: boolean;
  } = {},
  promiseModel?: PromiseChainModel,
): string {
  for (const timer of model.timers) if (timer.delay === undefined
    || (timer.handleFamily !== "timeout" && (!Number.isFinite(timer.delay) || timer.delay < 0))) {
    throw new Error(`${timer.owner}: Node event-loop model requires a supported static delay`);
  }
  const supported = model.timers.flatMap((timer, index) => ["next-tick", "microtask", "timer", "poll", "check", "close"].includes(timer.queue) ? [index] : []);
  const nodeDelay = (timer: TimerPattern): number => timer.handleFamily === "timeout"
    ? !Number.isFinite(timer.delay!) || timer.delay! < 1 || timer.delay! > 2_147_483_647 ? 1 : Math.trunc(timer.delay!)
    : timer.delay!;
  const nextTicks = supported.filter((index) => model.timers[index]!.queue === "next-tick");
  const microtasks = supported.filter((index) => model.timers[index]!.queue === "microtask");
  const timers = supported.filter((index) => model.timers[index]!.queue === "timer");
  const polls = supported.filter((index) => model.timers[index]!.queue === "poll");
  const checks = supported.filter((index) => model.timers[index]!.queue === "check");
  const closes = supported.filter((index) => model.timers[index]!.queue === "close");
  const multiInstanceTimers = new Set(supported.filter((index) => {
    const timer = model.timers[index]!;
    return timer.queue === "timer" && timer.enqueuedBy !== undefined
      && Boolean(model.timers[timer.enqueuedBy]?.repeats);
  }));
  const initialReactions = new Set<string>();
  promiseModel?.chains.forEach((chain, chainIndex) => {
    const executor = chain.executor === undefined ? undefined : promiseModel.executors[chain.executor];
    if (chain.links.length && (chain.initialSettlement !== undefined
      || (executor && executor.possibleSettlements.length > 0 && !executor.mayRemainPending))) initialReactions.add(`${chainIndex}:0`);
  });
  const initialV8Jobs = [
    ...microtasks.flatMap((index) => model.timers[index]!.enqueuedBy === undefined ? [{ key: `callback:${index}`, span: model.timers[index]!.span.start }] : []),
    ...(promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((link, stage) =>
      initialReactions.has(`${chainIndex}:${stage}`) ? [{ key: `reaction:${chainIndex}:${stage}`, span: link.span.start }] : [])) ?? []),
  ].sort((left, right) => left.span - right.span);
  const esmInitialNextTicks = new Set(nextTicks.filter((index) => model.timers[index]!.owner === "<module>"
    && model.timers[index]!.enqueuedBy === undefined));
  const initialV8Pending = initialV8Jobs.map((job) => job.key.startsWith("callback:")
    ? `callback_${job.key.slice("callback:".length)}_pending`
    : `promise_reaction_${job.key.slice("reaction:".length).replace(":", "_")}_pending`);
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int", "  var node_phase: int", "  var resume_phase: int", "  var wrong_checkpoint_order: bool", "  var wrong_phase: bool"];
  supported.forEach((index) => {
    lines.push(`  var callback_${index}_pending: bool`, `  var callback_${index}_due: int`, `  var callback_${index}_fires: int`);
    if (multiInstanceTimers.has(index)) lines.push(`  var callback_${index}_instances: int`, `  var callback_${index}_due_times: List[int]`);
  });
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => lines.push(`  var promise_reaction_${chainIndex}_${stage}_pending: bool`, `  var promise_reaction_${chainIndex}_${stage}_done: bool`)));
  lines.push("", "  action init = all {", "    clock' = 0,", "    node_phase' = 0,", "    resume_phase' = 1,", `    wrong_checkpoint_order' = ${Boolean(options.allowMicrotaskBeforeNextTick || options.allowMacroBeforeCheckpoint || options.allowEsmNextTickBeforeMicrotask)},`, `    wrong_phase' = ${Boolean(options.allowWrongPhase)},`);
  supported.forEach((index) => {
    const timer = model.timers[index]!;
    const cancelled = timer.initiallyCancelled || model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    callback_${index}_pending' = ${!cancelled && timer.enqueuedBy === undefined && !timer.externallyReady},`, `    callback_${index}_due' = ${nodeDelay(timer)},`, `    callback_${index}_fires' = 0,`);
    if (multiInstanceTimers.has(index)) lines.push(`    callback_${index}_instances' = 0,`, `    callback_${index}_due_times' = [],`);
  });
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    lines.push(`    promise_reaction_${chainIndex}_${stage}_pending' = ${initialReactions.has(`${chainIndex}:${stage}`)},`, `    promise_reaction_${chainIndex}_${stage}_done' = false,`);
  }));
  lines.push("  }");
  const reactionVariables = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((_, stage) => [`promise_reaction_${chainIndex}_${stage}_pending`, `promise_reaction_${chainIndex}_${stage}_done`])) ?? [];
  const variables = ["clock", "node_phase", "resume_phase", "wrong_checkpoint_order", "wrong_phase", ...supported.flatMap((index) => [
    `callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`,
    ...(multiInstanceTimers.has(index) ? [`callback_${index}_instances`, `callback_${index}_due_times`] : []),
  ]), ...reactionVariables];
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    variables.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const enqueueNodeChildren = (parent: number, updates: Map<string, string>, alternative?: number): void => {
    const belongsToAlternative = (index: number): boolean => model.timers[index]!.parentAlternative === undefined
      || model.timers[index]!.parentAlternative === alternative;
    [...nextTicks, ...microtasks].filter((index) => model.timers[index]!.enqueuedBy === parent && belongsToAlternative(index))
      .forEach((child) => updates.set(`callback_${child}_pending`, "true"));
    checks.filter((index) => model.timers[index]!.enqueuedBy === parent && belongsToAlternative(index)).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_due`, "clock + 1");
    });
    timers.filter((index) => model.timers[index]!.enqueuedBy === parent && belongsToAlternative(index)).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      if (multiInstanceTimers.has(child)) {
        updates.set(`callback_${child}_instances`, `callback_${child}_instances + 1`);
        updates.set(`callback_${child}_due_times`, `callback_${child}_due_times.append(clock + ${nodeDelay(model.timers[child]!)})`);
        updates.set(`callback_${child}_due`, `if (callback_${child}_pending) callback_${child}_due else clock + ${nodeDelay(model.timers[child]!)}`);
      } else {
        updates.set(`callback_${child}_due`, `clock + ${nodeDelay(model.timers[child]!)}`);
      }
    });
  };
  polls.forEach((index) => action(`complete_poll_${index}`, [
    `callback_${index}_fires == 0`, `not(callback_${index}_pending)`,
  ], new Map([[`callback_${index}_pending`, "true"]])));
  closes.forEach((index) => action(`complete_close_${index}`, [
    `callback_${index}_fires == 0`, `not(callback_${index}_pending)`,
  ], new Map([[`callback_${index}_pending`, "true"]])));
  const phaseGuard = (expected: number): string[] => options.allowWrongPhase ? [`node_phase != ${expected}`] : [`node_phase == ${expected}`];
  const phaseViolation = (expected: number): string => `wrong_phase or node_phase != ${expected}`;
  nextTicks.forEach((index, order) => {
    const alternatives: (number | undefined)[] = model.timers[index]!.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([[`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", phaseViolation(0)]]);
      enqueueNodeChildren(index, updates, alternative);
      const baseName = `drain_next_tick_${index}`;
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, [
        ...phaseGuard(0), `callback_${index}_pending`,
        ...(options.allowMicrotaskBeforeNextTick ? microtasks.map((microtask) => `not(callback_${microtask}_pending)`) : []),
        ...(options.topLevelMode === "esm" && esmInitialNextTicks.has(index) && !options.allowEsmNextTickBeforeMicrotask
          ? initialV8Pending.map((pending) => `not(${pending})`) : []),
        ...nextTicks.slice(0, order).map((earlier) => `not(callback_${earlier}_pending)`),
      ], updates);
    }
  });
  microtasks.forEach((index, order) => {
    const esmInitialJob = options.topLevelMode === "esm" && model.timers[index]!.owner === "<module>"
      && model.timers[index]!.enqueuedBy === undefined;
    const pendingNextTick = nextTicks.filter((nextTick) => !esmInitialJob || !esmInitialNextTicks.has(nextTick))
      .map((nextTick) => `callback_${nextTick}_pending`);
    const key = `callback:${index}`;
    const position = initialV8Jobs.findIndex((job) => job.key === key);
    const earlierV8 = (position >= 0 ? initialV8Jobs.slice(0, position) : microtasks
      .filter((candidate) => model.timers[candidate]!.enqueuedBy === model.timers[index]!.enqueuedBy && candidate < index)
      .map((candidate) => ({ key: `callback:${candidate}` }))).map((job) =>
      job.key.startsWith("callback:") ? `callback_${job.key.slice("callback:".length)}_pending`
        : `promise_reaction_${job.key.slice("reaction:".length).replace(":", "_")}_pending`);
    const alternatives: (number | undefined)[] = model.timers[index]!.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([
        [`callback_${index}_pending`, "false"],
        [`callback_${index}_fires`, `callback_${index}_fires + 1`],
        ["wrong_checkpoint_order", `wrong_checkpoint_order or (${pendingNextTick.join(" or ") || "false"})`],
        ["wrong_phase", phaseViolation(0)],
      ]);
      enqueueNodeChildren(index, updates, alternative);
      const baseName = `drain_microtask_${index}`;
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, [
        ...phaseGuard(0), `callback_${index}_pending`,
        ...(options.allowMicrotaskBeforeNextTick ? [] : pendingNextTick.map((pending) => `not(${pending})`)),
        ...earlierV8.map((pending) => `not(${pending})`),
      ], updates);
    }
  });
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    const key = `reaction:${chainIndex}:${stage}`;
    const esmInitialJob = options.topLevelMode === "esm" && initialReactions.has(key);
    const pendingNextTick = nextTicks.filter((nextTick) => !esmInitialJob || !esmInitialNextTicks.has(nextTick))
      .map((nextTick) => `callback_${nextTick}_pending`);
    const position = initialV8Jobs.findIndex((job) => job.key === key);
    const earlierV8 = stage === 0 && position >= 0 ? initialV8Jobs.slice(0, position).map((job) =>
      job.key.startsWith("callback:") ? `callback_${job.key.slice("callback:".length)}_pending`
        : `promise_reaction_${job.key.slice("reaction:".length).replace(":", "_")}_pending`) : [
      ...microtasks.map((index) => `callback_${index}_pending`),
      ...promiseModel.chains.flatMap((candidate, candidateIndex) => candidate.links.flatMap((__, candidateStage) =>
        candidateIndex === chainIndex && candidateStage === stage ? [] : [`promise_reaction_${candidateIndex}_${candidateStage}_pending`])),
    ];
    const updates = new Map<string, string>([[`promise_reaction_${chainIndex}_${stage}_pending`, "false"], [`promise_reaction_${chainIndex}_${stage}_done`, "true"]]);
    updates.set("wrong_checkpoint_order", `wrong_checkpoint_order or (${pendingNextTick.join(" or ") || "false"})`);
    updates.set("wrong_phase", phaseViolation(0));
    if (stage + 1 < chain.links.length) updates.set(`promise_reaction_${chainIndex}_${stage + 1}_pending`, "true");
    action(`drain_promise_reaction_${chainIndex}_${stage}`, [
      ...phaseGuard(0), `promise_reaction_${chainIndex}_${stage}_pending`,
      ...(options.allowMicrotaskBeforeNextTick ? [] : pendingNextTick.map((pending) => `not(${pending})`)),
      ...earlierV8.map((pending) => `not(${pending})`),
    ], updates);
  }));
  const reactionPending = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.map((_, stage) => `promise_reaction_${chainIndex}_${stage}_pending`)) ?? [];
  const checkpointPending = [...nextTicks, ...microtasks].map((index) => `callback_${index}_pending`).concat(reactionPending);
  action("finish_node_checkpoint", [
    ...phaseGuard(0), ...checkpointPending.map((pending) => `not(${pending})`),
  ], new Map([["node_phase", "resume_phase"], ["wrong_phase", phaseViolation(0)]]));
  const macro = (index: number, earlier: number[], phase: number): void => {
    const timer = model.timers[index]!;
    const alternatives: (number | undefined)[] = timer.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([
      [`callback_${index}_pending`, multiInstanceTimers.has(index)
        ? timer.repeats ? "true" : `callback_${index}_instances > 1`
        : String(timer.repeats)],
      [`callback_${index}_fires`, `callback_${index}_fires + 1`],
      [`callback_${index}_due`, multiInstanceTimers.has(index)
        ? timer.repeats
          ? `if (callback_${index}_instances > 1) callback_${index}_due_times.tail().head() else clock + ${nodeDelay(timer)}`
          : `if (callback_${index}_instances > 1) callback_${index}_due_times.tail().head() else callback_${index}_due`
        : timer.repeats ? `clock + ${nodeDelay(timer)}` : `callback_${index}_due`],
      ["node_phase", "0"],
      ["resume_phase", String(phase)],
      ["wrong_checkpoint_order", `wrong_checkpoint_order or (${checkpointPending.join(" or ") || "false"})`],
      ["wrong_phase", phaseViolation(phase)],
    ]);
      if (multiInstanceTimers.has(index)) {
        updates.set(`callback_${index}_instances`, timer.repeats ? `callback_${index}_instances` : `callback_${index}_instances - 1`);
        updates.set(`callback_${index}_due_times`, timer.repeats
          ? `callback_${index}_due_times.tail().append(clock + ${nodeDelay(timer)})`
          : `callback_${index}_due_times.tail()`);
      }
      enqueueNodeChildren(index, updates, alternative);
      const baseName = timer.queue === "check" ? `run_check_${index}` : timer.queue === "poll" ? `run_poll_${index}` : timer.queue === "close" ? `run_close_${index}` : `run_timer_${index}`;
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, [
        ...phaseGuard(phase), `callback_${index}_pending`, `clock >= callback_${index}_due`,
        ...(options.allowMacroBeforeCheckpoint ? [] : checkpointPending.map((pending) => `not(${pending})`)),
        ...earlier.map((item) => `not(callback_${item}_pending) or callback_${item}_due > clock`),
      ], updates);
    }
  };
  timers.forEach((index, order) => macro(index, timers.slice(0, order), 1));
  polls.forEach((index) => macro(index, [], 2));
  checks.forEach((index, order) => macro(index, checks.slice(0, order), 3));
  closes.forEach((index, order) => macro(index, closes.slice(0, order), 4));
  action("advance_timers_to_poll", [
    ...phaseGuard(1), ...timers.map((index) => `not(callback_${index}_pending) or callback_${index}_due > clock`),
  ], new Map([["node_phase", "2"], ["wrong_phase", phaseViolation(1)]]));
  action("advance_poll_to_check", [
    ...phaseGuard(2), ...polls.map((index) => `not(callback_${index}_pending)`),
  ], new Map([["node_phase", "3"], ["wrong_phase", phaseViolation(2)]]));
  action("advance_check_to_close", [
    ...phaseGuard(3), ...checks.map((index) => `not(callback_${index}_pending) or callback_${index}_due > clock`),
  ], new Map([["node_phase", "4"], ["wrong_phase", phaseViolation(3)]]));
  action("advance_close_to_next_iteration", [
    ...phaseGuard(4), ...closes.map((index) => `not(callback_${index}_pending)`),
  ], new Map([
    ["clock", "clock + 1"], ["node_phase", "0"], ["resume_phase", "1"], ["wrong_phase", phaseViolation(4)],
  ]));
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }", "", "  val nodeEventLoopSafe = not(wrong_checkpoint_order) and not(wrong_phase)", "}", "");
  return lines.join("\n");
}

/** Browser event-loop profile: one task, a draining microtask checkpoint, then an optional rendering opportunity. */
export function generateWebEventLoopQuint(moduleName: string, model: AsyncPatternModel, options: { allowWrongPhase?: boolean; allowOutOfOrderMicrotasks?: boolean; allowAbortReasonOverwrite?: boolean; allowEarlyAbortComposition?: boolean; allowWrongSchedulerPriority?: boolean; allowRunAbortedSchedulerTask?: boolean; allowCallbackPreconditionViolation?: boolean } = {}, promiseModel?: PromiseChainModel, temporalComposition?: TemporalComposition): string {
  for (const timer of model.timers) {
    if (timer.delay === undefined || timer.delay < 0) throw new Error(`${timer.owner}: web event-loop model requires a static non-negative delay`);
    if (timer.kind === "abort-timeout" && timer.delay > Number.MAX_SAFE_INTEGER) throw new Error(`${timer.owner}: AbortSignal.timeout delay exceeds Number.MAX_SAFE_INTEGER`);
    if (timer.kind === "scheduler-post-task" && timer.priority === undefined) throw new Error(`${timer.owner}: scheduler.postTask model requires a static priority`);
  }
  const microtasks = model.timers.flatMap((timer, index) => timer.queue === "microtask" ? [index] : []);
  const frames = model.timers.flatMap((timer, index) => timer.queue === "animation-frame" ? [index] : []);
  const timers = model.timers.flatMap((timer, index) => timer.queue === "timer" ? [index] : []);
  const schedulerTasks = model.timers.flatMap((timer, index) => timer.queue === "scheduler-task" ? [index] : []);
  const abortCompositions = model.abortCompositions ?? [];
  const temporalStates = temporalComposition?.states ?? [];
  const temporalInit = new Map(temporalComposition?.init.map((item) => [item.target, generateQuintExpression(item.expressionAst)]) ?? []);
  const temporalStateNames = new Set(temporalStates.map((state) => state.name));
  const clock = temporalStateNames.has("clock") ? "web_clock" : "clock";
  const phase = temporalStateNames.has("phase") ? "web_phase" : "phase";
  const initiallyQueuedReactions = new Set<string>();
  promiseModel?.chains.forEach((chain, chainIndex) => {
    const executor = chain.executor === undefined ? undefined : promiseModel.executors[chain.executor];
    if (chain.links.length && executor && executor.possibleSettlements.length > 0 && !executor.mayRemainPending) initiallyQueuedReactions.add(`${chainIndex}:0`);
  });
  const initialJobs = [
    ...microtasks.flatMap((index) => model.timers[index]!.enqueuedBy === undefined ? [{ key: `callback:${index}`, span: model.timers[index]!.span.start }] : []),
    ...(promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((link, stage) => initiallyQueuedReactions.has(`${chainIndex}:${stage}`) ? [{ key: `reaction:${chainIndex}:${stage}`, span: link.span.start }] : [])) ?? []),
  ].sort((left, right) => left.span - right.span);
  const initialTicket = new Map(initialJobs.map((job, ticket) => [job.key, ticket]));
  const lines = [`module ${safe(moduleName)} {`, `  var ${clock}: int`, `  var ${phase}: int`, "  var wrong_phase: bool", "  var fifo_broken: bool", "  var scheduler_priority_broken: bool", "  var scheduler_abort_broken: bool", "  var abort_source_broken: bool", "  var callback_precondition_broken: bool", "  var next_microtask_ticket: int"];
  temporalStates.forEach((state) => lines.push(`  var ${safe(state.name)}: ${formatTemporalValueType(state.type)}`));
  model.timers.forEach((timer, index) => lines.push(`  var callback_${index}_pending: bool`, `  var callback_${index}_due: int`, `  var callback_${index}_fires: int`, ...(timer.externalAbortSignal ? [`  var callback_${index}_external_aborted: bool`] : []), ...(timer.priorityChanges?.length ? [`  var callback_${index}_priority: int`, `  var callback_${index}_priority_step: int`] : [])));
  abortCompositions.forEach((composition, index) => lines.push(`  var abort_${index}_aborted: bool`, `  var abort_${index}_reason_source: int`, `  var abort_${index}_reason_overwritten: bool`, ...(composition.sourcePaths ? [`  var abort_${index}_path: int`] : [])));
  microtasks.forEach((index) => lines.push(`  var callback_${index}_ticket: int`));
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => lines.push(`  var promise_reaction_${chainIndex}_${stage}_pending: bool`, `  var promise_reaction_${chainIndex}_${stage}_done: bool`, `  var promise_reaction_${chainIndex}_${stage}_ticket: int`)));
  lines.push("", "  action init = all {", `    ${clock}' = 0,`, `    ${phase}' = 1,`, "    wrong_phase' = false,", "    fifo_broken' = false,", "    scheduler_priority_broken' = false,", "    scheduler_abort_broken' = false,", "    abort_source_broken' = false,", "    callback_precondition_broken' = false,", `    next_microtask_ticket' = ${initialJobs.length},`);
  temporalStates.forEach((state) => {
    const value = temporalInit.get(state.name);
    if (value === undefined) throw new Error(`missing temporal init for ${state.name}`);
    lines.push(`    ${safe(state.name)}' = ${value},`);
  });
  model.timers.forEach((timer, index) => {
    const definitelyCancelled = model.cancellations.some((cancellation) => cancellation.timer === index && cancellation.definite);
    lines.push(`    callback_${index}_pending' = ${!timer.initiallyCancelled && !definitelyCancelled && timer.enqueuedBy === undefined},`, `    callback_${index}_due' = ${timer.delay},`, `    callback_${index}_fires' = 0,`);
    if (timer.externalAbortSignal) lines.push(`    callback_${index}_external_aborted' = false,`);
    if (timer.priorityChanges?.length) lines.push(`    callback_${index}_priority' = ${timer.priority === "user-blocking" ? 2 : timer.priority === "background" ? 0 : 1},`, `    callback_${index}_priority_step' = 0,`);
    if (timer.queue === "microtask") lines.push(`    callback_${index}_ticket' = ${initialTicket.get(`callback:${index}`) ?? -1},`);
  });
  abortCompositions.forEach((composition, index) => {
    const source = composition.initiallyAbortedSource;
    lines.push(`    abort_${index}_aborted' = ${source !== undefined},`, `    abort_${index}_reason_source' = ${source === undefined ? 0 : source + 1},`, `    abort_${index}_reason_overwritten' = false,`);
    if (composition.sourcePaths) lines.push(`    abort_${index}_path' = -1,`);
  });
  promiseModel?.chains.forEach((chain, chainIndex) => {
    chain.links.forEach((_, stage) => {
      const queued = initiallyQueuedReactions.has(`${chainIndex}:${stage}`);
      lines.push(`    promise_reaction_${chainIndex}_${stage}_pending' = ${queued},`, `    promise_reaction_${chainIndex}_${stage}_done' = false,`, `    promise_reaction_${chainIndex}_${stage}_ticket' = ${initialTicket.get(`reaction:${chainIndex}:${stage}`) ?? -1},`);
    });
  });
  lines.push("  }");
  const promiseVariables = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((_, stage) => [`promise_reaction_${chainIndex}_${stage}_pending`, `promise_reaction_${chainIndex}_${stage}_done`, `promise_reaction_${chainIndex}_${stage}_ticket`])) ?? [];
  const variables = [clock, phase, "wrong_phase", "fifo_broken", "scheduler_priority_broken", "scheduler_abort_broken", "abort_source_broken", "callback_precondition_broken", "next_microtask_ticket", ...temporalStates.map((state) => safe(state.name)), ...model.timers.flatMap((timer, index) => [`callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`, ...(timer.externalAbortSignal ? [`callback_${index}_external_aborted`] : []), ...(timer.priorityChanges?.length ? [`callback_${index}_priority`, `callback_${index}_priority_step`] : []), ...(timer.queue === "microtask" ? [`callback_${index}_ticket`] : [])]), ...abortCompositions.flatMap((composition, index) => [`abort_${index}_aborted`, `abort_${index}_reason_source`, `abort_${index}_reason_overwritten`, ...(composition.sourcePaths ? [`abort_${index}_path`] : [])]), ...promiseVariables];
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name); lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    variables.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const phaseGuard = (expected: number): string[] => options.allowWrongPhase ? [] : [`${phase} == ${expected}`];
  abortCompositions.forEach((composition, compositionIndex) => composition.sourcePaths?.forEach((_, pathIndex) => {
    const initialSource = composition.initiallyAbortedSources?.[pathIndex];
    action(`choose_abort_${compositionIndex}_path_${pathIndex}`, [`abort_${compositionIndex}_path == -1`], new Map([
      [`abort_${compositionIndex}_path`, String(pathIndex)],
      [`abort_${compositionIndex}_aborted`, String(initialSource !== undefined)],
      [`abort_${compositionIndex}_reason_source`, String(initialSource === undefined ? 0 : initialSource + 1)],
    ]));
  }));
  const jobs = [...microtasks.map((index) => ({ pending: `callback_${index}_pending`, ticket: `callback_${index}_ticket` })), ...(promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.map((_, stage) => ({ pending: `promise_reaction_${chainIndex}_${stage}_pending`, ticket: `promise_reaction_${chainIndex}_${stage}_ticket` }))) ?? [])];
  const fifoViolation = (ticket: string): string => jobs.map((job) => `(${job.pending} and ${job.ticket} < ${ticket})`).join(" or ") || "false";
  const fifoGuards = (ticket: string): string[] => options.allowOutOfOrderMicrotasks ? [] : [`not(${fifoViolation(ticket)})`];
  const applyCallbackSummary = (index: number, guards: string[], updates: Map<string, string>): void => {
    const summary = temporalComposition?.summaries.get(model.timers[index]!.callback);
    if (!summary) return;
    const requirements = summary.requires.map(generateQuintExpression);
    if (!options.allowCallbackPreconditionViolation) guards.push(...requirements);
    else if (requirements.length) updates.set("callback_precondition_broken", `callback_precondition_broken or not(${requirements.map((item) => `(${item})`).join(" and ")})`);
    summary.ensures.forEach((item) => updates.set(safe(item.target), generateQuintExpression(item.expressionAst)));
  };
  const enqueueChildren = (parent: number, updates: Map<string, string>, alternative?: number): void => {
    const belongsToAlternative = (index: number): boolean => model.timers[index]!.parentAlternative === undefined
      || model.timers[index]!.parentAlternative === alternative;
    const children = microtasks.filter((index) => model.timers[index]!.enqueuedBy === parent && belongsToAlternative(index));
    children.forEach((child, offset) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_ticket`, offset === 0 ? "next_microtask_ticket" : `next_microtask_ticket + ${offset}`);
    });
    if (children.length) updates.set("next_microtask_ticket", children.length === 1 ? "next_microtask_ticket + 1" : `next_microtask_ticket + ${children.length}`);
    schedulerTasks.filter((index) => model.timers[index]!.enqueuedBy === parent && belongsToAlternative(index)).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_due`, `${clock} + ${model.timers[child]!.delay}`);
    });
  };
  microtasks.forEach((index) => {
    const ticket = `callback_${index}_ticket`;
    const alternatives: (number | undefined)[] = model.timers[index]!.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([
        [`callback_${index}_pending`, "false"], [ticket, "-1"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 1`], ["fifo_broken", fifoViolation(ticket)],
      ]);
      enqueueChildren(index, updates, alternative);
      const guards = [...phaseGuard(1), `callback_${index}_pending`, ...fifoGuards(ticket)];
      applyCallbackSummary(index, guards, updates);
      const baseName = `drain_microtask_${index}`;
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, guards, updates);
    }
  });
  const promisePending: string[] = [];
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    const pending = `promise_reaction_${chainIndex}_${stage}_pending`, done = `promise_reaction_${chainIndex}_${stage}_done`, ticket = `promise_reaction_${chainIndex}_${stage}_ticket`;
    promisePending.push(pending);
    const updates = new Map<string, string>([[pending, "false"], [done, "true"], [ticket, "-1"], ["wrong_phase", `${phase} != 1`], ["fifo_broken", fifoViolation(ticket)]]);
    if (stage + 1 < chain.links.length) {
      updates.set(`promise_reaction_${chainIndex}_${stage + 1}_pending`, "true");
      updates.set(`promise_reaction_${chainIndex}_${stage + 1}_ticket`, "next_microtask_ticket");
      updates.set("next_microtask_ticket", "next_microtask_ticket + 1");
    }
    action(`drain_promise_reaction_${chainIndex}_${stage}`, [...phaseGuard(1), pending, ...fifoGuards(ticket)], updates);
  }));
  action("finish_microtask_checkpoint", [...phaseGuard(1), ...microtasks.map((index) => `not(callback_${index}_pending)`), ...promisePending.map((name) => `not(${name})`)], new Map([[phase, "2"], ["wrong_phase", `${phase} != 1`]]));
  frames.forEach((index, order) => {
    const alternatives: (number | undefined)[] = model.timers[index]!.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([[phase, "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 2`]]);
      enqueueChildren(index, updates, alternative);
      const guards = [...phaseGuard(2), `callback_${index}_pending`, ...frames.slice(0, order).map((earlier) => `not(callback_${earlier}_pending)`)];
      applyCallbackSummary(index, guards, updates);
      const baseName = `run_animation_frame_${index}`;
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, guards, updates);
    }
  });
  action("paint", [...phaseGuard(2), ...frames.map((index) => `not(callback_${index}_pending)`)], new Map([[phase, "0"], ["wrong_phase", `${phase} != 2`]]));
  action("skip_rendering_opportunity", phaseGuard(2), new Map([[phase, "0"], ["wrong_phase", `${phase} != 2`]]));
  action("advance_clock", phaseGuard(0), new Map([[clock, `${clock} + 1`], ["wrong_phase", `${phase} != 0`]]));
  action("idle_turn", phaseGuard(0), new Map([[phase, "1"], ["wrong_phase", `${phase} != 0`]]));
  const priorityRank = (priority: TimerPattern["priority"]): number => priority === "user-blocking" ? 2 : priority === "background" ? 0 : 1;
  const priorityTerm = (index: number): string => model.timers[index]!.priorityChanges?.length ? `callback_${index}_priority` : String(priorityRank(model.timers[index]!.priority));
  model.timers.forEach((timer, index) => timer.priorityChanges?.forEach((priority, step) => {
    action(`reprioritize_scheduler_task_${index}_${step}`, [`callback_${index}_priority_step == ${step}`], new Map([
      [`callback_${index}_priority`, String(priorityRank(priority))],
      [`callback_${index}_priority_step`, String(step + 1)],
    ]));
  }));
  const pendingPriorityChanges = model.timers.flatMap((timer, index) => timer.priorityChanges?.length ? [`callback_${index}_priority_step == ${timer.priorityChanges.length}`] : []);
  schedulerTasks.forEach((index) => {
    const timer = model.timers[index]!;
    const rank = priorityTerm(index);
    const outranking = schedulerTasks.flatMap((other) => {
      if (other === index) return [];
      const otherRank = priorityTerm(other);
      return [`(callback_${other}_pending and callback_${other}_due <= clock and (${otherRank} > ${rank} or (${otherRank} == ${rank} and ${other} < ${index})))`];
    });
    const violation = outranking.join(" or ") || "false";
    const abortViolation = [timer.abortComposition === undefined ? undefined : `abort_${timer.abortComposition}_aborted`, timer.abortTimer === undefined ? undefined : `callback_${timer.abortTimer}_fires > 0`].filter((term): term is string => Boolean(term)).join(" or ") || "false";
    const abortChoiceGuards = timer.abortComposition !== undefined && abortCompositions[timer.abortComposition]?.sourcePaths
      ? [`abort_${timer.abortComposition}_path >= 0`] : [];
    const alternatives: (number | undefined)[] = timer.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([
        [phase, "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 0`], ["scheduler_priority_broken", violation], ["scheduler_abort_broken", `scheduler_abort_broken or (${abortViolation})`],
      ]);
      enqueueChildren(index, updates, alternative);
      const guards = [...phaseGuard(0), ...pendingPriorityChanges, ...abortChoiceGuards, `callback_${index}_pending`, `${clock} >= callback_${index}_due`, ...(options.allowWrongSchedulerPriority ? [] : [`not(${violation})`]), ...(options.allowRunAbortedSchedulerTask ? [] : [`not(${abortViolation})`])];
      applyCallbackSummary(index, guards, updates);
      const baseName = timerAction("run", timer, index);
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, guards, updates);
    }
    if (options.allowRunAbortedSchedulerTask && abortViolation !== "false") action(`run_aborted_scheduler_task_${index}`, [`callback_${index}_pending`, `(${abortViolation})`], new Map([
      [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["scheduler_abort_broken", "true"],
    ]));
    if (!options.allowRunAbortedSchedulerTask && timer.abortComposition !== undefined) action(`cancel_scheduler_task_${index}_from_composition_${timer.abortComposition}`, [`callback_${index}_pending`, `abort_${timer.abortComposition}_aborted`], new Map([[`callback_${index}_pending`, "false"]]));
    if (!options.allowRunAbortedSchedulerTask && timer.abortTimer !== undefined) action(`cancel_scheduler_task_${index}_from_timer_${timer.abortTimer}`, [`callback_${index}_pending`, `callback_${timer.abortTimer}_fires > 0`], new Map([[`callback_${index}_pending`, "false"]]));
    if (timer.externalAbortSignal) action(`cancel_scheduler_task_${index}_from_external_signal`, [`callback_${index}_pending`, `not(callback_${index}_external_aborted)`], new Map([[`callback_${index}_pending`, "false"], [`callback_${index}_external_aborted`, "true"]]));
  });
  timers.forEach((index, order) => {
    const timer = model.timers[index]!;
    const earlierDue = timers.slice(0, order).map((earlier) => `not(callback_${earlier}_pending) or callback_${earlier}_due > clock`);
    const alternatives: (number | undefined)[] = timer.callbackAlternatives?.map((_, alternative) => alternative) ?? [undefined];
    for (const alternative of alternatives) {
      const updates = new Map<string, string>([
        [phase, "1"], [`callback_${index}_pending`, String(timer.repeats)], [`callback_${index}_due`, timer.repeats ? `${clock} + ${timer.delay}` : `callback_${index}_due`], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 0`],
      ]);
      enqueueChildren(index, updates, alternative);
      const guards = [...phaseGuard(0), `callback_${index}_pending`, `${clock} >= callback_${index}_due`, ...earlierDue];
      applyCallbackSummary(index, guards, updates);
      const baseName = timerAction("run", timer, index);
      action(alternative === undefined ? baseName : `${baseName}_alt_${alternative}`, guards, updates);
    }
  });
  for (const timer of new Set((model.timerEscapes ?? []).map((escape) => escape.timer))) {
    action(`external_cancel_timer_${timer}`, [`callback_${timer}_pending`], new Map([[`callback_${timer}_pending`, "false"]]));
  }
  abortCompositions.forEach((composition, compositionIndex) => {
    composition.sources.forEach((_, sourceIndex) => {
      const timer = composition.sourceTimers[sourceIndex];
      const sourceComposition = composition.sourceCompositions?.[sourceIndex];
      const source = sourceIndex + 1;
      const pathGuard = composition.sourcePaths
        ? [`(${composition.sourcePaths.flatMap((path, pathIndex) => path.includes(sourceIndex) ? [`abort_${compositionIndex}_path == ${pathIndex}`] : []).join(" or ") || "false"})`]
        : [];
      const firstAbortGuard = [...pathGuard, ...(options.allowAbortReasonOverwrite ? [] : [`not(abort_${compositionIndex}_aborted)`])];
      if (sourceComposition !== undefined) action(`abort_${compositionIndex}_from_composition_${sourceComposition}`, [...firstAbortGuard, ...(options.allowEarlyAbortComposition ? [] : [`abort_${sourceComposition}_aborted`])], new Map([
        [`abort_${compositionIndex}_aborted`, "true"], [`abort_${compositionIndex}_reason_source`, String(source)], [`abort_${compositionIndex}_reason_overwritten`, `abort_${compositionIndex}_aborted`], ["abort_source_broken", `not(abort_${sourceComposition}_aborted)`],
      ]));
      else if (timer === undefined) action(`abort_${compositionIndex}_from_external_${sourceIndex}`, firstAbortGuard, new Map([
        [`abort_${compositionIndex}_aborted`, "true"], [`abort_${compositionIndex}_reason_source`, String(source)], [`abort_${compositionIndex}_reason_overwritten`, `abort_${compositionIndex}_aborted`],
      ]));
      else action(`abort_${compositionIndex}_from_timer_${timer}`, [...firstAbortGuard, `callback_${timer}_fires > 0`], new Map([
        [`abort_${compositionIndex}_aborted`, "true"], [`abort_${compositionIndex}_reason_source`, String(source)], [`abort_${compositionIndex}_reason_overwritten`, `abort_${compositionIndex}_aborted`],
      ]));
    });
  });
  const oneShotSignals = model.timers.flatMap((timer, index) => timer.kind === "abort-timeout" ? [`callback_${index}_fires <= 1`] : []);
  const abortReasons = abortCompositions.map((composition, index) => `(not(abort_${index}_reason_overwritten) and ((not(abort_${index}_aborted) and abort_${index}_reason_source == 0) or (abort_${index}_aborted and abort_${index}_reason_source >= 1 and abort_${index}_reason_source <= ${composition.sources.length})))`);
  const callbackPreconditions = model.timers.flatMap((timer, index) => {
    const summary = temporalComposition?.summaries.get(timer.callback);
    if (!summary?.requires.length) return [];
    const requirement = summary.requires.map((item) => `(${generateQuintExpression(item)})`).join(" and ");
    return [`(not(callback_${index}_pending) or ${clock} < callback_${index}_due or (${requirement}))`];
  });
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  temporalComposition?.properties.forEach((property) => lines.push("", `  val ${safe(property.name)} = ${generateQuintExpression(property.expressionAst)}`));
  lines.push("", `  val eventLoopSafe = not(wrong_phase) and not(fifo_broken) and not(scheduler_priority_broken) and not(scheduler_abort_broken) and not(abort_source_broken) and not(callback_precondition_broken)${[...oneShotSignals, ...abortReasons, ...callbackPreconditions].map((term) => ` and ${term}`).join("")}`, "}", "");
  return lines.join("\n");
}
