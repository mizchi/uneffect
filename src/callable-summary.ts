import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { effectPermits, formatEffect, parseEffectSet, type Effect } from "./capabilities.js";
import { analyzeProgramEffects, type EffectAnalysisResult, type EvidenceStatus } from "./effects.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";
import { interpretBuiltinCallSemantics, projectBuiltinCallbacks, projectedExpression, type BuiltinCallbackEvent } from "./builtin-semantic-interpreter.js";
import { classifyLexicalExecution } from "./lexical-execution.js";
import { builtinContractRegistry, builtinSymbolDisplayName, type BuiltinContractRegistry } from "./builtin-contracts.js";
import { callableAnnotationOwner } from "./callable-annotation-owner.js";

export type CallbackCardinality = "0" | "0..1" | "exactly-1" | "0..n" | "unknown";
export type CallbackTiming = "inline" | "deferred" | "promise-reaction" | "unknown";
export type CallbackCompletion = "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw" | "unknown";
export type CallbackSchedulingSource = "setTimeout" | "setInterval" | "requestAnimationFrame" | "EventTarget.prototype.addEventListener";

export interface CallbackParameterSummary {
  readonly index: number;
  readonly name: string;
  readonly path?: readonly (string | number)[];
  /** The producer only borrows a destructured container long enough to read this callback. */
  readonly containerAccess?: "borrow-readonly";
  readonly cardinality: CallbackCardinality;
  readonly timing: CallbackTiming;
  readonly completion: CallbackCompletion;
  readonly schedulingSource?: CallbackSchedulingSource;
  readonly schedulingDelay?: number;
  readonly effectBound?: readonly string[];
  readonly spans: readonly { start: number; end: number }[];
}

