import ts from "typescript";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import type { PromiseCombinator } from "./builtin-contracts.js";
import type { PromiseChainModel } from "./promise-chains.js";

export interface TimerPattern {
  owner: string;
  callback: string;
  delay?: number;
  recursive: boolean;
  repeats: boolean;
  queue: "timer" | "microtask" | "animation-frame";
  enqueuedBy?: number;
  handle?: string;
  kind?: "abort-timeout";
  abortReason?: "TimeoutError";
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

export interface AsyncPatternModel {
  timers: TimerPattern[];
  combinators: PromiseCombinatorPattern[];
  cancellations: TimerCancellation[];
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}

export function analyzeAsyncPatternsInProgram(program: ts.Program, source: ts.SourceFile): AsyncPatternModel {
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const timers: TimerPattern[] = [], combinators: PromiseCombinatorPattern[] = [], cancellations: TimerCancellation[] = [];
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
      if (operation?.kind === "timer") {
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
    const resolveHandle = (name: string): string => {
      const seen = new Set<string>();
      let current = name;
      while (handleAliases.has(current) && !seen.has(current)) { seen.add(current); current = handleAliases.get(current)!; }
      return current;
    };
    const collectNestedMicrotasks = (callbackExpression: ts.Expression | undefined, parent: number, visited = new Set<ts.FunctionLikeDeclaration>()): void => {
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
            collectNestedMicrotasks(callbackNode, child, visited);
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
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        handleAliases.delete(node.left.text);
      }
      if (ts.isCallExpression(node)) {
        const operation = adapter.resolveCall(node)?.operation;
        if (operation?.kind === "timer") {
          const callbackNode = node.arguments[operation.callbackArgument];
          const delayNode = operation.delayArgument === undefined ? undefined : node.arguments[operation.delayArgument];
          const callback = callbackNode?.getText(source) ?? "<unknown>";
          const declaration = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
          const timerIndex = timers.length;
          timers.push({
            owner: ownerName,
            callback,
            delay: delayNode && ts.isNumericLiteral(delayNode) ? Number(delayNode.text) : operation.delayArgument === undefined ? 0 : undefined,
            recursive: callback === ownerName,
            repeats: operation.repeats,
            queue: operation.queue,
            handle: declaration,
            span: { start: node.getStart(source), end: node.getEnd() },
          });
          collectNestedMicrotasks(callbackNode, timerIndex);
        } else if (operation?.kind === "abort-timeout") {
          const delayNode = node.arguments[operation.delayArgument];
          const declaration = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
          timers.push({
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
          cancellations.push({ owner: ownerName, handle, definite, span: { start: node.getStart(source), end: node.getEnd() } });
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
      const scheduledCallback = Boolean(parentCall && operation?.kind === "timer" && parentCall.arguments[operation.callbackArgument] === node);
      if (!scheduledCallback && !scheduledCallbacks.has(node as ts.FunctionLikeDeclaration)) visitFunction(node as ts.FunctionLikeDeclaration);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const cancellation of cancellations) {
    const timer = timers.findIndex((item) => item.owner === cancellation.owner && item.handle === cancellation.handle);
    if (timer >= 0) cancellation.timer = timer;
  }
  return { timers, combinators, cancellations };
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
  return kind === "fire" ? `fire_timer_${index}` : `run_timer_task_${index}`;
}

export function generateAsyncPatternsQuint(moduleName: string, model: AsyncPatternModel, options: { allowEarlyTimer?: boolean; allowEarlyJoin?: boolean; allowSpuriousReject?: boolean; allowFireAfterCancel?: boolean; allowMacroBeforeMicrotask?: boolean } = {}): string {
  for (const timer of model.timers) {
    if (timer.delay === undefined || timer.delay < 0) throw new Error(`${timer.owner}: timer model requires a static non-negative delay`);
    if (timer.kind === "abort-timeout" && timer.delay > Number.MAX_SAFE_INTEGER) throw new Error(`${timer.owner}: AbortSignal.timeout delay exceeds Number.MAX_SAFE_INTEGER`);
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
    const cancelled = model.cancellations.some((item) => item.timer === index && item.definite);
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
export function generateWebEventLoopQuint(moduleName: string, model: AsyncPatternModel, options: { allowWrongPhase?: boolean; allowOutOfOrderMicrotasks?: boolean } = {}, promiseModel?: PromiseChainModel): string {
  for (const timer of model.timers) {
    if (timer.delay === undefined || timer.delay < 0) throw new Error(`${timer.owner}: web event-loop model requires a static non-negative delay`);
    if (timer.kind === "abort-timeout" && timer.delay > Number.MAX_SAFE_INTEGER) throw new Error(`${timer.owner}: AbortSignal.timeout delay exceeds Number.MAX_SAFE_INTEGER`);
  }
  const microtasks = model.timers.flatMap((timer, index) => timer.queue === "microtask" ? [index] : []);
  const frames = model.timers.flatMap((timer, index) => timer.queue === "animation-frame" ? [index] : []);
  const timers = model.timers.flatMap((timer, index) => timer.queue === "timer" ? [index] : []);
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
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int", "  var phase: int", "  var wrong_phase: bool", "  var fifo_broken: bool", "  var next_microtask_ticket: int"];
  model.timers.forEach((_, index) => lines.push(`  var callback_${index}_pending: bool`, `  var callback_${index}_due: int`, `  var callback_${index}_fires: int`));
  microtasks.forEach((index) => lines.push(`  var callback_${index}_ticket: int`));
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => lines.push(`  var promise_reaction_${chainIndex}_${stage}_pending: bool`, `  var promise_reaction_${chainIndex}_${stage}_done: bool`, `  var promise_reaction_${chainIndex}_${stage}_ticket: int`)));
  lines.push("", "  action init = all {", "    clock' = 0,", "    phase' = 1,", "    wrong_phase' = false,", "    fifo_broken' = false,", `    next_microtask_ticket' = ${initialJobs.length},`);
  model.timers.forEach((timer, index) => {
    const definitelyCancelled = model.cancellations.some((cancellation) => cancellation.timer === index && cancellation.definite);
    lines.push(`    callback_${index}_pending' = ${!definitelyCancelled && timer.enqueuedBy === undefined},`, `    callback_${index}_due' = ${timer.delay},`, `    callback_${index}_fires' = 0,`);
    if (timer.queue === "microtask") lines.push(`    callback_${index}_ticket' = ${initialTicket.get(`callback:${index}`) ?? -1},`);
  });
  promiseModel?.chains.forEach((chain, chainIndex) => {
    chain.links.forEach((_, stage) => {
      const queued = initiallyQueuedReactions.has(`${chainIndex}:${stage}`);
      lines.push(`    promise_reaction_${chainIndex}_${stage}_pending' = ${queued},`, `    promise_reaction_${chainIndex}_${stage}_done' = false,`, `    promise_reaction_${chainIndex}_${stage}_ticket' = ${initialTicket.get(`reaction:${chainIndex}:${stage}`) ?? -1},`);
    });
  });
  lines.push("  }");
  const promiseVariables = promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.flatMap((_, stage) => [`promise_reaction_${chainIndex}_${stage}_pending`, `promise_reaction_${chainIndex}_${stage}_done`, `promise_reaction_${chainIndex}_${stage}_ticket`])) ?? [];
  const variables = ["clock", "phase", "wrong_phase", "fifo_broken", "next_microtask_ticket", ...model.timers.flatMap((timer, index) => [`callback_${index}_pending`, `callback_${index}_due`, `callback_${index}_fires`, ...(timer.queue === "microtask" ? [`callback_${index}_ticket`] : [])]), ...promiseVariables];
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name); lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    variables.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const phaseGuard = (expected: number): string[] => options.allowWrongPhase ? [] : [`phase == ${expected}`];
  const jobs = [...microtasks.map((index) => ({ pending: `callback_${index}_pending`, ticket: `callback_${index}_ticket` })), ...(promiseModel?.chains.flatMap((chain, chainIndex) => chain.links.map((_, stage) => ({ pending: `promise_reaction_${chainIndex}_${stage}_pending`, ticket: `promise_reaction_${chainIndex}_${stage}_ticket` }))) ?? [])];
  const fifoViolation = (ticket: string): string => jobs.map((job) => `(${job.pending} and ${job.ticket} < ${ticket})`).join(" or ") || "false";
  const fifoGuards = (ticket: string): string[] => options.allowOutOfOrderMicrotasks ? [] : [`not(${fifoViolation(ticket)})`];
  const enqueueChildren = (parent: number, updates: Map<string, string>): void => {
    const children = microtasks.filter((index) => model.timers[index]!.enqueuedBy === parent);
    children.forEach((child, offset) => {
      updates.set(`callback_${child}_pending`, "true");
      updates.set(`callback_${child}_ticket`, offset === 0 ? "next_microtask_ticket" : `next_microtask_ticket + ${offset}`);
    });
    if (children.length) updates.set("next_microtask_ticket", children.length === 1 ? "next_microtask_ticket + 1" : `next_microtask_ticket + ${children.length}`);
  };
  microtasks.forEach((index) => {
    const ticket = `callback_${index}_ticket`;
    const updates = new Map<string, string>([
      [`callback_${index}_pending`, "false"], [ticket, "-1"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", "phase != 1"], ["fifo_broken", fifoViolation(ticket)],
    ]);
    enqueueChildren(index, updates);
    action(`drain_microtask_${index}`, [...phaseGuard(1), `callback_${index}_pending`, ...fifoGuards(ticket)], updates);
  });
  const promisePending: string[] = [];
  promiseModel?.chains.forEach((chain, chainIndex) => chain.links.forEach((_, stage) => {
    const pending = `promise_reaction_${chainIndex}_${stage}_pending`, done = `promise_reaction_${chainIndex}_${stage}_done`, ticket = `promise_reaction_${chainIndex}_${stage}_ticket`;
    promisePending.push(pending);
    const updates = new Map<string, string>([[pending, "false"], [done, "true"], [ticket, "-1"], ["wrong_phase", "phase != 1"], ["fifo_broken", fifoViolation(ticket)]]);
    if (stage + 1 < chain.links.length) {
      updates.set(`promise_reaction_${chainIndex}_${stage + 1}_pending`, "true");
      updates.set(`promise_reaction_${chainIndex}_${stage + 1}_ticket`, "next_microtask_ticket");
      updates.set("next_microtask_ticket", "next_microtask_ticket + 1");
    }
    action(`drain_promise_reaction_${chainIndex}_${stage}`, [...phaseGuard(1), pending, ...fifoGuards(ticket)], updates);
  }));
  action("finish_microtask_checkpoint", [...phaseGuard(1), ...microtasks.map((index) => `not(callback_${index}_pending)`), ...promisePending.map((name) => `not(${name})`)], new Map([["phase", "2"], ["wrong_phase", "phase != 1"]]));
  frames.forEach((index, order) => {
    const updates = new Map<string, string>([["phase", "1"], [`callback_${index}_pending`, "false"], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", "phase != 2"]]);
    enqueueChildren(index, updates);
    action(`run_animation_frame_${index}`, [...phaseGuard(2), `callback_${index}_pending`, ...frames.slice(0, order).map((earlier) => `not(callback_${earlier}_pending)`)], updates);
  });
  action("paint", [...phaseGuard(2), ...frames.map((index) => `not(callback_${index}_pending)`)], new Map([["phase", "0"], ["wrong_phase", "phase != 2"]]));
  action("skip_rendering_opportunity", phaseGuard(2), new Map([["phase", "0"], ["wrong_phase", "phase != 2"]]));
  action("advance_clock", phaseGuard(0), new Map([["clock", "clock + 1"], ["wrong_phase", "phase != 0"]]));
  action("idle_turn", phaseGuard(0), new Map([["phase", "1"], ["wrong_phase", "phase != 0"]]));
  timers.forEach((index, order) => {
    const timer = model.timers[index]!;
    const earlierDue = timers.slice(0, order).map((earlier) => `not(callback_${earlier}_pending) or callback_${earlier}_due > clock`);
    const updates = new Map<string, string>([
      ["phase", "1"], [`callback_${index}_pending`, String(timer.repeats)], [`callback_${index}_due`, timer.repeats ? `clock + ${timer.delay}` : `callback_${index}_due`], [`callback_${index}_fires`, `callback_${index}_fires + 1`], ["wrong_phase", "phase != 0"],
    ]);
    enqueueChildren(index, updates);
    action(timerAction("run", timer, index), [...phaseGuard(0), `callback_${index}_pending`, `clock >= callback_${index}_due`, ...earlierDue], updates);
  });
  const oneShotSignals = model.timers.flatMap((timer, index) => timer.kind === "abort-timeout" ? [`callback_${index}_fires <= 1`] : []);
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }", "", `  val eventLoopSafe = not(wrong_phase) and not(fifo_broken)${oneShotSignals.map((term) => ` and ${term}`).join("")}`, "}", "");
  return lines.join("\n");
}
