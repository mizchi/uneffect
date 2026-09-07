import type { Node, CallExpression } from "oxc-parser";
import type { CorsaApiFrontend } from "../frontends/corsa/corsa-api-frontend.js";
import { oxcChildren, type OxcSource } from "../frontends/oxc/source.js";
import type { ModuleSourceFacts } from "./module-order-core.js";
import type { ConditionalAwaitFacts } from "./module-order-control-flow.js";
import type { ModuleInitializationOrder } from "./contracts.js";

const span = (node: Node) => ({ start: node.start, end: node.end });
const unwrap = (node: Node): Node => (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") && node.declaration ? node.declaration : node;
const boundary = (node: Node) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassDeclaration", "ClassExpression"].includes(node.type);

function exactlyOnce(node: Node, owner: Node, parents: Map<Node, Node>): boolean {
  for (let child = node, parent = parents.get(child); parent && parent !== owner; child = parent, parent = parents.get(child)) {
    switch (parent.type) {
      case "ForStatement": if (child !== parent.init) return false; break;
      case "ForInStatement": case "ForOfStatement": if (child !== parent.right) return false; break;
      case "WhileStatement": case "DoWhileStatement": return false;
      case "LogicalExpression": if (child === parent.right) return false; break;
      case "AssignmentPattern": if (child === parent.right) return false; break;
      case "IfStatement": case "ConditionalExpression": if (child !== parent.test) return false; break;
      case "SwitchStatement": if (child !== parent.discriminant) return false; break;
      case "SwitchCase": case "TryStatement": case "CatchClause": return false;
      default: if (boundary(parent)) return false;
    }
  }
  return true;
}

export interface OxcModuleFacts {
  readonly facts: ModuleSourceFacts;
  conditionalCandidate(order: ModuleInitializationOrder): ConditionalAwaitFacts | undefined;
}

/** Syntax supplies spans/control dependence; every symbol identity comes from Corsa. */
export function inspectOxcModule(source: OxcSource, frontend: CorsaApiFrontend, resolveImport: (position: number) => string | undefined): OxcModuleFacts {
  const facts: { -readonly [K in keyof ModuleSourceFacts]: ModuleSourceFacts[K] } = { source, dependencies: [], dependencyRequests: [], awaits: [], unknowns: [] };
  const parents = new Map<Node, Node>();
  const collectParents = (node: Node): void => { for (const child of oxcChildren(node)) { parents.set(child, node); collectParents(child); } };
  collectParents(source.program);
  const symbolAt = (node: Node) => frontend.getSymbolAtPosition(source.fileName, node.start);
  const sameSymbol = (left: Node, right: Node): boolean => { const symbol = symbolAt(left); return symbol !== null && symbol.id === symbolAt(right)?.id; };
  const localAsync = (call: CallExpression): boolean => call.arguments.length === 0 && call.callee.type === "Identifier"
    && source.program.body.some(item => { const node = unwrap(item); return node.type === "FunctionDeclaration" && node.async && !!node.id && sameSymbol(call.callee, node.id); });
  const add = (kind: ModuleSourceFacts["unknowns"][number]["kind"], node: Node, detail: string): void => { facts.unknowns.push({ fileName: source.fileName, kind, span: span(node), detail }); };
  for (const item of source.program.body) {
    const statement = unwrap(item);
    if ((item.type === "ImportDeclaration" || item.type === "ExportNamedDeclaration" || item.type === "ExportAllDeclaration") && item.source) {
      const runtime = item.type === "ImportDeclaration"
        ? item.importKind !== "type" && (item.specifiers.length === 0 || item.specifiers.some(s => s.type !== "ImportSpecifier" || s.importKind !== "type"))
        : item.exportKind !== "type" && (item.type === "ExportAllDeclaration" || item.specifiers.some(s => s.exportKind !== "type"));
      // An empty import clause is distinct from a side-effect-only import.
      const sideEffectOnly = item.type === "ImportDeclaration" && item.specifiers.length === 0
        && source.text.slice(item.start, item.source.start).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/gu, "").trim() === "import";
      const emptyImportClause = item.type === "ImportDeclaration" && item.specifiers.length === 0 && !sideEffectOnly;
      if (runtime && !emptyImportClause) {
        const dependency = resolveImport(item.source.start);
        if (dependency) {
          if (!facts.dependencies.includes(dependency)) facts.dependencies.push(dependency);
          facts.dependencyRequests.push({ dependency, span: span(item.source), sideEffectOnly });
        } else add("external-static-import", item.source, `module body is outside the Program: ${item.source.value}`);
      }
    }
    if (statement.type === "ThrowStatement" && !facts.directThrow) facts.directThrow = span(statement);
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") continue;
    const call = statement.expression, access = call.callee;
    if (access.type === "MemberExpression" && !access.computed && access.property.type === "Identifier" && access.property.name === "catch") {
      const launch = access.object, handler = call.arguments[0];
      const catchSymbol = symbolAt(access.property);
      const standardCatch = catchSymbol?.name === "catch" && catchSymbol.declarations?.some(declaration => /[/\\]lib\.es5\.d\.ts$/u.test(declaration));
      const supported = launch.type === "CallExpression" && localAsync(launch) && call.arguments.length === 1
        && handler && (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") && standardCatch;
      if (!supported) add("unsupported-top-level-promise-handler", call, "top-level catch is outside the source-local async main().catch(handler) fragment");
      else if (facts.handledPromiseLaunch) {
        add("unsupported-top-level-promise-handler", call, "multiple top-level Promise launches are outside the supported fragment");
        facts.handledPromiseLaunch = undefined;
      } else facts.handledPromiseLaunch = { launchSpan: span(launch), handlerSpan: { start: access.property.start, end: call.end } };
    } else if (localAsync(call)) add("unhandled-top-level-promise-launch", call, "a top-level source-local async function launch has no supported rejection handler");
  }
  const walk = (node: Node, statement: Node): void => {
    if (boundary(node)) return;
    if (node.type === "AwaitExpression") {
      facts.awaits.push(span(node));
      if (!exactlyOnce(node, source.program, parents)) add("conditional-top-level-await", node, "control-dependent await settlement order is not yet represented");
    }
    if (node.type === "ThrowStatement" && node !== statement) add("conditional-top-level-throw", node, "control-dependent synchronous termination is not yet represented");
    if (node.type === "ImportExpression") add("dynamic-import", node, "dynamic import evaluation is conditional and not part of the static dependency order");
    for (const child of oxcChildren(node)) walk(child, statement);
  };
  for (const item of source.program.body) walk(unwrap(item), unwrap(item));
  for (const item of source.program.body) {
    const statement = unwrap(item);
    if (statement.type === "ClassDeclaration" && (statement.superClass || statement.decorators.length || statement.implements?.length
      || statement.body.body.some(member => member.type === "StaticBlock" || (member.type === "PropertyDefinition" && member.static)
        || ("decorators" in member && member.decorators.length) || ("computed" in member && member.computed)))) {
      add("class-initialization-order", item, "class heritage, decorator, computed-name, or static initialization order is not yet represented");
    }
  }
  facts.awaits.sort((a, b) => a.start - b.start);
  if (facts.handledPromiseLaunch && facts.awaits.length) facts.unknowns.push({ fileName: source.fileName, kind: "unsupported-mixed-top-level-async-shape", span: facts.handledPromiseLaunch.launchSpan, detail: "top-level await mixed with a top-level Promise launch is outside the supported fragment" });
  return { facts, conditionalCandidate(order) {
    const unknowns = order.unknowns.filter(item => item.kind === "conditional-top-level-await");
    if (unknowns.length !== 1 || unknowns[0]!.fileName !== source.fileName) return undefined;
    const module = order.modules.find(item => item.fileName === source.fileName);
    if (!module || module.choices.length !== 1 || module.events.filter(event => event.kind === "suspend").length !== 1
      || !module.events.some(event => event.kind === "complete") || module.events.some(event => ["throw", "promise-launch", "rejection-handler-attach"].includes(event.kind))) return undefined;
    for (const statement of source.program.body) {
      if (statement.type !== "IfStatement" || statement.alternate || statement.test.type !== "Identifier") continue;
      const selector = statement.test;
      const body = statement.consequent.type === "BlockStatement" ? statement.consequent.body.length === 1 ? statement.consequent.body[0] : undefined : statement.consequent;
      if (!body || ["IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement", "WithStatement", "LabeledStatement"].includes(body.type)) continue;
      const awaits: Node[] = [];
      const findAwait = (node: Node): void => { if (boundary(node)) return; if (node.type === "AwaitExpression") awaits.push(node); for (const child of oxcChildren(node)) findAwait(child); };
      findAwait(body);
      const awaited = awaits[0];
      if (awaits.length !== 1 || !awaited || awaited.start !== unknowns[0]!.span?.start || !exactlyOnce(awaited, body, parents)) continue;
      const runtimeConst = source.program.body.some(item => {
        const declaration = unwrap(item);
        return declaration.type === "VariableDeclaration" && declaration.kind === "const" && !declaration.declare
          && declaration.declarations.some(variable => variable.id.type === "Identifier" && variable.init && sameSymbol(variable.id, selector));
      });
      const texts = frontend.getTypeAtPosition(source.fileName, selector.start)?.texts;
      if (!runtimeConst || !texts?.length || !texts.every(text => ["boolean", "true", "false"].includes(text))) continue;
      let written = false;
      const contains = (node: Node): boolean => node.type === "Identifier" && sameSymbol(node, selector) || oxcChildren(node).some(contains);
      const findWrite = (node: Node): void => {
        if (node.type === "AssignmentExpression" && contains(node.left) || node.type === "UpdateExpression" && contains(node.argument)
          || (node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration" && contains(node.left)) written = true;
        for (const child of oxcChildren(node)) findWrite(child);
      };
      findWrite(source.program);
      if (!written) return { source, statement: span(statement), selector: { ...span(selector), text: selector.name }, awaitExpression: span(awaited) };
    }
    return undefined;
  } };
}