export interface CallbackInvocationSummary {
  readonly api: string;
  readonly callback: string;
  readonly cardinality: CallbackCardinality;
  readonly timing: CallbackTiming;
  readonly completion: CallbackCompletion;
  /** Host-neutral queue declared by a resolved catalog callback primitive. */
  readonly queue?: BuiltinCallbackEvent["queue"];
  readonly span: { start: number; end: number };
  readonly cancellation?: { readonly kind: "abort-signal"; readonly expression: string };
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
  readonly returnCallable?: {
    readonly effects: readonly Effect[];
    readonly throws: readonly string[];
    readonly rejects: readonly string[];
    readonly evidence: Exclude<EvidenceStatus, "unknown">;
  };
  readonly returnMembers?: readonly {
    readonly key: string;
    /** Source-stable declaration identity used to join other semantic domains. */
    readonly declarationId: string;
    readonly effects: readonly Effect[];
    readonly throws: readonly string[];
    readonly rejects: readonly string[];
    readonly parameters: readonly string[];
    readonly callbackParameters: readonly CallbackParameterSummary[];
    readonly returnsReceiver: boolean;
    readonly evidence: Exclude<EvidenceStatus, "unknown">;
  }[];
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

export function callbackArgumentKey(index: number, path: readonly (string | number)[]): string {
  return `${index}:${JSON.stringify(path)}`;
}

/** Instantiates the callback portion of a summary without executing user code. */
export function instantiateCallableSummary(
  summary: CallableSummary,
  argumentsByIndex: ReadonlyMap<number | string, readonly Effect[]>,
): CallableInstantiation {
  const effects = [...summary.effects];
  const violations: { parameter: string; effect: string }[] = [];
  for (const parameter of summary.callbackParameters) {
    const actual = parameter.path
      ? argumentsByIndex.get(callbackArgumentKey(parameter.index, parameter.path)) ?? []
      : argumentsByIndex.get(parameter.index) ?? [];
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

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration | ts.ConstructorDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function functionName(node: SupportedFunction): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText();
  if (ts.isConstructorDeclaration(node) && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
    return `${node.parent.name?.getText() ?? "<anonymous-class>"}.constructor`;
  }
  return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : "<anonymous>";
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrap(expression.expression) : expression;
}

function executionCardinality(call: ts.CallExpression, owner: SupportedFunction): CallbackCardinality {
  const multiplicity = classifyLexicalExecution(call, owner);
  return multiplicity === "repeated" ? "0..n" : multiplicity === "conditional" ? "0..1" : "exactly-1";
}

function multiplicityCardinality(node: ts.Node, owner: SupportedFunction): CallbackCardinality {
  const multiplicity = classifyLexicalExecution(node, owner);
  return multiplicity === "repeated" ? "0..n" : multiplicity === "conditional" ? "0..1" : "exactly-1";
}

function containsNode(root: ts.Node, node: ts.Node): boolean {
  return root.getSourceFile() === node.getSourceFile() && root.pos <= node.pos && root.end >= node.end;
}

/** Join repeated syntax sites only when one closed control node proves them mutually exclusive. */
function exclusiveControlCardinality(
  calls: readonly ts.CallExpression[],
  owner: SupportedFunction,
): CallbackCardinality | undefined {
  if (calls.length < 2) return undefined;
  for (let current: ts.Node | undefined = calls[0]!.parent; current && current !== owner; current = current.parent) {
    if (ts.isIfStatement(current) && current.elseStatement && calls.every((call) => containsNode(current, call))) {
      const thenCalls = calls.filter((call) => containsNode(current.thenStatement, call));
      const elseCalls = calls.filter((call) => containsNode(current.elseStatement!, call));
      if (thenCalls.length === 1 && elseCalls.length === 1
        && classifyLexicalExecution(thenCalls[0]!, current.thenStatement) === "exactly-once"
        && classifyLexicalExecution(elseCalls[0]!, current.elseStatement) === "exactly-once") {
        return multiplicityCardinality(current, owner);
      }
    }
    if (ts.isSwitchStatement(current) && calls.every((call) => containsNode(current, call))) {
      const clauses = current.caseBlock.clauses;
      if (!clauses.some(ts.isDefaultClause) || clauses.length !== calls.length) continue;
      const closed = clauses.every((clause, index) => {
        const branchCalls = calls.filter((call) => containsNode(clause, call));
        if (branchCalls.length !== 1 || classifyLexicalExecution(branchCalls[0]!, clause) !== "exactly-once") return false;
        if (index === clauses.length - 1) return true;
        const terminal = clause.statements.at(-1);
        return Boolean(terminal && ((ts.isBreakStatement(terminal) && !terminal.label)
          || ts.isReturnStatement(terminal) || ts.isThrowStatement(terminal)));
      });
      if (closed) return multiplicityCardinality(current, owner);
    }
  }
  return undefined;
}

function composeCardinality(outer: CallbackCardinality, inner: CallbackCardinality): CallbackCardinality {
  if (outer === "unknown" || inner === "unknown") return "unknown";
  if (outer === "0" || inner === "0") return "0";
  if (outer === "0..n" || inner === "0..n") return "0..n";
  if (outer === "0..1" || inner === "0..1") return "0..1";
  return "exactly-1";
}

function alternativeCardinality(values: readonly CallbackCardinality[]): CallbackCardinality {
  if (values.length === 0) return "0";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("0..n")) return "0..n";
  const unique = new Set(values);
  if (unique.size === 1) return values[0]!;
  return "0..1";
}

function libraryDeclaration(program: ts.Program, symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
}

function builtinInvocation(
  program: ts.Program,
  checker: ts.TypeChecker,
  adapter: FrontendSymbolAdapter,
  call: ts.CallExpression,
): Omit<CallbackInvocationSummary, "callback" | "span"> & { argument: number } | undefined {
  if (ts.isIdentifier(call.expression)) {
    const name = call.expression.text;
    const symbol = resolvedSymbol(checker, call.expression);
    if (libraryDeclaration(program, symbol) && (name === "setTimeout" || name === "queueMicrotask")) return {
      api: name, argument: 0, cardinality: name === "queueMicrotask" ? "exactly-1" : "0..1",
      timing: "deferred", completion: "host-report-throw",
    };
    const resolved = adapter.resolveCall(call);
    const event = projectBuiltinCallbacks(resolved, call, checker)
      .find((candidate) => candidate.target.status === "resolved");
    if (resolved && event?.target.status === "resolved") {
      const callbackExpression = event.target.expression;
      const argument = call.arguments.findIndex((candidate) => candidate === callbackExpression);
      if (argument >= 0) {
        const microtask = event.timing === "deferred" && event.queue === "microtask";
        return {
          api: builtinSymbolDisplayName(resolved.symbol),
          argument,
          cardinality: event.cardinality === "1" ? "exactly-1"
            : event.cardinality === "1..n" ? "0..n" : event.cardinality,
          timing: event.timing === "sync" ? "inline" : microtask ? "promise-reaction" : "deferred",
          completion: event.completion ?? (event.timing === "sync" ? "propagate-throw"
            : microtask ? "convert-throw-to-rejection" : "host-report-throw"),
          queue: event.queue,
        };
      }
    }
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const name = call.expression.name.text;
  if (name === "addEventListener") {
    const resolved = adapter.resolveCall(call);
    const event = projectBuiltinCallbacks(resolved, call, checker).find((candidate) => candidate.target.status === "resolved");
    if (!event || event.target.status !== "resolved") return undefined;
    const callbackExpression = event.target.expression;
    const argument = call.arguments.findIndex((candidate) => candidate === callbackExpression);
    return argument < 0 ? undefined : {
      api: "EventTarget.prototype.addEventListener", argument,
      cardinality: event.cardinality === "1" ? "exactly-1" : event.cardinality === "1..n" ? "0..n" : event.cardinality,
      timing: "deferred", completion: "host-report-throw",
      ...(event.abortSignal && projectedExpression(event.abortSignal)
        ? { cancellation: { kind: "abort-signal" as const, expression: projectedExpression(event.abortSignal)!.getText(call.getSourceFile()) } }
        : {}),
    };
  }
  const symbol = resolvedSymbol(checker, call.expression.name);
  const standardLibraryMember = libraryDeclaration(program, symbol);
  if (standardLibraryMember && ["map", "filter", "forEach", "some", "every"].includes(name)) return {
    api: `Array.prototype.${name}`, argument: 0, cardinality: "0..n", timing: "inline", completion: "propagate-throw",
  };
  if (standardLibraryMember && ["then", "catch", "finally"].includes(name)) return {
    api: `Promise.prototype.${name}`, argument: name === "then" ? 0 : 0, cardinality: "0..1",
    timing: "promise-reaction", completion: "convert-throw-to-rejection",
  };
  const resolved = adapter.resolveCall(call);
  const event = projectBuiltinCallbacks(resolved, call, checker)
    .find((candidate) => candidate.target.status === "resolved");
  if (resolved && event?.target.status === "resolved") {
    const callbackExpression = event.target.expression;
    const argument = call.arguments.findIndex((candidate) => candidate === callbackExpression);
    if (argument >= 0) {
      const microtask = event.timing === "deferred" && event.queue === "microtask";
      return {
        api: builtinSymbolDisplayName(resolved.symbol),
        argument,
        cardinality: event.cardinality === "1" ? "exactly-1"
          : event.cardinality === "1..n" ? "0..n" : event.cardinality,
        timing: event.timing === "sync" ? "inline" : microtask ? "promise-reaction" : "deferred",
        completion: event.completion ?? (event.timing === "sync" ? "propagate-throw"
          : microtask ? "convert-throw-to-rejection" : "host-report-throw"),
        queue: event.queue,
      };
    }
  }
  return undefined;
}

function directPromiseRejectType(program: ts.Program, checker: ts.TypeChecker, call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "reject" || !call.arguments[0]) return undefined;
  const symbol = resolvedSymbol(checker, call.expression.name);
  return libraryDeclaration(program, symbol) ? checker.typeToString(checker.getTypeAtLocation(call.arguments[0]!)) : undefined;
}

function callRejectionEscapes(call: ts.CallExpression, boundary: SupportedFunction): boolean {
  const explicitlyThrows = (block: ts.Block): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || node !== block && ts.isFunctionLike(node)) return;
      if (ts.isThrowStatement(node)) { found = true; return; }
      ts.forEachChild(node, visit);
    };
    visit(block);
    return found;
  };
  let current: ts.Node = call;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
    current = current.parent;
    for (let ancestor = current.parent; ancestor && ancestor !== boundary; ancestor = ancestor.parent) {
      if (ts.isTryStatement(ancestor) && ancestor.catchClause
        && current.getStart() >= ancestor.tryBlock.getStart()
        && current.getEnd() <= ancestor.tryBlock.getEnd()) return explicitlyThrows(ancestor.catchClause.block);
      current = ancestor;
    }
    return true;
  }
  return ts.isReturnStatement(current.parent) && current.parent.expression === current
    || ts.isArrowFunction(boundary) && boundary.body === current;
}

