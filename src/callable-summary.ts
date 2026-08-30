import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { effectPermits, formatEffect, parseEffectSet, type Effect } from "./capabilities.js";
import { analyzeProgramEffects, type EvidenceStatus } from "./effects.js";

export type CallbackCardinality = "0" | "0..1" | "exactly-1" | "0..n" | "unknown";
export type CallbackTiming = "inline" | "deferred" | "promise-reaction" | "unknown";
export type CallbackCompletion = "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw" | "unknown";

export interface CallbackParameterSummary {
  readonly index: number;
  readonly name: string;
  readonly cardinality: CallbackCardinality;
  readonly timing: CallbackTiming;
  readonly completion: CallbackCompletion;
  readonly effectBound?: readonly string[];
  readonly spans: readonly { start: number; end: number }[];
}

export interface CallbackInvocationSummary {
  readonly api: string;
  readonly callback: string;
  readonly cardinality: CallbackCardinality;
  readonly timing: CallbackTiming;
  readonly completion: CallbackCompletion;
  readonly span: { start: number; end: number };
}

export interface CallableSummary {
  readonly schema: "uneffect-callable-summary/v1";
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly span: { start: number; end: number };
  readonly effects: readonly Effect[];
  readonly throws: readonly string[];
  readonly rejects: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly callbackParameters: readonly CallbackParameterSummary[];
  readonly callbackInvocations: readonly CallbackInvocationSummary[];
  readonly evidence: EvidenceStatus;
  readonly unknownReasons: readonly string[];
}

export interface CallableSummaryDiagnostic {
  readonly fileName: string;
  readonly functionName: string;
  readonly message: string;
  readonly span: { start: number; end: number };
}

export interface CallableSummaryAnalysis {
  readonly summaries: readonly CallableSummary[];
  readonly diagnostics: readonly CallableSummaryDiagnostic[];
}

export interface CallableInstantiation {
  readonly effects: readonly Effect[];
  readonly evidence: EvidenceStatus;
  readonly violations: readonly { parameter: string; effect: string }[];
}

/** Instantiates the callback portion of a summary without executing user code. */
export function instantiateCallableSummary(
  summary: CallableSummary,
  argumentsByIndex: ReadonlyMap<number, readonly Effect[]>,
): CallableInstantiation {
  const effects = [...summary.effects];
  const violations: { parameter: string; effect: string }[] = [];
  for (const parameter of summary.callbackParameters) {
    const actual = argumentsByIndex.get(parameter.index) ?? [];
    const allowed = parameter.effectBound?.flatMap((item) => parseEffectSet(item));
    for (const effect of actual) {
      effects.push(effect);
      if (allowed && !allowed.some((candidate) => effectPermits(candidate, effect))) {
        violations.push({ parameter: parameter.name, effect: formatEffect(effect) });
      }
    }
  }
  const unique = effects.filter((effect, index, all) => all.findIndex((item) => formatEffect(item) === formatEffect(effect)) === index);
  return {
    effects: unique,
    evidence: violations.length > 0 || summary.evidence === "unknown" ? "unknown" : summary.evidence === "verified" ? "verified" : "inferred",
    violations,
  };
}

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function functionName(node: SupportedFunction): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText();
  return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : "<anonymous>";
}

function annotationOwner(node: SupportedFunction): ts.Node {
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
    && ts.isVariableDeclarationList(node.parent.parent) && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent : node;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrap(expression.expression) : expression;
}

function executionCardinality(call: ts.CallExpression, owner: SupportedFunction): CallbackCardinality {
  for (let current: ts.Node | undefined = call.parent; current && current !== owner.body; current = current.parent) {
    if (ts.isIterationStatement(current, false)) return "0..n";
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
      || ts.isTryStatement(current) || ts.isCatchClause(current)) return "0..1";
  }
  return "exactly-1";
}

function libraryDeclaration(program: ts.Program, symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
}

