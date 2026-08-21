import ts from "typescript";
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
  queue: "timer" | "microtask" | "animation-frame" | "scheduler-task";
  enqueuedBy?: number;
  handle?: string;
  handleKind?: "number" | "object" | "unknown";
  kind?: "abort-timeout" | "scheduler-post-task" | "scheduler-yield";
  abortReason?: "TimeoutError";
  priority?: "user-blocking" | "user-visible" | "background";
  initiallyCancelled?: boolean;
  abortTimer?: number;
  abortComposition?: number;
  span: { start: number; end: number };
}

export interface PromiseCombinatorPattern {
  owner: string;
  combinator: PromiseCombinator;
  branches: string[];
  branchKinds: ("value" | "thenable" | "unknown")[];
  staticIterable: boolean;
  iteratorFailure?: "acquire" | "step";
  aggregateErrorOrder?: number[];
  awaited: boolean;
  catchesRejection: boolean;
  span: { start: number; end: number };
}

export interface TimerCancellation {
  owner: string;
  handle: string;
  timer?: number;
  definite: boolean;
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
  const expandStaticArray = (expression: ts.Expression): (ts.Expression | ts.OmittedExpression)[] | undefined => {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!ts.isArrayLiteralExpression(expression)) return undefined;
    const expanded: (ts.Expression | ts.OmittedExpression)[] = [];
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) expanded.push(element);
      else {
        const nested = expandStaticArray(element.expression);
        if (!nested) return undefined;
        expanded.push(...nested);
      }
    }
    return expanded;
  };
  const localIterable = (expression: ts.Expression | undefined): { branches: ts.Expression[]; failure?: "acquire" | "step" } | undefined => {
    if (!expression) return undefined;
    let declaration: ts.Declaration | undefined;
    if (ts.isIdentifier(expression)) declaration = resolvedSymbol(expression)?.valueDeclaration;
    else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) declaration = resolvedSymbol(expression.expression)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
      const iterator = declaration.initializer.properties.find((property) => {
        if (!property.name || !ts.isComputedPropertyName(property.name) || !ts.isPropertyAccessExpression(property.name.expression)) return false;
        const access = property.name.expression;
        return access.expression.getText(source) === "Symbol" && access.name.text === "iterator"
          && (resolvedSymbol(access.name)?.declarations?.some((item) => item.getSourceFile().isDeclarationFile) ?? false);
      });
      if (iterator && ts.isMethodDeclaration(iterator) && iterator.body?.statements.some(ts.isThrowStatement)) return { branches: [], failure: "acquire" };
    }
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.asteriskToken && declaration.body) {
      const branches: ts.Expression[] = [];
      let failure: "step" | undefined;
      for (const statement of declaration.body.statements) {
        if (ts.isExpressionStatement(statement) && ts.isYieldExpression(statement.expression)
          && statement.expression.expression && !statement.expression.asteriskToken) branches.push(statement.expression.expression);
        else if (ts.isThrowStatement(statement)) failure = "step";
        else if (!ts.isReturnStatement(statement) && !ts.isEmptyStatement(statement)) return undefined;
      }
      return { branches, failure };
    }
    return undefined;
  };
  const resolveCallback = (callback: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined => {
    if (!callback) return undefined;
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) return callback;
    if (!ts.isIdentifier(callback)) return undefined;
    const original = checker.getSymbolAtLocation(callback);
    const symbol = original && (original.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(original) : original;
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    }
    return undefined;
  };
  const scheduledCallbacks = new Set<ts.FunctionLikeDeclaration>();
  const collectScheduledCallbacks = (node: ts.Node, owner?: ts.FunctionLikeDeclaration): void => {
    const currentOwner = ts.isFunctionLike(node) && "body" in node && node.body ? node as ts.FunctionLikeDeclaration : owner;
    if (ts.isCallExpression(node)) {
      const operation = adapter.resolveCall(node)?.operation;
      if (operation?.kind === "timer" || operation?.kind === "scheduler-post-task") {
        const callback = resolveCallback(node.arguments[operation.callbackArgument]);
        if (callback && callback !== currentOwner) scheduledCallbacks.add(callback);
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
    const abortSignalTargets = new Map<string, { timer?: number; composition?: number; alreadyAborted?: boolean; reason?: string }>();
    const inlineAbortTimeoutTargets = new Map<ts.CallExpression, number>();
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
    const abortTarget = (expression: ts.Expression): { timer?: number; composition?: number; alreadyAborted?: boolean; reason?: string } | undefined => {
      if (ts.isIdentifier(expression)) return abortSignalTargets.get(expression.text);
      if (!ts.isCallExpression(expression)) return undefined;
      const operation = adapter.resolveCall(expression)?.operation;
      if (operation?.kind === "abort-static") return {
        alreadyAborted: true,
        reason: expression.arguments[operation.reasonArgument]?.getText(source) ?? "AbortError",
      };
      if (operation?.kind !== "abort-timeout") return undefined;
      const existing = inlineAbortTimeoutTargets.get(expression);
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
      inlineAbortTimeoutTargets.set(expression, timer);
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
      const callback = resolveCallback(callbackExpression);
      if (!callback || !callback.body || visited.has(callback)) return;
      visited.add(callback);
      const scan = (node: ts.Node): void => {
        if (node !== callback && ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node)) {
          const operation = adapter.resolveCall(node)?.operation;
          if (operation?.kind === "timer" && operation.queue === "microtask") {
            const child = timers.length;
            const callbackNode = node.arguments[operation.callbackArgument];
            const childSource = node.getSourceFile();
            timers.push({ owner: ownerName, callback: callbackNode?.getText(childSource) ?? "<unknown>", delay: 0, recursive: false, repeats: false, queue: "microtask", enqueuedBy: parent, span: { start: node.getStart(childSource), end: node.getEnd() } });
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
              span: { start: node.getStart(childSource), end: node.getEnd() },
            });
            return;
          }
        }
        ts.forEachChild(node, scan);
      };
      scan(callback.body);
      visited.delete(callback);
    };
    const visit = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        handleAliases.set(node.name.text, resolveHandle(node.initializer.text));
        const target = handleTargets.get(node.initializer.text);
        if (target !== undefined) handleTargets.set(node.name.text, target);
        const signal = abortSignalTargets.get(node.initializer.text);
        if (signal) abortSignalTargets.set(node.name.text, signal);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        handleAliases.delete(node.left.text);
        handleTargets.delete(node.left.text);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) recordEscapesInValue(node.right, "property", node);
      if (ts.isReturnStatement(node) && node.expression) recordEscapesInValue(node.expression, "return", node);
      if (ts.isCallExpression(node)) {
        const operation = adapter.resolveCall(node)?.operation;
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
            delay: delayNode && ts.isNumericLiteral(delayNode) ? Number(delayNode.text) : operation.delayArgument === undefined ? 0 : undefined,
            recursive: callback === ownerName,
            repeats: operation.repeats,
            queue: operation.queue,
            handle: declaration,
            handleKind: timerHandleKind(node),
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          if (declaration) handleTargets.set(declaration, timerIndex);
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
          if (declaration) abortSignalTargets.set(declaration, { timer, reason: "TimeoutError" });
        } else if (operation?.kind === "abort-static") {
          const declaration = assignedBinding(node);
          if (declaration) abortSignalTargets.set(declaration, { alreadyAborted: true, reason: node.arguments[operation.reasonArgument]?.getText(source) ?? "AbortError" });
        } else if (operation?.kind === "abort-any") {
          const declaration = assignedBinding(node);
          const argument = node.arguments[operation.signalsArgument];
          const elements = argument ? expandStaticArray(argument) : undefined;
          if (elements && elements.every((element): element is ts.Expression => !ts.isOmittedExpression(element))) {
            const targets = elements.map(abortTarget);
            const composition = abortCompositions.length;
            const initiallyAbortedSource = targets.findIndex((target) => target?.alreadyAborted);
            abortCompositions.push({
              owner: ownerName,
              handle: declaration,
              sources: elements.map((element) => element.getText(source)),
              sourceTimers: targets.map((target) => target?.timer),
              sourceCompositions: targets.map((target) => target?.composition),
              sourceReasons: targets.map((target) => target?.reason),
              initiallyAbortedSource: initiallyAbortedSource < 0 ? undefined : initiallyAbortedSource,
              span: { start: node.getStart(source), end: node.getEnd() },
            });
            if (declaration) abortSignalTargets.set(declaration, {
              composition,
              alreadyAborted: initiallyAbortedSource >= 0,
              reason: initiallyAbortedSource < 0 ? undefined : targets[initiallyAbortedSource]?.reason,
            });
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
          const signalSymbol = signalNode && ts.isIdentifier(signalNode) ? resolvedSymbol(signalNode) : undefined;
          const signalType = signalNode ? signalSymbol?.valueDeclaration
            ? checker.getTypeOfSymbolAtLocation(signalSymbol, signalSymbol.valueDeclaration)
            : checker.getTypeAtLocation(signalNode) : undefined;
          const signalSetsPriority = Boolean(!priorityNode && signalType && checker.getPropertyOfType(signalType, "priority"));
          const priority = priorityNode && ts.isStringLiteralLike(priorityNode)
            && (priorityNode.text === "user-blocking" || priorityNode.text === "user-visible" || priorityNode.text === "background") ? priorityNode.text : priorityNode || signalSetsPriority ? undefined : "user-visible";
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
            initiallyCancelled: signal?.alreadyAborted,
            abortTimer: signal?.timer,
            abortComposition: signal?.composition,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
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
          cancellations.push({ owner: ownerName, handle, timer: handleNode && ts.isIdentifier(handleNode) ? handleTargets.get(handleNode.text) : undefined, definite, span: { start: node.getStart(source), end: node.getEnd() } });
        } else if (operation?.kind === "promise-combinator") {
          const iterable = node.arguments[operation.iterableArgument];
          const array = iterable ? expandStaticArray(iterable) : undefined;
          const local = array ? undefined : localIterable(iterable);
          const staticIterable = Boolean(array || local);
          const branchNodes = local?.branches;
          const branches = array ? array.map((item) => ts.isOmittedExpression(item) ? "<hole>" : item.getText(source)) : branchNodes?.map((item) => item.getText(source)) ?? [];
          const branchKinds = array ? array.map(branchKind) : branchNodes?.map(branchKind) ?? [];
          let current: ts.Node = node;
          while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
          const awaited = ts.isAwaitExpression(current.parent);
          if (awaited) current = current.parent;
          let catchesRejection = false;
          while (current.parent && current.parent !== owner.body) {
            if (ts.isTryStatement(current.parent) && current.parent.tryBlock === current && current.parent.catchClause) catchesRejection = true;
            current = current.parent;
          }
          combinators.push({ owner: ownerName, combinator: operation.combinator, branches, branchKinds, staticIterable, iteratorFailure: local?.failure, aggregateErrorOrder: operation.combinator === "any" ? branches.map((_, index) => index) : undefined, awaited, catchesRejection, span: { start: node.getStart(source), end: node.getEnd() } });
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
      const scheduledCallback = Boolean(parentCall && (operation?.kind === "timer" || operation?.kind === "scheduler-post-task") && parentCall.arguments[operation.callbackArgument] === node);
      if (!scheduledCallback && !scheduledCallbacks.has(node as ts.FunctionLikeDeclaration)) visitFunction(node as ts.FunctionLikeDeclaration);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const cancellation of cancellations) {
    if (cancellation.timer !== undefined) continue;
    const timer = timers.findIndex((item) => item.owner === cancellation.owner && item.handle === cancellation.handle);
    if (timer >= 0) cancellation.timer = timer;
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
    lines.push(`  var join_${index}_result: int`, `  var join_${index}_iterator_failed: bool`, `  var join_${index}_rejection_escapes: bool`);
    if (join.aggregateErrorOrder) {
      lines.push(`  val join_${index}_aggregate_error_count = ${join.aggregateErrorOrder.length}`);
      join.aggregateErrorOrder.forEach((slot, rank) => lines.push(`  val join_${index}_aggregate_error_slot_${rank} = ${slot}`));
    }
  });
  lines.push("", "  action init = all {", "    clock' = 0,");
  model.timers.forEach((timer, index) => {
    const cancelled = timer.initiallyCancelled || model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    timer_${index}_scheduled' = ${!cancelled},`, `    timer_${index}_cancelled' = ${cancelled},`, `    timer_${index}_due' = ${timer.delay},`, `    timer_${index}_early' = false,`, `    timer_${index}_after_cancel' = false,`, `    timer_${index}_macro_first' = false,`, `    timer_${index}_fires' = 0,`);
  });
  model.combinators.forEach((join, index) => { join.branches.forEach((_, branch) => lines.push(`    join_${index}_branch_${branch}' = 0,`)); lines.push(`    join_${index}_result' = 0,`, `    join_${index}_iterator_failed' = false,`, `    join_${index}_rejection_escapes' = false,`); });
  lines.push("  }");
  const allVars = ["clock", ...model.timers.flatMap((_, i) => [`timer_${i}_scheduled`, `timer_${i}_cancelled`, `timer_${i}_due`, `timer_${i}_early`, `timer_${i}_after_cancel`, `timer_${i}_macro_first`, `timer_${i}_fires`]), ...model.combinators.flatMap((join, i) => [...join.branches.map((_, b) => `join_${i}_branch_${b}`), `join_${i}_result`, `join_${i}_iterator_failed`, `join_${i}_rejection_escapes`])];
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
    if (join.iteratorFailure) action(`fail_iterator_${index}`, [`join_${index}_result == 0`], new Map([
      [`join_${index}_result`, "2"],
      [`join_${index}_iterator_failed`, "true"],
      [`join_${index}_rejection_escapes`, String(!join.catchesRejection)],
    ]));
    join.branches.forEach((_, branch) => {
      const kind = join.branchKinds?.[branch] ?? "unknown";
      const raceGuard = join.combinator === "race" ? [`join_${index}_result == 0`] : [];
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
    const allFulfilled = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 1`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 1`).join(" or ") || "false";
    const allRejected = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 2`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 2`).join(" or ") || "false";
    const allSettled = join.branches.map((_, branch) => `(join_${index}_branch_${branch} == 1 or join_${index}_branch_${branch} == 2)`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : join.combinator === "race" ? "false" : anyFulfilled;
    const normalRejected = join.combinator === "all" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    const rejected = `(join_${index}_iterator_failed or (${normalRejected}))`;
    action(`fulfill_join_${index}`, [`join_${index}_result == 0`, ...(options.allowEarlyJoin ? ["true"] : [fulfilled])], new Map([[`join_${index}_result`, "1"]]));
    action(`reject_join_${index}`, [`join_${index}_result == 0`, ...(options.allowSpuriousReject ? ["true"] : [rejected])], new Map([
      [`join_${index}_result`, "2"],
      [`join_${index}_rejection_escapes`, String(!join.catchesRejection)],
    ]));
  });
  const actions = ["tick", ...model.timers.map((timer, i) => timerAction("fire", timer, i)), ...model.combinators.flatMap((join, i) => join.iteratorFailure ? [`fail_iterator_${i}`] : [...join.branches.flatMap((_, b) => {
    const kind = join.branchKinds?.[b] ?? "unknown";
    return kind === "value" ? [`fulfill_${i}_${b}`]
      : kind === "thenable" ? [`assimilate_${i}_${b}`, `fulfill_${i}_${b}`, `reject_${i}_${b}`]
      : [`fulfill_${i}_${b}`, `assimilate_${i}_${b}`, `reject_${i}_${b}`];
  }), `fulfill_join_${i}`, `reject_join_${i}`])];
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const safeTerms = [...model.timers.flatMap((timer, i) => [`not(timer_${i}_early)`, `not(timer_${i}_after_cancel)`, `not(timer_${i}_macro_first)`, ...(timer.kind === "abort-timeout" ? [`timer_${i}_fires <= 1`] : [])]), ...model.combinators.flatMap((join, i) => {
    const allFulfilled = join.branches.map((_, b) => `join_${i}_branch_${b} == 1`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, b) => `join_${i}_branch_${b} == 1`).join(" or ") || "false";
    const allRejected = join.branches.map((_, b) => `join_${i}_branch_${b} == 2`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, b) => `join_${i}_branch_${b} == 2`).join(" or ") || "false";
    const allSettled = join.branches.map((_, b) => `(join_${i}_branch_${b} == 1 or join_${i}_branch_${b} == 2)`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : anyFulfilled;
    const normalRejected = join.combinator === "all" || join.combinator === "race" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    const rejected = `(join_${i}_iterator_failed or (${normalRejected}))`;
    return [`((join_${i}_result != 1) or (${fulfilled}))`, `((join_${i}_result != 2) or (${rejected}))`];
  })];
  lines.push("", `  val asyncSafe = ${safeTerms.join(" and ") || "true"}`, "}", "");
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
  model.timers.forEach((_, index) => lines.push(`  var callback_${index}_pending: bool`, `  var callback_${index}_due: int`, `  var callback_${index}_fires: int`));
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
  const variables = [clock, phase, "wrong_phase", "fifo_broken", "scheduler_priority_broken", "scheduler_abort_broken", "abort_source_broken", "callback_precondition_broken", "next_microtask_ticket", ...temporalStates.map((state) => safe(state.name)), ...model.timers.flatMap((timer, index) => [`callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`, ...(timer.queue === "microtask" ? [`callback_${index}_ticket`] : [])]), ...abortCompositions.flatMap((_, index) => [`abort_${index}_aborted`, `abort_${index}_reason_source`, `abort_${index}_reason_overwritten`]), ...promiseVariables];
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
  const priorityRank = (timer: TimerPattern): number => timer.priority === "user-blocking" ? 2 : timer.priority === "background" ? 0 : 1;
  schedulerTasks.forEach((index) => {
    const timer = model.timers[index]!;
    const rank = priorityRank(timer);
    const outranking = schedulerTasks.flatMap((other) => {
      if (other === index) return [];
      const otherRank = priorityRank(model.timers[other]!);
      return otherRank > rank || (otherRank === rank && other < index) ? [`(callback_${other}_pending and callback_${other}_due <= clock)`] : [];
    });
    const violation = outranking.join(" or ") || "false";
    const abortViolation = [timer.abortComposition === undefined ? undefined : `abort_${timer.abortComposition}_aborted`, timer.abortTimer === undefined ? undefined : `callback_${timer.abortTimer}_fires > 0`].filter((term): term is string => Boolean(term)).join(" or ") || "false";
    const updates = new Map<string, string>([
      [phase, "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", `${phase} != 0`], ["scheduler_priority_broken", violation], ["scheduler_abort_broken", `scheduler_abort_broken or (${abortViolation})`],
    ]);
    enqueueChildren(index, updates);
    const guards = [...phaseGuard(0), `callback_${index}_pending`, `${clock} >= callback_${index}_due`, ...(options.allowWrongSchedulerPriority ? [] : [`not(${violation})`]), ...(options.allowRunAbortedSchedulerTask ? [] : [`not(${abortViolation})`])];
    applyCallbackSummary(index, guards, updates);
    action(timerAction("run", timer, index), guards, updates);
    if (options.allowRunAbortedSchedulerTask && abortViolation !== "false") action(`run_aborted_scheduler_task_${index}`, [`callback_${index}_pending`, `(${abortViolation})`], new Map([
      [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["scheduler_abort_broken", "true"],
    ]));
    if (!options.allowRunAbortedSchedulerTask && timer.abortComposition !== undefined) action(`cancel_scheduler_task_${index}_from_composition_${timer.abortComposition}`, [`callback_${index}_pending`, `abort_${timer.abortComposition}_aborted`], new Map([[`callback_${index}_pending`, "false"]]));
    if (!options.allowRunAbortedSchedulerTask && timer.abortTimer !== undefined) action(`cancel_scheduler_task_${index}_from_timer_${timer.abortTimer}`, [`callback_${index}_pending`, `callback_${timer.abortTimer}_fires > 0`], new Map([[`callback_${index}_pending`, "false"]]));
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
