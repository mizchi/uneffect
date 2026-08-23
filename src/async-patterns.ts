import ts from "typescript";
import { basename, dirname } from "node:path";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import type { PromiseCombinator } from "./builtin-contracts.js";
import type { PromiseChainModel } from "./promise-chains.js";
import type { TemporalComposition } from "./temporal-compose.js";
import { formatTemporalValueType, generateQuintExpression } from "./temporal-expressions.js";

export interface TimerPattern {
  owner: string;
  callback: string;
  delay?: number;
  recursive: boolean;
  repeats: boolean;
  queue: "timer" | "microtask" | "animation-frame" | "scheduler-task" | "next-tick" | "poll" | "check";
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
  span: { start: number; end: number };
}

export interface PromiseCombinatorPattern {
  owner: string;
  combinator: PromiseCombinator;
  branches: string[];
  branchKinds: ("value" | "thenable" | "unknown")[];
  branchAlternatives?: string[][];
  branchPresence?: ("always" | "when-true" | "when-false")[];
  staticIterable: boolean;
  iteratorKind: "array" | "set" | "local" | "dynamic";
  iteratorEffects: [] | ["InvokeUserCode"];
  iteratorFailure?: "acquire" | "step";
  iteratorFailurePresence?: "when-true" | "when-false";
  aggregateErrorOrder?: number[];
  aggregateErrorReasons?: Array<PromiseRejectionReason | null>;
  awaited: boolean;
  catchesRejection: boolean;
  span: { start: number; end: number };
}
export type PromiseRejectionReason =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "error"; errorType: string; message?: string };

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

function functionName(node: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}

