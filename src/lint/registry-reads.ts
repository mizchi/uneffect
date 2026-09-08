import { parseSync, type Node } from "oxc-parser";
import { oxcChildren } from "../frontends/oxc/source.js";
import type { CorsaApiFrontend } from "../frontends/corsa/corsa-api-frontend.js";
import type { RegistryReadRuleOptions, RuleCfg, RuleEvent, SourceRuleLowering } from "./contracts.js";
import { lowerRegistryStatements } from "./registry-control-flow.js";
import { frozenRegistryKeys } from "./registry-enumeration.js";

class Unsupported extends Error { constructor(readonly node: Node, message: string) { super(message); } }

/** Native identities and prerequisite events, independent of statement CFG construction. */
export function lowerRegistryReadCfg(source: string, frontend: CorsaApiFrontend, options: RegistryReadRuleOptions): SourceRuleLowering {
  const location = (node: Node) => ({ fileName: options.fileName, start: node.start, end: node.end });
  try {
    const parsed = parseSync(options.fileName, source, { lang: options.fileName.endsWith(".tsx") ? "tsx" : "ts" });
    if (parsed.errors.length) throw new Unsupported(parsed.program, "invalid Oxc syntax");
    const fn = parsed.program.body.flatMap(statement => {
      const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
      return node?.type === "FunctionDeclaration" && node.id?.name === options.functionName && node.body ? [node] : [];
    })[0];
    if (!fn?.body) throw new TypeError("functionName must identify a top-level function implementation");
    const parts = options.registry.split(".");
    const parameter = fn.params.find(node => node.type === "Identifier" && node.name === parts[0]);
    const moduleBinding = parsed.program.body.flatMap(statement => {
      const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      return node?.type === "VariableDeclaration" && node.kind === "const" ? node.declarations
        .filter(declaration => declaration.id.type === "Identifier" && declaration.id.name === parts[0]).map(declaration => declaration.id) : [];
    })[0];
    const binding = parameter ?? moduleBinding;
    if (!binding) throw new TypeError("registry must start with a plain parameter or a module const binding");
    const symbols = new Map<number, ReturnType<CorsaApiFrontend["getSymbolAtPosition"]>>();
    const symbol = (node: Node) => {
      if (!symbols.has(node.start)) symbols.set(node.start, frontend.getSymbolAtPosition(options.fileName, node.start));
      return symbols.get(node.start)!;
    };
    const rootSymbol = symbol(binding);
    if (!rootSymbol) throw new Unsupported(binding, "registry binding identity is unavailable");
    const registry = JSON.stringify([rootSymbol.id, ...parts.slice(1)]);
    const unwrap = (node: Node): Node => node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSNonNullExpression" || node.type === "TSTypeAssertion"
      ? unwrap(node.expression) : node;
    const memberName = (node: Node, computed: boolean): string | undefined => {
      if (!computed && node.type === "Identifier") return node.name;
      if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
      return undefined;
    };
    const aliases = new Map<string, string[]>();
    const regions = new Set<string>([registry]);
    const path = (input: Node): string[] | undefined => {
      const node = unwrap(input);
      if (node.type === "Identifier") { const value = symbol(node); return value ? aliases.get(value.id) ?? [value.id] : undefined; }
      if (node.type !== "MemberExpression" || node.optional) return undefined;
      const base = path(node.object), field = memberName(node.property, node.computed);
      return base && field !== undefined ? [...base, field] : undefined;
    };
    const isRegistry = (node: Node) => regions.has(JSON.stringify(path(node)));
    const key = (node: Node): string | undefined => {
      node = unwrap(node);
      if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return JSON.stringify(["literal", String(node.value)]);
      const value = path(node);
      return value ? JSON.stringify(["path", ...value]) : undefined;
    };
    const subject = (table: Node, value: string) => JSON.stringify([JSON.stringify(path(table)), value]);
    const library = (node: Node) => symbol(node)?.declarations?.some(file => /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/iu.test(file)) === true;
    const objectCall = (input: Node, name: string, arity: number): boolean => {
      const node = unwrap(input);
      if (node.type !== "CallExpression" || node.optional || node.arguments.length !== arity) return false;
      const callee = unwrap(node.callee);
      return callee.type === "MemberExpression" && !callee.optional && memberName(callee.property, callee.computed) === name
        && callee.object.type === "Identifier" && callee.object.name === "Object" && library(callee.object) && library(callee.property);
    };
    const ownGuard = (input: Node): string | undefined => {
      const node = unwrap(input);
      if (node.type !== "CallExpression" || !objectCall(node, "hasOwn", 2)) return undefined;
      const [table, property] = node.arguments;
      if (!table || !property || !isRegistry(table)) return undefined;
      const value = key(property);
      return value === undefined ? undefined : subject(table, value);
    };
    const aliasDeclarations = new Set<Node>();
    // A const capture owns its region: replacing the original parameter/property
    // must never transfer a guard on the replacement to the captured object.
    for (const statement of fn.body.body) {
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || !declaration.init || !isRegistry(declaration.init)) continue;
        const identity = symbol(declaration.id);
        if (!identity) throw new Unsupported(declaration, "alias identity is unavailable");
        const origin = path(declaration.init)!;
        const region = origin.length === 1 && aliases.has(origin[0]!) ? origin : [identity.id];
        aliases.set(identity.id, region);
        regions.add(JSON.stringify(region));
        aliasDeclarations.add(declaration);
      }
    }
    const enumerated = frozenRegistryKeys(parsed.program, fn.body, !parameter && parts.length === 1 ? moduleBinding : undefined, {
      symbolId: node => symbol(node)?.id, originalTable: node => JSON.stringify(path(node)) === registry, objectCall,
    });
    const reads = new Map<Node, string>(), owner = new Map<Node, Node>();
    const guards = new Map<string, Set<Node>>();
    const dataPaths = new Set<string>(regions);
    const rootField = (node: Node, parent: Node | undefined): boolean => {
      if (!parent) return false;
      return parent.type === "VariableDeclarator" && parent.init === node
        || (parent.type === "ExpressionStatement" && parent.expression === node)
        || ((parent.type === "ReturnStatement" || parent.type === "ThrowStatement") && parent.argument === node)
        || ((parent.type === "IfStatement" || parent.type === "WhileStatement" || parent.type === "DoWhileStatement") && parent.test === node)
        || (parent.type === "ForStatement" && (parent.test === node || parent.update === node))
        || ((parent.type === "ForOfStatement" || parent.type === "ForInStatement") && parent.right === node);
    };
    const containsRegistry = (node: Node): boolean => isRegistry(node) || oxcChildren(node).some(containsRegistry);
    const scan = (node: Node, parent?: Node, expressionRoot?: Node): void => {
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
        if (containsRegistry(node)) throw new Unsupported(node, "registry references in nested functions require invocation analysis");
        return;
      }
      if (rootField(node, parent) && expressionRoot === undefined) expressionRoot = node;
      if (node.type === "VariableDeclarator" && node.init && isRegistry(node.init) && !aliasDeclarations.has(node)) throw new Unsupported(node, "only function-body const registry aliases are supported");
      const writeOnly = parent?.type === "AssignmentExpression" && parent.operator === "=" && parent.left === node
        || parent?.type === "UnaryExpression" && parent.operator === "delete";
      if (node.type === "MemberExpression" && isRegistry(node.object) && !writeOnly) {
        const value = node.computed ? key(node.property) : JSON.stringify(["literal", memberName(node.property, false)]);
        if (value === undefined || !expressionRoot) throw new Unsupported(node, "registry reads require a stable key in a supported expression");
        reads.set(node, subject(node.object, value)); owner.set(node, expressionRoot);
        const propertyPath = node.computed ? path(node.property) : undefined;
        if (propertyPath) dataPaths.add(JSON.stringify(propertyPath));
      }
      const guard = ownGuard(node);
      if (guard && expressionRoot) {
        const set = guards.get(guard) ?? new Set<Node>(); set.add(expressionRoot); guards.set(guard, set);
      }
      for (const child of oxcChildren(node)) scan(child, node, expressionRoot);
    };
    scan(fn.body);
    if (!reads.size) throw new Unsupported(fn, "no direct registry reads were selected; aliases and escaping tables are not analyzed");
    for (const [node, value] of reads) {
      const checks = guards.get(value);
      if (options.flow !== "statement" && checks?.size && !checks.has(owner.get(node)!)) throw new Unsupported(node, "guards across statements require statement flow mode");
    }
    const subjects = [...new Set(reads.values())];
    const blocks: Array<{ id: string; successors: string[]; events: RuleEvent[] }> = [];
    const block = (successors: string[], events: RuleEvent[] = []) => {
      const id = `expression:${blocks.length}`; blocks.push({ id, successors: [...new Set(successors)], events }); return id;
    };
    const event = (node: Node, operation: string, value: string): RuleEvent => ({ operation, subject: value, location: location(node) });
    const invalidate = (node: Node, next: string) => block([next], subjects.map(value => event(node, "invalidate", value)));
    const isDataPath = (node: Node) => { const value = path(node); return value !== undefined && [...dataPaths].some(item => {
      const full = JSON.parse(item) as string[]; return value.length <= full.length && value.every((part, index) => part === full[index]);
    }); };
    const relevant = (node: Node): boolean => reads.has(node) || ownGuard(node) !== undefined || oxcChildren(node).some(relevant);
    const expression = (input: Node, next: string): string => {
      const node = unwrap(input);
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return next;
      if (node.type === "TemplateLiteral") {
        // Each substitution is evaluated and coerced before the next. Unknown
        // coercion can invoke user code; literal primitives need no invalidation.
        for (const item of [...node.expressions].reverse()) {
          const value = unwrap(item);
          const coerced = value.type === "Literal" && !("regex" in value) ? next : invalidate(item, next);
          next = expression(item, coerced);
        }
        return next;
      }
      if (node.type === "ClassExpression" || node.type === "ClassDeclaration"
        || node.type === "TaggedTemplateExpression" || node.type === "JSXElement" || node.type === "JSXFragment"
        || node.type === "ArrayPattern" || node.type === "ObjectPattern"
        || node.type === "Property" && node.computed) {
        if (relevant(node)) throw new Unsupported(node, "expression execution order or implicit calls are not modeled");
        return invalidate(node, next);
      }
      if (node.type === "ConditionalExpression") return condition(node.test, expression(node.consequent, next), expression(node.alternate, next));
      if (node.type === "LogicalExpression" && node.operator === "&&") return condition(node.left, expression(node.right, next), next);
      if (node.type === "LogicalExpression" && node.operator === "||") return condition(node.left, next, expression(node.right, next));
      const read = reads.get(node);
      if (read) {
        const property = node.type === "MemberExpression" && node.computed ? unwrap(node.property) : undefined;
        const permanentlyOwned = property?.type === "Identifier" && enumerated.has(symbol(property)?.id ?? "")
          && node.type === "MemberExpression" && JSON.stringify(path(node.object)) === registry;
        next = block([next], [...(permanentlyOwned ? [event(node, "guard", read)] : []), event(node, "read", read)]);
      }
      else if ((node.type === "CallExpression" && !ownGuard(node)) || node.type === "NewExpression" || node.type === "AwaitExpression"
        || node.type === "AssignmentExpression" || node.type === "UpdateExpression" || node.type === "YieldExpression"
        // Iteration, spreading, and coercion can invoke user code that changes the key or table.
        || node.type === "SpreadElement" || node.type === "BinaryExpression"
        || node.type === "UnaryExpression" && node.operator !== "!"
        || node.type === "MemberExpression" && !isDataPath(node)) next = invalidate(node, next);
      const children = oxcChildren(node);
      for (let index = children.length - 1; index >= 0; index--) next = expression(children[index]!, next);
      return next;
    };
    const condition = (input: Node, whenTrue: string, whenFalse: string): string => {
      const node = unwrap(input);
      if (node.type === "UnaryExpression" && node.operator === "!") return condition(node.argument, whenFalse, whenTrue);
      if (node.type === "LogicalExpression" && node.operator === "&&") return condition(node.left, condition(node.right, whenTrue, whenFalse), whenFalse);
      if (node.type === "LogicalExpression" && node.operator === "||") return condition(node.left, whenTrue, condition(node.right, whenTrue, whenFalse));
      const guard = ownGuard(node);
      const positive = guard ? block([whenTrue], [event(node, "guard", guard)]) : whenTrue;
      return expression(node, block([positive, whenFalse]));
    };
    let entry: string;
    // Analyze only expressions containing selected reads. Other statements cannot
    // supply facts; their reachability and effects are outside this policy's scope.
    if (options.flow === "statement") {
      entry = lowerRegistryStatements(fn.body, { block, expression, condition, invalidate,
        connect: (from, to) => { blocks.find(item => item.id === from)!.successors.push(to); },
        unsupported: (node, message) => { throw new Unsupported(node, message); },
      });
    } else {
      entry = block([]);
      for (const root of [...new Set(owner.values())].reverse()) entry = invalidate(root, expression(root, entry));
    }
    const cfg: RuleCfg = { entry, blocks };
    return { status: "lowered", cfg };
  } catch (error) {
    if (error instanceof Unsupported) return { status: "unknown", reason: "unsupported-source", detail: error.message, location: location(error.node) };
    if (error instanceof TypeError) return { status: "unknown", reason: "invalid-input", detail: error.message };
    throw error;
  }
}
