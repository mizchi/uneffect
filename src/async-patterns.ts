import ts from "typescript";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import type { PromiseCombinator } from "./builtin-contracts.js";

export interface TimerPattern {
  owner: string;
  callback: string;
  delay?: number;
  recursive: boolean;
  repeats: boolean;
  queue: "timer" | "microtask";
  handle?: string;
  span: { start: number; end: number };
}

export interface PromiseCombinatorPattern {
  owner: string;
  combinator: PromiseCombinator;
  branches: string[];
  staticIterable: boolean;
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
  const timers: TimerPattern[] = [], combinators: PromiseCombinatorPattern[] = [], cancellations: TimerCancellation[] = [];
  const visitFunction = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body) return;
    const ownerName = functionName(owner);
    const visit = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const operation = adapter.resolveCall(node)?.operation;
        if (operation?.kind === "timer") {
          const callbackNode = node.arguments[operation.callbackArgument];
          const delayNode = operation.delayArgument === undefined ? undefined : node.arguments[operation.delayArgument];
          const callback = callbackNode?.getText(source) ?? "<unknown>";
          const declaration = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
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
        } else if (operation?.kind === "timer-clear") {
          const handle = node.arguments[operation.handleArgument]?.getText(source) ?? "<unknown>";
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
          const staticIterable = Boolean(iterable && ts.isArrayLiteralExpression(iterable));
          const branches = iterable && ts.isArrayLiteralExpression(iterable) ? iterable.elements.map((item) => item.getText(source)) : [];
          let current: ts.Node = node;
          while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
          const awaited = ts.isAwaitExpression(current.parent);
          if (awaited) current = current.parent;
          let catchesRejection = false;
          while (current.parent && current.parent !== owner.body) {
            if (ts.isTryStatement(current.parent) && current.parent.tryBlock === current && current.parent.catchClause) catchesRejection = true;
            current = current.parent;
          }
          combinators.push({ owner: ownerName, combinator: operation.combinator, branches, staticIterable, awaited, catchesRejection, span: { start: node.getStart(source), end: node.getEnd() } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunction(node as ts.FunctionLikeDeclaration);
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

export function generateAsyncPatternsQuint(moduleName: string, model: AsyncPatternModel, options: { allowEarlyTimer?: boolean; allowEarlyJoin?: boolean; allowSpuriousReject?: boolean; allowFireAfterCancel?: boolean; allowMacroBeforeMicrotask?: boolean } = {}): string {
  for (const timer of model.timers) if (timer.delay === undefined || timer.delay < 0) throw new Error(`${timer.owner}: timer model requires a static non-negative delay`);
  for (const join of model.combinators) if (!join.staticIterable) throw new Error(`${join.owner}: Promise.${join.combinator} model requires an array literal`);
  const lines = [`module ${safe(moduleName)} {`, "  var clock: int"];
  model.timers.forEach((_, index) => lines.push(`  var timer_${index}_scheduled: bool`, `  var timer_${index}_cancelled: bool`, `  var timer_${index}_due: int`, `  var timer_${index}_early: bool`, `  var timer_${index}_after_cancel: bool`, `  var timer_${index}_macro_first: bool`, `  var timer_${index}_fires: int`));
  model.combinators.forEach((join, index) => {
    join.branches.forEach((_, branch) => lines.push(`  var join_${index}_branch_${branch}: int`));
    lines.push(`  var join_${index}_result: int`, `  var join_${index}_rejection_escapes: bool`);
  });
  lines.push("", "  action init = all {", "    clock' = 0,");
  model.timers.forEach((timer, index) => {
    const cancelled = model.cancellations.some((item) => item.timer === index && item.definite);
    lines.push(`    timer_${index}_scheduled' = ${!cancelled},`, `    timer_${index}_cancelled' = ${cancelled},`, `    timer_${index}_due' = ${timer.delay},`, `    timer_${index}_early' = false,`, `    timer_${index}_after_cancel' = false,`, `    timer_${index}_macro_first' = false,`, `    timer_${index}_fires' = 0,`);
  });
  model.combinators.forEach((join, index) => { join.branches.forEach((_, branch) => lines.push(`    join_${index}_branch_${branch}' = 0,`)); lines.push(`    join_${index}_result' = 0,`, `    join_${index}_rejection_escapes' = false,`); });
  lines.push("  }");
  const allVars = ["clock", ...model.timers.flatMap((_, i) => [`timer_${i}_scheduled`, `timer_${i}_cancelled`, `timer_${i}_due`, `timer_${i}_early`, `timer_${i}_after_cancel`, `timer_${i}_macro_first`, `timer_${i}_fires`]), ...model.combinators.flatMap((join, i) => [...join.branches.map((_, b) => `join_${i}_branch_${b}`), `join_${i}_result`, `join_${i}_rejection_escapes`])];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    lines.push("", `  action ${name} = all {`);
    guards.forEach((guard) => lines.push(`    ${guard},`));
    allVars.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  action("tick", [], new Map([["clock", "clock + 1"]]));
  model.timers.forEach((timer, index) => {
    const pendingMicrotasks = model.timers.flatMap((candidate, candidateIndex) => candidate.owner === timer.owner && candidate.queue === "microtask" ? [`timer_${candidateIndex}_scheduled`] : []);
    action(`fire_timer_${index}`, [...(options.allowFireAfterCancel ? [] : [`timer_${index}_scheduled`]), ...(options.allowEarlyTimer ? [] : [`clock >= timer_${index}_due`]), ...(timer.queue === "timer" && !options.allowMacroBeforeMicrotask ? pendingMicrotasks.map((name) => `not(${name})`) : [])], new Map([
    [`timer_${index}_scheduled`, timer.recursive || timer.repeats ? "true" : "false"],
    [`timer_${index}_early`, `clock < timer_${index}_due`],
    [`timer_${index}_after_cancel`, `timer_${index}_cancelled`],
    [`timer_${index}_macro_first`, timer.queue === "timer" && pendingMicrotasks.length ? pendingMicrotasks.join(" or ") : "false"],
    [`timer_${index}_fires`, `timer_${index}_fires + 1`],
    [`timer_${index}_due`, timer.recursive || timer.repeats ? `clock + ${timer.delay}` : `timer_${index}_due`],
    ]));
  });
  model.combinators.forEach((join, index) => {
    join.branches.forEach((_, branch) => {
      const raceGuard = join.combinator === "race" ? [`join_${index}_result == 0`] : [];
      const fulfillUpdates = new Map([[`join_${index}_branch_${branch}`, "1"]]);
      const rejectUpdates = new Map([[`join_${index}_branch_${branch}`, "2"]]);
      if (join.combinator === "race") {
        fulfillUpdates.set(`join_${index}_result`, "1");
        rejectUpdates.set(`join_${index}_result`, "2");
        rejectUpdates.set(`join_${index}_rejection_escapes`, String(!join.catchesRejection));
      }
      action(`fulfill_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard], fulfillUpdates);
      action(`reject_${index}_${branch}`, [`join_${index}_branch_${branch} == 0`, ...raceGuard], rejectUpdates);
    });
    const allFulfilled = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 1`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 1`).join(" or ") || "false";
    const allRejected = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 2`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, branch) => `join_${index}_branch_${branch} == 2`).join(" or ") || "false";
    const allSettled = join.branches.map((_, branch) => `join_${index}_branch_${branch} != 0`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : join.combinator === "race" ? "false" : anyFulfilled;
    const rejected = join.combinator === "all" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    action(`fulfill_join_${index}`, [`join_${index}_result == 0`, ...(options.allowEarlyJoin ? ["true"] : [fulfilled])], new Map([[`join_${index}_result`, "1"]]));
    action(`reject_join_${index}`, [`join_${index}_result == 0`, ...(options.allowSpuriousReject ? ["true"] : [rejected])], new Map([
      [`join_${index}_result`, "2"],
      [`join_${index}_rejection_escapes`, String(!join.catchesRejection)],
    ]));
  });
  const actions = ["tick", ...model.timers.map((_, i) => `fire_timer_${i}`), ...model.combinators.flatMap((join, i) => [...join.branches.flatMap((_, b) => [`fulfill_${i}_${b}`, `reject_${i}_${b}`]), `fulfill_join_${i}`, `reject_join_${i}`])];
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const safeTerms = [...model.timers.flatMap((_, i) => [`not(timer_${i}_early)`, `not(timer_${i}_after_cancel)`, `not(timer_${i}_macro_first)`]), ...model.combinators.flatMap((join, i) => {
    const allFulfilled = join.branches.map((_, b) => `join_${i}_branch_${b} == 1`).join(" and ") || "true";
    const anyFulfilled = join.branches.map((_, b) => `join_${i}_branch_${b} == 1`).join(" or ") || "false";
    const allRejected = join.branches.map((_, b) => `join_${i}_branch_${b} == 2`).join(" and ") || "true";
    const anyRejected = join.branches.map((_, b) => `join_${i}_branch_${b} == 2`).join(" or ") || "false";
    const allSettled = join.branches.map((_, b) => `join_${i}_branch_${b} != 0`).join(" and ") || "true";
    const fulfilled = join.combinator === "all" ? allFulfilled : join.combinator === "allSettled" ? allSettled : anyFulfilled;
    const rejected = join.combinator === "all" || join.combinator === "race" ? anyRejected : join.combinator === "any" ? allRejected : "false";
    return [`((join_${i}_result != 1) or (${fulfilled}))`, `((join_${i}_result != 2) or (${rejected}))`];
  })];
  lines.push("", `  val asyncSafe = ${safeTerms.join(" and ") || "true"}`, "}", "");
  return lines.join("\n");
}