export function analyzeCallableSummaries(
  program: ts.Program,
  effectAnalysis: EffectAnalysisResult = analyzeProgramEffects(program, { requireAnnotations: false }),
  builtinRegistry: BuiltinContractRegistry = builtinContractRegistry,
): CallableSummaryAnalysis {
  const checker = program.getTypeChecker();
  const adapter = new TypeScriptFrontendAdapter(program, builtinRegistry);
  const effectsById = new Map(effectAnalysis.summaries.flatMap((summary) => summary.id ? [[summary.id, summary] as const] : []));
  const diagnostics: CallableSummaryDiagnostic[] = [];
  const declarations: SupportedFunction[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const collect = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) declarations.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  type LocalCallbackForwarding = { key: string; call: ts.CallExpression; targetId: string; targetIndex: number };
  const localCallbackForwardings = new Map<string, LocalCallbackForwarding[]>();

  const summaries = declarations.map((declaration): CallableSummary => {
    const source = declaration.getSourceFile();
    const name = functionName(declaration);
    const id = `${source.fileName}:${declaration.getStart(source)}`;
    type CallbackBinding = { index: number; name: string; path?: readonly (string | number)[]; key: string; containerAccess?: "borrow-readonly" };
    const callbackSymbols = new Map<ts.Symbol, CallbackBinding>();
    let unsupportedCallbackBinding = false;
    declaration.parameters.forEach((parameter, index) => {
      const collect = (name: ts.BindingName, path: readonly (string | number)[]): void => {
        if (ts.isIdentifier(name)) {
          if (checker.getNonNullableType(checker.getTypeAtLocation(name)).getCallSignatures().length === 0) return;
          const symbol = resolvedSymbol(checker, name);
          if (symbol) callbackSymbols.set(symbol, {
            index, name: name.text, ...(path.length ? { path, containerAccess: "borrow-readonly" as const } : {}), key: callbackArgumentKey(index, path),
          });
          return;
        }
        if (ts.isObjectBindingPattern(name)) {
          for (const element of name.elements) {
            if (element.dotDotDotToken || element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
              unsupportedCallbackBinding = true;
              continue;
            }
            const key = element.propertyName
              ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName)
                ? element.propertyName.text : undefined
              : ts.isIdentifier(element.name) ? element.name.text : undefined;
            if (key !== undefined) collect(element.name, [...path, key]);
          }
          return;
        }
        name.elements.forEach((element, elementIndex) => {
          if (!element || ts.isOmittedExpression(element)) return;
          if (element.dotDotDotToken) { unsupportedCallbackBinding = true; return; }
          collect(element.name, [...path, elementIndex]);
        });
      };
      collect(parameter.name, []);
    });
    const aliasTargets = new Map<ts.Symbol, CallbackBinding>();
    const mutableAliases = new Set<string>();
    const unknownReasons = new Set<string>();
    if (unsupportedCallbackBinding) unknownReasons.add("unsupported-callback-binding");
    const callbackCalls = new Map<string, ts.CallExpression[]>();
    const callbackForwardings = new Map<string, Array<{
      call: ts.CallExpression;
      invocation: Omit<CallbackInvocationSummary, "callback" | "span"> & { argument: number };
    }>>();
    const callbackInvocations: CallbackInvocationSummary[] = [];
    const consumedCallbackReferences = new Set<ts.Node>();
    const rejects = new Set<string>();

    const bounds = new Map<string, string[]>();
    const owner = callableAnnotationOwner(declaration);
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

    const resolveCallback = (expression: ts.Expression): CallbackBinding | undefined => {
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
          if (immutable && symbol) {
            aliasTargets.set(symbol, target);
            const initializer = unwrap(node.initializer);
            if (ts.isIdentifier(initializer)) consumedCallbackReferences.add(initializer);
          }
          else { mutableAliases.add(node.name.text); unknownReasons.add("mutable-callable-alias"); }
        }
      }
      if (ts.isCallExpression(node)) {
        const callback = resolveCallback(node.expression);
        if (callback) {
          const expression = unwrap(node.expression);
          if (ts.isIdentifier(expression)) consumedCallbackReferences.add(expression);
          const calls = callbackCalls.get(callback.key) ?? [];
          calls.push(node);
          callbackCalls.set(callback.key, calls);
        } else {
          const expression = unwrap(node.expression);
          if (ts.isConditionalExpression(expression) && (resolveCallback(expression.whenTrue) || resolveCallback(expression.whenFalse))) {
            unknownReasons.add("dynamic-callback-dispatch");
          }
        }
        const builtin = builtinInvocation(program, checker, adapter, node);
        if (builtin) {
          const argument = node.arguments[builtin.argument];
          callbackInvocations.push({
            api: builtin.api, callback: argument?.getText(source) ?? "<missing>", cardinality: builtin.cardinality,
        timing: builtin.timing, completion: builtin.completion,
            ...(builtin.queue ? { queue: builtin.queue } : {}),
            ...(builtin.cancellation ? { cancellation: builtin.cancellation } : {}),
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          if (argument) {
            const forwarded = resolveCallback(argument);
            if (forwarded) {
              const selected = unwrap(argument);
              if (ts.isIdentifier(selected)) consumedCallbackReferences.add(selected);
              callbackForwardings.set(forwarded.key, [
                ...(callbackForwardings.get(forwarded.key) ?? []), { call: node, invocation: builtin },
              ]);
            }
          }
        }
        if (!builtin) {
          const targetSymbol = resolvedSymbol(checker, ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
          const target = targetSymbol?.valueDeclaration ?? targetSymbol?.declarations?.[0];
          if (target && (ts.isFunctionDeclaration(target) || ts.isMethodDeclaration(target)
            || ts.isArrowFunction(target) || ts.isFunctionExpression(target)) && target.body) {
            node.arguments.forEach((argument, targetIndex) => {
              const forwarded = resolveCallback(argument);
              if (!forwarded) return;
              const parameter = target.parameters[targetIndex];
              if (!parameter || checker.getNonNullableType(checker.getTypeAtLocation(parameter)).getCallSignatures().length === 0) return;
              const selected = unwrap(argument);
              if (ts.isIdentifier(selected)) consumedCallbackReferences.add(selected);
              localCallbackForwardings.set(id, [
                ...(localCallbackForwardings.get(id) ?? []),
                { key: forwarded.key, call: node, targetId: `${target.getSourceFile().fileName}:${target.getStart(target.getSourceFile())}`, targetIndex },
              ]);
            });
          }
        }
        const rejection = directPromiseRejectType(program, checker, node);
        if (rejection) rejects.add(rejection);
        const resolvedBuiltin = adapter.resolveCall(node);
        const catalogRejections = resolvedBuiltin?.semantics
          ? interpretBuiltinCallSemantics(resolvedBuiltin.semantics, node, {
              symbol: resolvedBuiltin.symbol, span: resolvedBuiltin.span,
            }).flatMap((event) => event.kind === "reject" ? [event.error] : [])
          : [];
        if (catalogRejections.length && callRejectionEscapes(node, declaration)) {
          for (const error of catalogRejections) rejects.add(error);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)
        && mutableAliases.has(node.left.text)) unknownReasons.add("mutable-callable-alias");
      ts.forEachChild(node, visit);
    };
    for (const parameter of declaration.parameters) {
      visit(parameter.name);
      if (parameter.initializer) visit(parameter.initializer);
    }
    if (ts.isConstructorDeclaration(declaration)) {
      for (const member of declaration.parent.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer
          && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          visit(member.initializer);
        }
      }
    }
    visit(declaration.body!);

    const callbackBindingSymbols = new Set([...callbackSymbols.keys(), ...aliasTargets.keys()]);
    const isDeclarationName = (node: ts.Identifier, symbol: ts.Symbol): boolean => symbol.declarations?.some((candidate) =>
      "name" in candidate && candidate.name === node) ?? false;
    const screenCallbackReferences = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(checker, node);
        if (symbol && callbackBindingSymbols.has(symbol) && !isDeclarationName(node, symbol)
          && !consumedCallbackReferences.has(node)) unknownReasons.add("callback-escape");
      }
      ts.forEachChild(node, screenCallbackReferences);
    };
    screenCallbackReferences(declaration);

    const callbackParameters = [...callbackSymbols.values()].sort((left, right) => left.index - right.index || left.key.localeCompare(right.key)).map((parameter): CallbackParameterSummary => {
      const calls = callbackCalls.get(parameter.key) ?? [];
      const forwardings = callbackForwardings.get(parameter.key) ?? [];
      let cardinality: CallbackCardinality = "0";
      let timing: CallbackTiming = "inline", completion: CallbackCompletion = "propagate-throw";
      const sites = [
        ...calls.map((call) => ({ call, cardinality: "exactly-1" as const, timing: "inline" as const, completion: "propagate-throw" as const, schedulingSource: undefined })),
        ...forwardings.map(({ call, invocation }) => ({
          call, cardinality: invocation.cardinality, timing: invocation.timing, completion: invocation.completion,
          schedulingSource: (["setTimeout", "setInterval", "requestAnimationFrame", "EventTarget.prototype.addEventListener"] as string[]).includes(invocation.api)
            ? invocation.api as CallbackSchedulingSource : undefined,
        })),
      ];
      let schedulingSource: CallbackSchedulingSource | undefined;
      let schedulingDelay: number | undefined;
      const staticDelay = (site: typeof sites[number]): number | undefined => {
        if (site.schedulingSource !== "setTimeout" && site.schedulingSource !== "setInterval") return undefined;
        const argument = site.call.arguments[1];
        if (!argument) return 0;
        const value = unwrap(argument);
        return ts.isNumericLiteral(value) && Number.isFinite(Number(value.text)) && Number(value.text) >= 0
          ? Number(value.text) : undefined;
      };
      if (sites.length === 1) {
        const site = sites[0]!;
        cardinality = composeCardinality(executionCardinality(site.call, declaration), site.cardinality);
        timing = site.timing;
        completion = site.completion;
        schedulingSource = site.schedulingSource;
        schedulingDelay = staticDelay(site);
      } else if (sites.length > 1) {
        const outer = exclusiveControlCardinality(sites.map(({ call }) => call), declaration);
        const timings = new Set(sites.map((site) => site.timing));
        const completions = new Set(sites.map((site) => site.completion));
        if (!outer || timings.size !== 1 || completions.size !== 1) {
          cardinality = "unknown"; timing = "unknown"; completion = "unknown";
        } else {
          cardinality = composeCardinality(outer, alternativeCardinality(sites.map((site) => site.cardinality)));
          timing = sites[0]!.timing;
          completion = sites[0]!.completion;
          const schedulingSources = new Set(sites.map((site) => site.schedulingSource));
          if (schedulingSources.size === 1) schedulingSource = sites[0]!.schedulingSource;
          const delays = new Set(sites.map(staticDelay));
          if (delays.size === 1) schedulingDelay = staticDelay(sites[0]!);
        }
      }
      if (unknownReasons.has("callback-escape") || unknownReasons.has("dynamic-callback-dispatch")) cardinality = "unknown";
      return {
        index: parameter.index, name: parameter.name, ...(parameter.path ? { path: parameter.path } : {}), cardinality, timing, completion,
        ...(schedulingSource ? { schedulingSource } : {}),
        ...(schedulingDelay !== undefined ? { schedulingDelay } : {}),
        ...(parameter.containerAccess ? { containerAccess: parameter.containerAccess } : {}),
        ...(bounds.has(parameter.name) ? { effectBound: bounds.get(parameter.name)! } : {}),
        spans: [...calls, ...forwardings.map(({ call }) => call)].map((call) => ({ start: call.getStart(source), end: call.getEnd() })),
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
  let composedSummaries = summaries;
  for (let pass = 0; pass < declarations.length; pass++) {
    const bySummaryId = new Map(composedSummaries.map((summary) => [summary.id, summary] as const));
    let changed = false;
    composedSummaries = composedSummaries.map((summary, index) => {
      const forwards = localCallbackForwardings.get(summary.id) ?? [];
      if (forwards.length === 0) return summary;
      let callbackParameters = [...summary.callbackParameters];
      let promoted = false;
      for (const parameter of callbackParameters) {
        const key = callbackArgumentKey(parameter.index, parameter.path ?? []);
        const candidates = forwards.filter((forward) => forward.key === key);
        if (candidates.length !== 1) continue;
        const forwarding = candidates[0]!;
        const targetSummary = bySummaryId.get(forwarding.targetId);
        const target = targetSummary?.callbackParameters.find((candidate) =>
          candidate.index === forwarding.targetIndex && !candidate.path?.length);
        if (!target || targetSummary?.evidence === "unknown" || target.cardinality === "unknown"
          || target.timing === "unknown" || target.completion === "unknown") continue;
        const cardinality = composeCardinality(executionCardinality(forwarding.call, declarations[index]!), target.cardinality);
        callbackParameters = callbackParameters.map((candidate) => candidate === parameter ? {
          ...candidate, cardinality, timing: target.timing, completion: target.completion,
          ...(target.schedulingSource ? { schedulingSource: target.schedulingSource } : {}),
          ...(target.schedulingDelay !== undefined ? { schedulingDelay: target.schedulingDelay } : {}),
          spans: [{ start: forwarding.call.getStart(), end: forwarding.call.getEnd() }],
        } : candidate);
        promoted = true;
      }
      if (!promoted) return summary;
      const unknownReasons = summary.unknownReasons.filter((reason) => reason !== "unknown-callback-timing" && reason !== "callback-escape");
      const next = { ...summary, callbackParameters, unknownReasons,
        evidence: unknownReasons.length === 0 ? "inferred" as const : "unknown" as const };
      changed ||= JSON.stringify(next) !== JSON.stringify(summary);
      return next;
    });
    if (!changed) break;
  }
  composedSummaries = composedSummaries.map((summary) => {
    const forwards = localCallbackForwardings.get(summary.id) ?? [];
    if (forwards.length === 0) return summary;
    let unresolved = false;
    const callbackParameters = summary.callbackParameters.map((parameter) => {
      const candidates = forwards.filter((forward) => forward.key === callbackArgumentKey(parameter.index, parameter.path ?? []));
      if (candidates.length === 0 || candidates.some((forward) => parameter.spans.some((span) => span.start === forward.call.getStart()))) return parameter;
      unresolved = true;
      return { ...parameter, cardinality: "unknown" as const, timing: "unknown" as const, completion: "unknown" as const };
    });
    return unresolved ? {
      ...summary, callbackParameters, evidence: "unknown",
      unknownReasons: [...new Set([...summary.unknownReasons, "unresolved-callback-forwarding"])].sort(),
    } : summary;
  });
  const byId = new Map(composedSummaries.map((summary) => [summary.id, summary] as const));
  const withReturnedCallables = composedSummaries.map((summary, index): CallableSummary => {
    const declaration = declarations[index]!;
    const returns: ts.ReturnStatement[] = [];
    const collectReturns = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node);
      ts.forEachChild(node, collectReturns);
    };
    collectReturns(declaration.body!);
    if (returns.length !== 1 || !returns[0]!.expression) return summary;
    const expression = unwrap(returns[0]!.expression!);
    const resolveReturned = (value: ts.Expression): SupportedFunction | undefined => {
      const expression = unwrap(value);
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
      if (!ts.isIdentifier(expression)) return undefined;
      const symbol = resolvedSymbol(checker, expression);
      const declarationValue = symbol?.valueDeclaration;
      if (declarationValue && ts.isFunctionDeclaration(declarationValue)) return declarationValue;
      else if (declarationValue && ts.isVariableDeclaration(declarationValue) && declarationValue.initializer
        && ts.isVariableDeclarationList(declarationValue.parent) && (declarationValue.parent.flags & ts.NodeFlags.Const) !== 0) {
        const initializer = unwrap(declarationValue.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
      }
      return undefined;
    };
    if (ts.isObjectLiteralExpression(expression)) {
      const keys: string[] = [];
      const targets: Array<{ key: string; target: SupportedFunction }> = [];
      for (const member of expression.properties) {
        if ((ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member)) && !ts.isComputedPropertyName(member.name)) {
          const key = member.name.text;
          keys.push(key);
          const target = ts.isMethodDeclaration(member) ? member : resolveReturned(member.initializer);
          if (target) targets.push({ key, target });
          continue;
        }
        return summary;
      }
      if (new Set(keys).size !== keys.length || targets.length === 0) return summary;
      const members = targets.flatMap(({ key, target }) => {
        const returned = byId.get(`${target.getSourceFile().fileName}:${target.getStart(target.getSourceFile())}`);
        let returnsReceiver = false;
        if (ts.isMethodDeclaration(target) && target.body) {
          const last = target.body.statements[target.body.statements.length - 1];
          const methodReturns: ts.ReturnStatement[] = [];
          const visitReturn = (node: ts.Node): void => {
            if (node !== target.body && ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node)) methodReturns.push(node);
            ts.forEachChild(node, visitReturn);
          };
          visitReturn(target.body);
          returnsReceiver = Boolean(methodReturns.length === 1 && last === methodReturns[0]
            && methodReturns[0]!.expression?.kind === ts.SyntaxKind.ThisKeyword);
        }
        return !returned || returned.evidence === "unknown" ? [] : [{
          key, declarationId: returned.id, effects: returned.effects, throws: returned.throws, rejects: returned.rejects,
          parameters: target.parameters.map((parameter, index) =>
            ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`),
          callbackParameters: returned.callbackParameters,
          returnsReceiver,
          evidence: returned.evidence as Exclude<EvidenceStatus, "unknown">,
        }];
      });
      return members.length === targets.length ? { ...summary, returnMembers: members } : summary;
    }
    const target = resolveReturned(expression);
    if (!target) return summary;
    const returned = byId.get(`${target.getSourceFile().fileName}:${target.getStart(target.getSourceFile())}`);
    if (!returned || returned.evidence === "unknown") return summary;
    return { ...summary, returnCallable: {
      effects: returned.effects, throws: returned.throws, rejects: returned.rejects,
      evidence: returned.evidence as Exclude<EvidenceStatus, "unknown">,
    } };
  });
  return { summaries: withReturnedCallables, diagnostics };
}