export function analyzeAsyncPatternsInProgram(program: ts.Program, source: ts.SourceFile): AsyncPatternModel {
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const defaultLibDirectory = dirname(ts.getDefaultLibFilePath(program.getCompilerOptions()));
  const timers: TimerPattern[] = [], combinators: PromiseCombinatorPattern[] = [], cancellations: TimerCancellation[] = [], abortCompositions: AbortCompositionPattern[] = [], timerEscapes: TimerHandleEscape[] = [];
  const branchKind = (element: ts.Expression | ts.OmittedExpression): "value" | "thenable" | "unknown" => {
    if (ts.isOmittedExpression(element)) return "value";
    const type = checker.getTypeAtLocation(element);
    const members = type.isUnion() ? type.types : [type];
    if (members.some((member) => Boolean(member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))) return "unknown";
    const thenable = members.map((member) => Boolean(checker.getPropertyOfType(member, "then")));
    return thenable.every(Boolean) ? "thenable" : thenable.some(Boolean) ? "unknown" : "value";
  };
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
  type StaticArrayExpansionEvidence = { invokesUserCode: boolean; failure?: "acquire" | "step" };
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
    if (ts.isAsExpression(expression) && expression.type.getText(source) === "const") {
      return expandStaticArray(expression.expression, seen, evidence);
    }
    if (!ts.isArrayLiteralExpression(expression)) return undefined;
    const expanded: (ts.Expression | ts.OmittedExpression)[] = [];
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) expanded.push(element);
      else {
        let nested = expandStaticArray(element.expression, seen, evidence) ?? expandStaticSet(element.expression);
        if (!nested) {
          const local = localIterable(element.expression);
          if (local && !local.alternatives) {
            nested = local.branches;
            if (evidence) {
              evidence.invokesUserCode = true;
              evidence.failure ??= local.failure;
            }
          }
        }
        if (!nested) return undefined;
        expanded.push(...nested);
      }
    }
    return expanded;
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
    alternatives?: readonly [ts.Expression[], ts.Expression[]];
    failure?: "acquire" | "step";
    failurePresence?: "when-true" | "when-false";
  };
  const linearGeneratorBody = (
    body: ts.Block,
    substitutions = new Map<ts.Symbol, ts.Expression>(),
  ): FiniteIterableExpansion | undefined => {
    const substitute = (expression: ts.Expression): ts.Expression => ts.isIdentifier(expression)
      ? substitutions.get(resolvedSymbol(expression)!) ?? expression : expression;
    const direct = (statements: readonly ts.Statement[]): { branches: ts.Expression[]; failure?: "step"; completes: boolean } | undefined => {
      const branches: ts.Expression[] = [];
      for (const statement of statements) {
        if (ts.isExpressionStatement(statement) && ts.isYieldExpression(statement.expression)
          && statement.expression.expression && !statement.expression.asteriskToken) {
          branches.push(substitute(statement.expression.expression));
        } else if (ts.isThrowStatement(statement)) return { branches, failure: "step", completes: false };
        else if (ts.isReturnStatement(statement)) return { branches, completes: false };
        else if (!ts.isEmptyStatement(statement)) return undefined;
      }
      return { branches, completes: true };
    };
    const conditionalIndices = body.statements.flatMap((statement, index) => ts.isIfStatement(statement) ? [index] : []);
    if (conditionalIndices.length === 1) {
      const index = conditionalIndices[0]!, statement = body.statements[index] as ts.IfStatement;
      if (!statement.elseStatement) return undefined;
      const statementsOf = (node: ts.Statement): readonly ts.Statement[] => ts.isBlock(node) ? node.statements : [node];
      const prefix = direct(body.statements.slice(0, index));
      const whenTrue = direct(statementsOf(statement.thenStatement));
      const whenFalse = direct(statementsOf(statement.elseStatement));
      const suffix = direct(body.statements.slice(index + 1));
      if (!prefix || !whenTrue || !whenFalse || !suffix) return undefined;
      if (!prefix.completes) return prefix;
      const truePath = [...prefix.branches, ...whenTrue.branches, ...(whenTrue.completes ? suffix.branches : [])];
      const falsePath = [...prefix.branches, ...whenFalse.branches, ...(whenFalse.completes ? suffix.branches : [])];
      const trueFailure = whenTrue.failure ?? (whenTrue.completes ? suffix.failure : undefined);
      const falseFailure = whenFalse.failure ?? (whenFalse.completes ? suffix.failure : undefined);
      const failure = trueFailure ?? falseFailure;
      const failurePresence = Boolean(trueFailure) !== Boolean(falseFailure)
        ? trueFailure ? "when-true" as const : "when-false" as const
        : undefined;
      return {
        branches: truePath,
        alternatives: [truePath, falsePath],
        failure,
        failurePresence,
      };
    }
    if (conditionalIndices.length > 0) return undefined;
    return direct(body.statements);
  };
  function localIterable(
    expression: ts.Expression | undefined,
    seen = new Set<ts.Symbol>(),
  ): FiniteIterableExpansion | undefined {
    if (!expression) return undefined;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return localIterable(expression.expression, seen);
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
      return localIterable(declaration.initializer, nextSeen);
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
          return linearGeneratorBody(iterator.body);
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
        const substitutions = new Map<ts.Symbol, ts.Expression>();
        declaration.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name) || !expression.arguments[index]) return;
          const symbol = resolvedSymbol(parameter.name);
          if (symbol) substitutions.set(symbol, expression.arguments[index]);
        });
        return linearGeneratorBody(iterator.body, substitutions);
      }
    }
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.asteriskToken && declaration.body) {
      const substitutions = new Map<ts.Symbol, ts.Expression>();
      if (ts.isCallExpression(expression)) declaration.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || !expression.arguments[index]) return;
        const symbol = resolvedSymbol(parameter.name);
        if (symbol) substitutions.set(symbol, expression.arguments[index]);
      });
      return linearGeneratorBody(declaration.body, substitutions);
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
  const visitFunction = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body) return;
    const ownerName = functionName(owner);
    const handleAliases = new Map<string, string>();
    const handleTargets = new Map<string, number>();
    const abortSignalTargets = new Map<string, AbortTarget>();
    const taskControllers = new Map<string, { priority: NonNullable<TimerPattern["priority"]>; tasks: number[] }>();
    const staticPriority = (expression: ts.Expression | undefined): TimerPattern["priority"] => expression && ts.isStringLiteralLike(expression)
      && (expression.text === "user-blocking" || expression.text === "user-visible" || expression.text === "background") ? expression.text : undefined;
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
        const elements = argument ? expandStaticArray(argument) : undefined;
        if (!elements || !elements.every((element): element is ts.Expression => !ts.isOmittedExpression(element))) return undefined;
        const targets = elements.map((element) => abortTarget(element, seen, bindings));
        const composition = abortCompositions.length;
        const initiallyAbortedSource = targets.findIndex((target) => target?.alreadyAborted);
        const expressionSource = expression.getSourceFile();
        abortCompositions.push({
          owner: ownerName,
          sources: elements.map((element) => element.getText(expressionSource)),
          sourceTimers: targets.map((target) => target?.timer),
          sourceCompositions: targets.map((target) => target?.composition),
          sourceReasons: targets.map((target) => target?.reason),
          initiallyAbortedSource: initiallyAbortedSource < 0 ? undefined : initiallyAbortedSource,
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
      for (const callback of resolveCallbacks(callbackExpression)) {
        if (!callback.body || visited.has(callback)) continue;
        visited.add(callback);
        const scan = (node: ts.Node): void => {
          if (node !== callback && ts.isFunctionLike(node)) return;
          if (ts.isCallExpression(node)) {
            const operation = adapter.resolveCall(node)?.operation;
            if (operation?.kind === "timer" && (operation.queue === "microtask" || operation.queue === "next-tick" || operation.queue === "timer" || operation.queue === "check")) {
              if (operation.queue === "timer" && (timers[parent]!.repeats || node.getStart(node.getSourceFile()) === timers[parent]!.span.start)) return;
              const child = timers.length;
              const callbackNode = node.arguments[operation.callbackArgument];
              const delayNode = operation.delayArgument === undefined ? undefined : node.arguments[operation.delayArgument];
              const childSource = node.getSourceFile();
              timers.push({ owner: ownerName, callback: callbackNode?.getText(childSource) ?? "<unknown>", delay: operation.delayArgument === undefined ? 0 : staticNumber(delayNode), recursive: false, repeats: operation.repeats, queue: operation.queue, enqueuedBy: parent, handleFamily: operation.queue === "timer" ? "timeout" : operation.queue === "check" ? "immediate" : undefined, span: { start: node.getStart(childSource), end: node.getEnd() } });
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
      if (node !== owner.body && ts.isFunctionLike(node)) return;
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
          const optionsObject = optionsNode && ts.isObjectLiteralExpression(optionsNode) ? optionsNode : undefined;
          const option = (name: string): ts.Expression | undefined => optionsObject?.properties.flatMap((property) => {
            if (ts.isPropertyAssignment(property) && property.name.getText(source).replaceAll(/["']/g, "") === name) return [property.initializer];
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return [property.name];
            return [];
          })[0];
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
          while (current.parent && current.parent !== owner.body) {
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
          const staticIterable = Boolean(boundedElements || local);
          const branchNodes = local?.branches;
          const iterableAlternatives = boundedConditionalArrays ?? local?.alternatives;
          const branchAlternatives = iterableAlternatives ? Array.from({ length: Math.max(iterableAlternatives[0].length, iterableAlternatives[1].length) }, (_, index) =>
            [iterableAlternatives[0][index], iterableAlternatives[1][index]].map((candidate) => candidate === undefined ? "<absent>" : ts.isOmittedExpression(candidate) ? "<hole>" : candidate.getText())) : undefined;
          const branchPresence = iterableAlternatives ? branchAlternatives!.map((_, index) =>
            iterableAlternatives[0][index] === undefined ? "when-false" : iterableAlternatives[1][index] === undefined ? "when-true" : "always" as const) : undefined;
          const branches = branchAlternatives ? branchAlternatives.map((alternatives) => alternatives.join(" | "))
            : boundedElements ? boundedElements.map((item) => ts.isOmittedExpression(item) ? "<hole>" : item.getText()) : branchNodes?.map((item) => item.getText()) ?? [];
          const branchKinds = iterableAlternatives ? branchAlternatives!.map((_, index) => {
            const kinds = [iterableAlternatives[0][index], iterableAlternatives[1][index]].flatMap((item) => item === undefined ? [] : [branchKind(item)]);
            return kinds.every((kind) => kind === kinds[0]) ? kinds[0]! : "unknown";
          }) : (boundedElements ? boundedElements.map(branchKind) : branchNodes?.map(branchKind) ?? []);
          let current: ts.Node = node;
          while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
          const awaited = ts.isAwaitExpression(current.parent);
          if (awaited) current = current.parent;
          let catchesRejection = false;
          while (current.parent && current.parent !== owner.body) {
            if (ts.isTryStatement(current.parent) && current.parent.tryBlock === current && current.parent.catchClause) catchesRejection = true;
            current = current.parent;
          }
          combinators.push({ owner: ownerName, combinator: operation.combinator, branches, branchKinds, ...(branchAlternatives ? { branchAlternatives, branchPresence } : {}), staticIterable,
            iteratorKind: set ? "set" : array || boundedConditionalArrays ? "array" : local ? "local" : "dynamic",
            iteratorEffects: boundedElements ? arrayEvidence.invokesUserCode ? ["InvokeUserCode"] : [] : ["InvokeUserCode"],
            iteratorFailure: arrayEvidence.failure ?? local?.failure,
            iteratorFailurePresence: local?.failurePresence,
            aggregateErrorOrder: operation.combinator === "any" ? branches.map((_, index) => index) : undefined,
            aggregateErrorReasons: operation.combinator === "any" && (array ?? set ?? (local?.alternatives ? undefined : branchNodes))
              ? (array ?? set ?? branchNodes)!.map(rejectionReason) : undefined,
            awaited, catchesRejection, span: { start: node.getStart(source), end: node.getEnd() } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
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
  for (const join of model.combinators) if (!join.staticIterable) throw new Error(`${join.owner}: Promise.${join.combinator} model requires a statically bounded iterable`);
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int"];
  model.timers.forEach((_, index) => lines.push(`  var timer_${index}_scheduled: bool`, `  var timer_${index}_cancelled: bool`, `  var timer_${index}_due: int`, `  var timer_${index}_early: bool`, `  var timer_${index}_after_cancel: bool`, `  var timer_${index}_macro_first: bool`, `  var timer_${index}_fires: int`));
  model.combinators.forEach((join, index) => {
    join.branches.forEach((_, branch) => lines.push(`  var join_${index}_branch_${branch}: int`));
    if (join.branchPresence?.some((presence) => presence !== "always")) lines.push(`  var join_${index}_iterable_choice: int`);
    lines.push(`  var join_${index}_result: int`, `  var join_${index}_iterator_failed: bool`, `  var join_${index}_rejection_escapes: bool`);
    if (join.aggregateErrorOrder) {
      const hasConditionalPresence = join.branchPresence?.some((presence) => presence !== "always") ?? false;
      if (hasConditionalPresence) {
        const trueCount = join.branchPresence!.filter((presence) => presence !== "when-false").length;
        const falseCount = join.branchPresence!.filter((presence) => presence !== "when-true").length;
        lines.push(`  def join_${index}_aggregate_error_count = if (join_${index}_iterable_choice == -1) 0 else if (join_${index}_iterable_choice == 1) ${trueCount} else ${falseCount}`);
      } else lines.push(`  val join_${index}_aggregate_error_count = ${join.aggregateErrorOrder.length}`);
      join.aggregateErrorOrder.forEach((slot, rank) => lines.push(`  val join_${index}_aggregate_error_slot_${rank} = ${slot}`));
      join.aggregateErrorReasons?.forEach((reason, rank) => {
        const encoded = reason?.kind === "literal" ? `literal:${typeof reason.value}:${String(reason.value)}`
          : reason?.kind === "error" ? `error:${reason.errorType}:${reason.message ?? ""}` : "unknown";
        lines.push(`  val join_${index}_aggregate_error_reason_${rank} = ${JSON.stringify(encoded)}`);
      });
    }
  });
  lines.push("", "  action init = all {", "    clock' = 0,");
  model.timers.forEach((timer, index) => {
    const cancelled = timer.initiallyCancelled || model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    timer_${index}_scheduled' = ${!cancelled},`, `    timer_${index}_cancelled' = ${cancelled},`, `    timer_${index}_due' = ${timer.delay},`, `    timer_${index}_early' = false,`, `    timer_${index}_after_cancel' = false,`, `    timer_${index}_macro_first' = false,`, `    timer_${index}_fires' = 0,`);
  });
  model.combinators.forEach((join, index) => { join.branches.forEach((_, branch) => lines.push(`    join_${index}_branch_${branch}' = 0,`)); if (join.branchPresence?.some((presence) => presence !== "always")) lines.push(`    join_${index}_iterable_choice' = -1,`); lines.push(`    join_${index}_result' = 0,`, `    join_${index}_iterator_failed' = false,`, `    join_${index}_rejection_escapes' = false,`); });
  lines.push("  }");
  const allVars = ["clock", ...model.timers.flatMap((_, i) => [`timer_${i}_scheduled`, `timer_${i}_cancelled`, `timer_${i}_due`, `timer_${i}_early`, `timer_${i}_after_cancel`, `timer_${i}_macro_first`, `timer_${i}_fires`]), ...model.combinators.flatMap((join, i) => [...join.branches.map((_, b) => `join_${i}_branch_${b}`), ...(join.branchPresence?.some((presence) => presence !== "always") ? [`join_${i}_iterable_choice`] : []), `join_${i}_result`, `join_${i}_iterator_failed`, `join_${i}_rejection_escapes`])];
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
    const hasChoice = join.branchPresence?.some((presence) => presence !== "always") ?? false;
    if (hasChoice) {
      action(`choose_iterable_${index}_true`, [`join_${index}_iterable_choice == -1`], new Map([[`join_${index}_iterable_choice`, "1"]]));
      action(`choose_iterable_${index}_false`, [`join_${index}_iterable_choice == -1`], new Map([[`join_${index}_iterable_choice`, "0"]]));
    }
    const presence = (branch: number): string => join.branchPresence?.[branch] === "when-true" ? `join_${index}_iterable_choice == 1`
      : join.branchPresence?.[branch] === "when-false" ? `join_${index}_iterable_choice == 0` : "true";
    const failurePresence = join.iteratorFailurePresence === "when-true" ? `join_${index}_iterable_choice == 1`
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
      const fulfillUpdates = new Map([[`join_${index}_branch_${branch}`, "1"]]);
      const rejectUpdates = new Map([[`join_${index}_branch_${branch}`, "2"]]);
      if (join.combinator === "race") {
        fulfillUpdates.set(`join_${index}_result`, "1");
        rejectUpdates.set(`join_${index}_result`, "2");
        rejectUpdates.set(`join_${index}_rejection_escapes`, String(!join.catchesRejection));
      }
      if (kind === "value") action(`fulfill_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard], fulfillUpdates);
      else {
        action(`assimilate_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard], new Map([[`join_${index}_branch_${branch}`, "3"]]));
        const fulfillGuard = kind === "unknown"
          ? `(join_${index}_branch_${branch} == 0 or join_${index}_branch_${branch} == 3)`
          : `join_${index}_branch_${branch} == 3`;
        action(`fulfill_${index}_${branch}`, [fulfillGuard, ...raceGuard], fulfillUpdates);
        action(`reject_${index}_${branch}`, [`join_${index}_branch_${branch} == 3`, ...raceGuard], rejectUpdates);
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
    const conditionalFailure = join.iteratorFailure && join.iteratorFailurePresence;
    if (join.iteratorFailure && !conditionalFailure) return [`fail_iterator_${i}`];
    return [...(join.branchPresence?.some((presence) => presence !== "always") ? [`choose_iterable_${i}_true`, `choose_iterable_${i}_false`] : []), ...(conditionalFailure ? [`fail_iterator_${i}`] : []), ...join.branches.flatMap((_, b) => {
    const kind = join.branchKinds?.[b] ?? "unknown";
    return kind === "value" ? [`fulfill_${i}_${b}`]
      : kind === "thenable" ? [`assimilate_${i}_${b}`, `fulfill_${i}_${b}`, `reject_${i}_${b}`]
      : [`fulfill_${i}_${b}`, `assimilate_${i}_${b}`, `reject_${i}_${b}`];
    }), `fulfill_join_${i}`, `reject_join_${i}`];
  })];
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const safeTerms = [...model.timers.flatMap((timer, i) => [`not(timer_${i}_early)`, `not(timer_${i}_after_cancel)`, `not(timer_${i}_macro_first)`, ...(timer.kind === "abort-timeout" ? [`timer_${i}_fires <= 1`] : [])]), ...model.combinators.flatMap((join, i) => {
    const presence = (branch: number): string => join.branchPresence?.[branch] === "when-true" ? `join_${i}_iterable_choice == 1`
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
  options: { allowMicrotaskBeforeNextTick?: boolean; allowMacroBeforeCheckpoint?: boolean; allowWrongPhase?: boolean } = {},
  promiseModel?: PromiseChainModel,
): string {
  for (const timer of model.timers) if (timer.delay === undefined
    || (timer.handleFamily !== "timeout" && (!Number.isFinite(timer.delay) || timer.delay < 0))) {
    throw new Error(`${timer.owner}: Node event-loop model requires a supported static delay`);
  }
  const supported = model.timers.flatMap((timer, index) => ["next-tick", "microtask", "timer", "poll", "check"].includes(timer.queue) ? [index] : []);
  const nodeDelay = (timer: TimerPattern): number => timer.handleFamily === "timeout"
    ? !Number.isFinite(timer.delay!) || timer.delay! < 1 || timer.delay! > 2_147_483_647 ? 1 : Math.trunc(timer.delay!)
    : timer.delay!;
  const nextTicks = supported.filter((index) => model.timers[index]!.queue === "next-tick");
  const microtasks = supported.filter((index) => model.timers[index]!.queue === "microtask");
  const timers = supported.filter((index) => model.timers[index]!.queue === "timer");
  const polls = supported.filter((index) => model.timers[index]!.queue === "poll");
  const checks = supported.filter((index) => model.timers[index]!.queue === "check");
  const initialReactions = new Set<string>();
  promiseModel?.chains.forEach((chain, chainIndex) => {
    const executor = chain.executor === undefined ? undefined : promiseModel.executors[chain.executor];
    if (chain.links.length && executor && executor.possibleSettlements.length > 0 && !executor.mayRemainPending) initialReactions.add(`${chainIndex}:0`);
  });
  const initialV8Jobs = [
    ...microtasks.flatMap((index) => model.timers[index]!.enqueuedBy === undefined ? [{ key: `callback:${index}`, span: model.timers[index]!.span.start }] : []),
    ...(promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((link, stage) =>
      initialReactions.has(`${chainIndex}:${stage}`) ? [{ key: `reaction:${chainIndex}:${stage}`, span: link.span.start }] : [])) ?? []),
  ].sort((left, right) => left.span - right.span);
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int", "  var node_phase: int", "  var resume_phase: int", "  var wrong_checkpoint_order: bool", "  var wrong_phase: bool"];
  supported.forEach((index) => lines.push(`  var callback_${index}_pending: bool`, `  var callback_${index}_due: int`, `  var callback_${index}_fires: int`));
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => lines.push(`  var promise_reaction_${chainIndex}_${stage}_pending: bool`, `  var promise_reaction_${chainIndex}_${stage}_done: bool`)));
  lines.push("", "  action init = all {", "    clock' = 0,", "    node_phase' = 0,", "    resume_phase' = 1,", `    wrong_checkpoint_order' = ${Boolean(options.allowMicrotaskBeforeNextTick || options.allowMacroBeforeCheckpoint)},`, `    wrong_phase' = ${Boolean(options.allowWrongPhase)},`);
  supported.forEach((index) => {
    const timer = model.timers[index]!;
    const cancelled = timer.initiallyCancelled || model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    callback_${index}_pending' = ${!cancelled && timer.enqueuedBy === undefined && !timer.externallyReady},`, `    callback_${index}_due' = ${nodeDelay(timer)},`, `    callback_${index}_fires' = 0,`);
  });
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    lines.push(`    promise_reaction_${chainIndex}_${stage}_pending' = ${initialReactions.has(`${chainIndex}:${stage}`)},`, `    promise_reaction_${chainIndex}_${stage}_done' = false,`);
  }));
  lines.push("  }");
  const reactionVariables = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((_, stage) => [`promise_reaction_${chainIndex}_${stage}_pending`, `promise_reaction_${chainIndex}_${stage}_done`])) ?? [];
  const variables = ["clock", "node_phase", "resume_phase", "wrong_checkpoint_order", "wrong_phase", ...supported.flatMap((index) => [`callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`]), ...reactionVariables];
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    variables.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const enqueueNodeChildren = (parent: number, updates: Map<string, string>): void => {
    [...nextTicks, ...microtasks].filter((index) => model.timers[index]!.enqueuedBy === parent)
      .forEach((child) => updates.set(`callback_${child}_pending`, "true"));
    checks.filter((index) => model.timers[index]!.enqueuedBy === parent).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_due`, "clock + 1");
    });
    timers.filter((index) => model.timers[index]!.enqueuedBy === parent).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_due`, `clock + ${nodeDelay(model.timers[child]!)}`);
    });
  };
  polls.forEach((index) => action(`complete_poll_${index}`, [
    `callback_${index}_fires == 0`, `not(callback_${index}_pending)`,
  ], new Map([[`callback_${index}_pending`, "true"]])));
  const phaseGuard = (expected: number): string[] => options.allowWrongPhase ? [`node_phase != ${expected}`] : [`node_phase == ${expected}`];
  const phaseViolation = (expected: number): string => `wrong_phase or node_phase != ${expected}`;
  nextTicks.forEach((index, order) => {
    const updates = new Map<string, string>([[`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", phaseViolation(0)]]);
    enqueueNodeChildren(index, updates);
    action(`drain_next_tick_${index}`, [
      ...phaseGuard(0), `callback_${index}_pending`,
      ...(options.allowMicrotaskBeforeNextTick ? microtasks.map((microtask) => `not(callback_${microtask}_pending)`) : []),
      ...nextTicks.slice(0, order).map((earlier) => `not(callback_${earlier}_pending)`),
    ], updates);
  });
  microtasks.forEach((index, order) => {
    const pendingNextTick = nextTicks.map((nextTick) => `callback_${nextTick}_pending`);
    const key = `callback:${index}`;
    const position = initialV8Jobs.findIndex((job) => job.key === key);
    const earlierV8 = (position >= 0 ? initialV8Jobs.slice(0, position) : microtasks
      .filter((candidate) => model.timers[candidate]!.enqueuedBy === model.timers[index]!.enqueuedBy && candidate < index)
      .map((candidate) => ({ key: `callback:${candidate}` }))).map((job) =>
      job.key.startsWith("callback:") ? `callback_${job.key.slice("callback:".length)}_pending`
        : `promise_reaction_${job.key.slice("reaction:".length).replace(":", "_")}_pending`);
    const updates = new Map<string, string>([
      [`callback_${index}_pending`, "false"],
      [`callback_${index}_fires`, `callback_${index}_fires + 1`],
      ["wrong_checkpoint_order", `wrong_checkpoint_order or (${pendingNextTick.join(" or ") || "false"})`],
      ["wrong_phase", phaseViolation(0)],
    ]);
    enqueueNodeChildren(index, updates);
    action(`drain_microtask_${index}`, [
      ...phaseGuard(0), `callback_${index}_pending`,
      ...(options.allowMicrotaskBeforeNextTick ? [] : pendingNextTick.map((pending) => `not(${pending})`)),
      ...earlierV8.map((pending) => `not(${pending})`),
    ], updates);
  });
  const pendingNextTick = nextTicks.map((nextTick) => `callback_${nextTick}_pending`);
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    const key = `reaction:${chainIndex}:${stage}`;
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
    const updates = new Map<string, string>([
      [`callback_${index}_pending`, String(timer.repeats)],
      [`callback_${index}_fires`, `callback_${index}_fires + 1`],
      [`callback_${index}_due`, timer.repeats ? `clock + ${nodeDelay(timer)}` : `callback_${index}_due`],
      ["node_phase", "0"],
      ["resume_phase", String(phase)],
      ["wrong_checkpoint_order", `wrong_checkpoint_order or (${checkpointPending.join(" or ") || "false"})`],
      ["wrong_phase", phaseViolation(phase)],
    ]);
    enqueueNodeChildren(index, updates);
    action(timer.queue === "check" ? `run_check_${index}` : timer.queue === "poll" ? `run_poll_${index}` : `run_timer_${index}`, [
      ...phaseGuard(phase), `callback_${index}_pending`, `clock >= callback_${index}_due`,
      ...(options.allowMacroBeforeCheckpoint ? [] : checkpointPending.map((pending) => `not(${pending})`)),
      ...earlier.map((item) => `not(callback_${item}_pending) or callback_${item}_due > clock`),
    ], updates);
  };
  timers.forEach((index, order) => macro(index, timers.slice(0, order), 1));
  polls.forEach((index) => macro(index, [], 2));
  checks.forEach((index, order) => macro(index, checks.slice(0, order), 3));
  action("advance_timers_to_poll", [
    ...phaseGuard(1), ...timers.map((index) => `not(callback_${index}_pending) or callback_${index}_due > clock`),
  ], new Map([["node_phase", "2"], ["wrong_phase", phaseViolation(1)]]));
  action("advance_poll_to_check", [
    ...phaseGuard(2), ...polls.map((index) => `not(callback_${index}_pending)`),
  ], new Map([["node_phase", "3"], ["wrong_phase", phaseViolation(2)]]));
  action("advance_check_to_close", [
    ...phaseGuard(3), ...checks.map((index) => `not(callback_${index}_pending) or callback_${index}_due > clock`),
  ], new Map([["node_phase", "4"], ["wrong_phase", phaseViolation(3)]]));
  action("advance_close_to_next_iteration", phaseGuard(4), new Map([
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
  abortCompositions.forEach((_, index) => lines.push(`  var abort_${index}_aborted: bool`, `  var abort_${index}_reason_source: int`, `  var abort_${index}_reason_overwritten: bool`));
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
  });
  promiseModel?.chains.forEach((chain, chainIndex) => {
    chain.links.forEach((_, stage) => {
      const queued = initiallyQueuedReactions.has(`${chainIndex}:${stage}`);
      lines.push(`    promise_reaction_${chainIndex}_${stage}_pending' = ${queued},`, `    promise_reaction_${chainIndex}_${stage}_done' = false,`, `    promise_reaction_${chainIndex}_${stage}_ticket' = ${initialTicket.get(`reaction:${chainIndex}:${stage}`) ?? -1},`);
    });
  });
  lines.push("  }");
  const promiseVariables = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((_, stage) => [`promise_reaction_${chainIndex}_${stage}_pending`, `promise_reaction_${chainIndex}_${stage}_done`, `promise_reaction_${chainIndex}_${stage}_ticket`])) ?? [];
  const variables = [clock, phase, "wrong_phase", "fifo_broken", "scheduler_priority_broken", "scheduler_abort_broken", "abort_source_broken", "callback_precondition_broken", "next_microtask_ticket", ...temporalStates.map((state) => safe(state.name)), ...model.timers.flatMap((timer, index) => [`callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`, ...(timer.externalAbortSignal ? [`callback_${index}_external_aborted`] : []), ...(timer.priorityChanges?.length ? [`callback_${index}_priority`, `callback_${index}_priority_step`] : []), ...(timer.queue === "microtask" ? [`callback_${index}_ticket`] : [])]), ...abortCompositions.flatMap((_, index) => [`abort_${index}_aborted`, `abort_${index}_reason_source`, `abort_${index}_reason_overwritten`]), ...promiseVariables];
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name); lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    variables.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const phaseGuard = (expected: number): string[] => options.allowWrongPhase ? [] : [`${phase} == ${expected}`];
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
  const enqueueChildren = (parent: number, updates: Map<string, string>): void => {
    const children = microtasks.filter((index) => model.timers[index]!.enqueuedBy === parent);
    children.forEach((child, offset) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_ticket`, offset === 0 ? "next_microtask_ticket" : `next_microtask_ticket + ${offset}`);
    });
    if (children.length) updates.set("next_microtask_ticket", children.length === 1 ? "next_microtask_ticket + 1" : `next_microtask_ticket + ${children.length}`);
    schedulerTasks.filter((index) => model.timers[index]!.enqueuedBy === parent).forEach((child) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_due`, `${clock} + ${model.timers[child]!.delay}`);
    });
  };
  microtasks.forEach((index) => {
    const ticket = `callback_${index}_ticket`;
    const updates = new Map<string, string>([
      [`callback_${index}_pending`, "false"], [ticket, "-1"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 1`], ["fifo_broken", fifoViolation(ticket)],
    ]);
    enqueueChildren(index, updates);
    const guards = [...phaseGuard(1), `callback_${index}_pending`, ...fifoGuards(ticket)];
    applyCallbackSummary(index, guards, updates);
    action(`drain_microtask_${index}`, guards, updates);
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
    const updates = new Map<string, string>([[phase, "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 2`]]);
    enqueueChildren(index, updates);
    const guards = [...phaseGuard(2), `callback_${index}_pending`, ...frames.slice(0, order).map((earlier) => `not(callback_${earlier}_pending)`)];
    applyCallbackSummary(index, guards, updates);
    action(`run_animation_frame_${index}`, guards, updates);
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
    const updates = new Map<string, string>([
      [phase, "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 0`], ["scheduler_priority_broken", violation], ["scheduler_abort_broken", `scheduler_abort_broken or (${abortViolation})`],
    ]);
    enqueueChildren(index, updates);
    const guards = [...phaseGuard(0), ...pendingPriorityChanges, `callback_${index}_pending`, `${clock} >= callback_${index}_due`, ...(options.allowWrongSchedulerPriority ? [] : [`not(${violation})`]), ...(options.allowRunAbortedSchedulerTask ? [] : [`not(${abortViolation})`])];
    applyCallbackSummary(index, guards, updates);
    action(timerAction("run", timer, index), guards, updates);
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
    const updates = new Map<string, string>([
      [phase, "1"], [`callback_${index}_pending`, String(timer.repeats)], [`callback_${index}_due`, timer.repeats ? `${clock} + ${timer.delay}` : `callback_${index}_due`], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 0`],
    ]);
    enqueueChildren(index, updates);
    const guards = [...phaseGuard(0), `callback_${index}_pending`, `${clock} >= callback_${index}_due`, ...earlierDue];
    applyCallbackSummary(index, guards, updates);
    action(timerAction("run", timer, index), guards, updates);
  });
  for (const timer of new Set((model.timerEscapes ?? []).map((escape) => escape.timer))) {
    action(`external_cancel_timer_${timer}`, [`callback_${timer}_pending`], new Map([[`callback_${timer}_pending`, "false"]]));
  }
  abortCompositions.forEach((composition, compositionIndex) => {
    composition.sources.forEach((_, sourceIndex) => {
      const timer = composition.sourceTimers[sourceIndex];
      const sourceComposition = composition.sourceCompositions?.[sourceIndex];
      const source = sourceIndex + 1;
      const firstAbortGuard = options.allowAbortReasonOverwrite ? [] : [`not(abort_${compositionIndex}_aborted)`];
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