function builtinInvocation(
  program: ts.Program,
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): Omit<CallbackInvocationSummary, "callback" | "span"> & { argument: number } | undefined {
  if (ts.isIdentifier(call.expression)) {
    const name = call.expression.text;
    const symbol = resolvedSymbol(checker, call.expression);
    if (libraryDeclaration(program, symbol) && (name === "setTimeout" || name === "queueMicrotask")) return {
      api: name, argument: 0, cardinality: name === "queueMicrotask" ? "exactly-1" : "0..1",
      timing: "deferred", completion: "host-report-throw",
    };
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const name = call.expression.name.text;
  const symbol = resolvedSymbol(checker, call.expression.name);
  if (!libraryDeclaration(program, symbol)) return undefined;
  if (["map", "filter", "forEach", "some", "every"].includes(name)) return {
    api: `Array.prototype.${name}`, argument: 0, cardinality: "0..n", timing: "inline", completion: "propagate-throw",
  };
  if (["then", "catch", "finally"].includes(name)) return {
    api: `Promise.prototype.${name}`, argument: name === "then" ? 0 : 0, cardinality: "0..1",
    timing: "promise-reaction", completion: "convert-throw-to-rejection",
  };
  if (name === "addEventListener") return {
    api: "EventTarget.prototype.addEventListener", argument: 1, cardinality: "0..n",
    timing: "deferred", completion: "host-report-throw",
  };
  return undefined;
}

function directPromiseRejectType(program: ts.Program, checker: ts.TypeChecker, call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "reject" || !call.arguments[0]) return undefined;
  const symbol = resolvedSymbol(checker, call.expression.name);
  return libraryDeclaration(program, symbol) ? checker.typeToString(checker.getTypeAtLocation(call.arguments[0]!)) : undefined;
}

export function analyzeCallableSummaries(program: ts.Program): CallableSummaryAnalysis {
  const checker = program.getTypeChecker();
  const effectAnalysis = analyzeProgramEffects(program, { requireAnnotations: false });
  const effectsById = new Map(effectAnalysis.summaries.flatMap((summary) => summary.id ? [[summary.id, summary] as const] : []));
  const diagnostics: CallableSummaryDiagnostic[] = [];
  const declarations: SupportedFunction[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const collect = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) declarations.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);
  }

  const summaries = declarations.map((declaration): CallableSummary => {
    const source = declaration.getSourceFile();
    const name = functionName(declaration);
    const id = `${source.fileName}:${declaration.getStart(source)}`;
    const callbackSymbols = new Map<ts.Symbol, { index: number; name: string }>();
    declaration.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name) || checker.getTypeAtLocation(parameter).getCallSignatures().length === 0) return;
      const symbol = resolvedSymbol(checker, parameter.name);
      if (symbol) callbackSymbols.set(symbol, { index, name: parameter.name.text });
    });
    const aliasTargets = new Map<ts.Symbol, { index: number; name: string }>();
    const mutableAliases = new Set<string>();
    const unknownReasons = new Set<string>();
    const callbackCalls = new Map<number, ts.CallExpression[]>();
    const callbackInvocations: CallbackInvocationSummary[] = [];
    const rejects = new Set<string>();

    const bounds = new Map<string, string[]>();
    const owner = annotationOwner(declaration);
    const leading = source.text.slice(owner.getFullStart(), owner.getStart(source));
    for (const annotation of extractAnnotations(leading, "effect_parameter")) {
      const match = /^([A-Za-z_$][\w$]*)\s+extends\s+(.+)$/u.exec(annotation.trim());
      if (!match) {
        diagnostics.push({ fileName: source.fileName, functionName: name, message: `invalid effect_parameter: ${annotation}`, span: { start: owner.getStart(source), end: owner.getEnd() } });
        continue;
      }
      try { bounds.set(match[1]!, parseEffectSet(match[2]!).map(formatEffect)); }
      catch (cause) {
        diagnostics.push({ fileName: source.fileName, functionName: name, message: cause instanceof Error ? cause.message : String(cause), span: { start: owner.getStart(source), end: owner.getEnd() } });
      }
    }

    const resolveCallback = (expression: ts.Expression): { index: number; name: string } | undefined => {
      const target = unwrap(expression);
      if (!ts.isIdentifier(target)) return undefined;
      const symbol = resolvedSymbol(checker, target);
      return symbol ? callbackSymbols.get(symbol) ?? aliasTargets.get(symbol) : undefined;
    };

    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) {
        for (const symbol of callbackSymbols.keys()) {
          let captured = false;
          const scan = (child: ts.Node): void => {
            if (ts.isIdentifier(child) && resolvedSymbol(checker, child) === symbol) captured = true;
            if (!captured) ts.forEachChild(child, scan);
          };
          scan(node);
          if (captured) unknownReasons.add("callback-escape");
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const target = resolveCallback(node.initializer);
        if (target) {
          const symbol = resolvedSymbol(checker, node.name);
          const immutable = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
          if (immutable && symbol) aliasTargets.set(symbol, target);
          else { mutableAliases.add(node.name.text); unknownReasons.add("mutable-callable-alias"); }
        }
      }
      if (ts.isCallExpression(node)) {
        const callback = resolveCallback(node.expression);
        if (callback) {
          const calls = callbackCalls.get(callback.index) ?? [];
          calls.push(node);
          callbackCalls.set(callback.index, calls);
        } else {
          const expression = unwrap(node.expression);
          if (ts.isConditionalExpression(expression) && (resolveCallback(expression.whenTrue) || resolveCallback(expression.whenFalse))) {
            unknownReasons.add("dynamic-callback-dispatch");
          }
        }
        const builtin = builtinInvocation(program, checker, node);
        if (builtin) {
          const argument = node.arguments[builtin.argument];
          callbackInvocations.push({
            api: builtin.api, callback: argument?.getText(source) ?? "<missing>", cardinality: builtin.cardinality,
            timing: builtin.timing, completion: builtin.completion, span: { start: node.getStart(source), end: node.getEnd() },
          });
        }
        const rejection = directPromiseRejectType(program, checker, node);
        if (rejection) rejects.add(rejection);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)
        && mutableAliases.has(node.left.text)) unknownReasons.add("mutable-callable-alias");
      ts.forEachChild(node, visit);
    };
    visit(declaration.body!);

    const callbackParameters = [...callbackSymbols.values()].sort((left, right) => left.index - right.index).map((parameter): CallbackParameterSummary => {
      const calls = callbackCalls.get(parameter.index) ?? [];
      let cardinality: CallbackCardinality = "0";
      if (calls.length === 1) cardinality = executionCardinality(calls[0]!, declaration);
      else if (calls.length > 1) cardinality = "unknown";
      if (unknownReasons.has("callback-escape") || unknownReasons.has("dynamic-callback-dispatch")) cardinality = "unknown";
      return {
        ...parameter, cardinality, timing: "inline", completion: "propagate-throw",
        ...(bounds.has(parameter.name) ? { effectBound: bounds.get(parameter.name)! } : {}),
        spans: calls.map((call) => ({ start: call.getStart(source), end: call.getEnd() })),
      };
    });
    const effectSummary = effectsById.get(id);
    const effects = effectSummary?.effects ?? [];
    const legacyCallableOnlyUnknown = bounds.size > 0 && effectSummary?.evidence === "unknown"
      && (effectSummary.unknownReasons?.length ?? 0) > 0
      && effectSummary!.unknownReasons!.every((reason) => reason.code === "invalid-effect-parameter");
    for (const reason of effectSummary?.unknownReasons ?? []) {
      // The legacy effect analyzer currently restricts effect_parameter to
      // iterators. This summary owns the generalized callable validation.
      if (reason.code !== "invalid-effect-parameter" || bounds.size === 0) unknownReasons.add(reason.code);
    }
    return {
      schema: "uneffect-callable-summary/v1", id, name, fileName: source.fileName,
      span: { start: declaration.getStart(source), end: declaration.getEnd() },
      effects,
      throws: [...new Set(effects.flatMap((effect) => effect.kind === "throw" ? [effect.errorType] : []))],
      rejects: [...rejects], reads: [],
      writes: [...new Set(effects.flatMap((effect) => effect.kind === "mutate" ? [effect.region] : []))],
      callbackParameters, callbackInvocations,
      evidence: unknownReasons.size > 0 ? "unknown" : legacyCallableOnlyUnknown ? "inferred" : effectSummary?.evidence ?? "inferred",
      unknownReasons: [...unknownReasons].sort(),
    };
  });
  return { summaries, diagnostics };
}
