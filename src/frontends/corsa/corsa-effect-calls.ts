import { parseSync, type Node } from "oxc-parser";
import { oxcChildren } from "../oxc/source.js";
import type { CorsaApiFrontend } from "./corsa-api-frontend.js";
import { collectFrozenEffectTables } from "./corsa-effect-tables.js";
import { constructionBoundarySpan, declaredConstructor } from "../oxc-syntax.js";

export interface CorsaClassFact {
  readonly symbolId: string;
  /** Checker identity of the class the `extends` clause names, when it names one this path can resolve. */
  readonly superSymbolId: string | null;
  /** `false` when an `extends` clause is present but names something other than a resolvable identifier. */
  readonly superResolvable: boolean;
  /** Span of the boundary a construction runs, or `null` when a construction runs nothing of this class's own. */
  readonly constructionSpan: { readonly start: number; readonly end: number } | null;
  /** The class declares its own constructor, which is what reaches the base through its own `super(...)`. */
  readonly declaresConstructor: boolean;
  /**
   * `false` when a decorator on the class or on one of its members can replace what a construction runs, so the
   * declared bodies are not the ones that run.
   */
  readonly linkable: boolean;
}

export interface CorsaMethodFact {
  /** Checker declaration identity, the same string a member resolved through a receiver type reports. */
  readonly declaration: string;
  readonly position: number;
  readonly classSymbolId: string;
  readonly name: string;
  /**
   * A `#`-private method. The name is not a property, so no subclass redeclares it, no code outside the class
   * body writes it, and `Object.assign`, `Object.defineProperty` and `delete` cannot reach it either.
   */
  readonly hardPrivate: boolean;
}

/** Native identities link bodies; shorthand writes conservatively exclude same-name candidates. */
export function collectCorsaEffectBindings(frontend: CorsaApiFrontend, file: string, text: string): {
  declarations: Array<{ symbolId: string; start: number; name: string }>;
  writes: Set<string>;
  ambiguousWrites: Set<string>;
  calls: Map<number, string>;
  parameters: Array<{ symbolId: string; name: string; position: number; index: number }>;
  classes: CorsaClassFact[];
  methods: CorsaMethodFact[];
  /** Call-expression start offset of `super(...)`, to the class whose `extends` clause names the base. */
  superCalls: Map<number, string>;
  /**
   * Position of the `#member` token of a `this.#member(...)` call, to that method's checker declaration
   * identity. The call expression's own start is shared with every call chained onto it, so it cannot identify
   * this site; the member token is the position a call site reports as its callee.
   */
  privateCalls: Map<number, string>;
  /**
   * Start offsets of class declarations whose body has a static block or a static field initializer. Those run
   * when the declaration is evaluated, not at construction, and the construction boundary a sibling instance
   * initializer opens would otherwise absorb them.
   */
  staticInitializers: number[];
} {
  const parsed = parseSync(file, text, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const declarations: Array<{ symbolId: string; start: number; name: string }> = [];
  const writes = new Set<string>();
  const ambiguousWrites = new Set<string>();
  const calls = new Map<number, string>();
  const parameters: Array<{ symbolId: string; name: string; position: number; index: number }> = [];
  const classes: CorsaClassFact[] = [];
  const methods: CorsaMethodFact[] = [];
  const superCalls = new Map<number, string>();
  const privateCalls = new Map<number, string>();
  const staticInitializers: number[] = [];
  const classFacts = () => ({
    classes, methods, superCalls, privateCalls, staticInitializers,
  });
  if (parsed.errors.length) return { declarations, writes, ambiguousWrites, calls, parameters, ...classFacts() };
  const recordWrite = (node: Node, shorthand = false): void => {
    if (node.type === "Identifier") {
      const symbol = frontend.getSymbolAtPosition(file, node.start);
      if (symbol) writes.add((frontend.getAliasedSymbol(symbol) ?? symbol).id);
      // At a shorthand target, the position query can return the property symbol,
      // not the binding being assigned. Never use that as evidence of no write.
      if (shorthand) ambiguousWrites.add(node.name);
    } else if (node.type !== "MemberExpression") {
      for (const child of oxcChildren(node)) recordWrite(child, shorthand || node.type === "Property" && node.shorthand);
    }
  };
  let dynamicScope = false;
  const visit = (node: Node): void => {
    if (node.type === "AssignmentExpression") recordWrite(node.left);
    if (node.type === "UpdateExpression") recordWrite(node.argument);
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") recordWrite(node.left);
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval") dynamicScope = true;
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(parsed.program);
  if (dynamicScope) return { declarations, writes, ambiguousWrites, calls, parameters, ...classFacts() };
  // A plain identifier parameter is the one shape whose value is exactly what one argument position supplies.
  // A default, a rest element, a binding pattern, and a parameter property each stand for something else, so
  // invoking them stays an unresolved site rather than an obligation on a caller.
  const collectParameters = (node: Node): void => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      // A TypeScript `this` parameter occupies a slot in the parameter list but no argument position.
      const params = node.params[0]?.type === "Identifier" && node.params[0].name === "this" ? node.params.slice(1) : node.params;
      for (const [index, parameter] of params.entries()) {
        if (parameter.type !== "Identifier") continue;
        const symbol = frontend.getSymbolAtPosition(file, parameter.start);
        if (symbol?.declarations?.length === 1) parameters.push({ symbolId: symbol.id, name: parameter.name, position: parameter.start, index });
      }
    }
    for (const child of oxcChildren(node)) collectParameters(child);
  };
  collectParameters(parsed.program);
  // A binding links a caller only when its body is unique and its identity cannot change: a function
  // declaration, or a `const` bound once to an inline function. An async or generator boundary converts a
  // throw into a rejection, which this path does not model, so those bodies are left unresolved.
  const declare = (id: { start: number; name: string }, bodyStart: number): void => {
    const symbol = frontend.getSymbolAtPosition(file, id.start);
    if (symbol?.declarations?.length === 1) declarations.push({ symbolId: symbol.id, start: bodyStart, name: id.name });
  };
  const collectDeclarations = (node: Node): void => {
    if (node.type === "FunctionDeclaration" && node.id && node.body && !node.async && !node.generator) {
      declare(node.id, node.start);
    }
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declarator of node.declarations) {
        const init = declarator.init;
        if (declarator.id.type !== "Identifier" || !init) continue;
        if ((init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") || init.async || init.generator) continue;
        declare(declarator.id, init.start);
      }
    }
    for (const child of oxcChildren(node)) collectDeclarations(child);
  };
  collectDeclarations(parsed.program);
  const frozen = collectFrozenEffectTables(frontend, file, parsed.program);
  declarations.push(...frozen.declarations);
  // Construction and dispatch inside a class body are statically determined: `new C` runs `C`'s constructor,
  // `super` names the base the `extends` clause resolves to, and `this` is an instance of the class or of a
  // subclass. An ambient class declares no body to analyze, so it is not collected at all.
  // A `#` name is scoped to the class body that declares it, so two classes in one file may both declare `#m`.
  // The key is therefore the declaring class's identity together with the name.
  const privateMethodDeclarations = new Map<string, string>();
  const collectClasses = (node: Node, enclosing: string | null): void => {
    let current = enclosing;
    const isClassNode = node.type === "ClassDeclaration" || node.type === "ClassExpression";
    if (isClassNode && !("declare" in node && node.declare === true)) {
      const id = node.id;
      const symbol = id ? frontend.getSymbolAtPosition(file, id.start) : null;
      const symbolId = symbol?.declarations?.length === 1 ? symbol.id : null;
      const heritage = node.superClass;
      let superSymbolId: string | null = null;
      let superResolvable = !heritage;
      if (heritage && heritage.type === "Identifier") {
        const base = frontend.getSymbolAtPosition(file, heritage.start);
        if (base) {
          superSymbolId = (frontend.getAliasedSymbol(base) ?? base).id;
          superResolvable = true;
        }
      }
      // Entering any class body changes which `#` names and which base constructor are in scope. A class this
      // path cannot identify therefore resets the scope to nothing rather than leaving the enclosing class's,
      // which would link `this.#m()` and `super()` inside it to the wrong body.
      current = symbolId;
      // Everything a class body evaluates when the DECLARATION is evaluated rather than when an instance is
      // constructed: a static block, a static initializer, every decorator expression, and every computed
      // member key. The construction boundary covers the whole class body once an instance initializer widens
      // it, so it would absorb all of these; the scope that declares the class is unresolved instead.
      const definitionTime = node.body.body.some((member) =>
        member.type === "StaticBlock"
        || ((member.type === "PropertyDefinition" || member.type === "AccessorProperty") && member.static && member.value !== null)
        || ("decorators" in member && Array.isArray(member.decorators) && member.decorators.length > 0)
        || ("computed" in member && member.computed === true));
      const widened = constructionBoundarySpan(node.body as unknown as Parameters<typeof constructionBoundarySpan>[0]);
      if (definitionTime && widened !== undefined && widened.start === node.body.start) staticInitializers.push(node.start);
      if (symbolId !== null) {
        const members = node.body.body;
        const decorated = (Array.isArray(node.decorators) && node.decorators.length > 0)
          || members.some((member) => "decorators" in member && Array.isArray(member.decorators) && member.decorators.length > 0);
        const span = constructionBoundarySpan(node.body as unknown as Parameters<typeof constructionBoundarySpan>[0]);
        classes.push({
          symbolId,
          superSymbolId,
          superResolvable,
          constructionSpan: span === undefined ? null : span,
          declaresConstructor: declaredConstructor(node.body as unknown as Parameters<typeof declaredConstructor>[0]) !== undefined,
          linkable: !decorated,
        });
        for (const member of members) {
          if (member.type !== "MethodDefinition" || member.computed || member.kind !== "method" || member.static) continue;
          if (member.key.type !== "PrivateIdentifier") continue;
          // A decorator's return value replaces the method, so the declared body is not the one that runs.
          if (Array.isArray(member.decorators) && member.decorators.length > 0) continue;
          const method = frontend.getSymbolAtPosition(file, member.key.start);
          const declaration = method?.declarations?.length === 1 ? method.declarations[0]! : undefined;
          if (declaration !== undefined) {
            methods.push({ declaration, position: member.key.start, classSymbolId: symbolId, name: member.key.name, hardPrivate: true });
            privateMethodDeclarations.set(`${symbolId}#${member.key.name}`, declaration);
          }
        }
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "Super") {
        if (current !== null) superCalls.set(node.start, current);
      } else if (callee.type === "MemberExpression" && !callee.computed
        && callee.property.type === "PrivateIdentifier" && callee.object.type === "ThisExpression") {
        const declaration = current === null ? undefined : privateMethodDeclarations.get(`${current}#${callee.property.name}`);
        if (declaration !== undefined) privateCalls.set(callee.property.start, declaration);
      }
    }
    if (isClassNode && Array.isArray(node.decorators) && node.decorators.length > 0) {
      // A class decorator is evaluated before the class is defined, in the scope that declares it: its `#`
      // names and its `super` are the enclosing ones, not this class's.
      for (const decorator of node.decorators) collectClasses(decorator, enclosing);
      for (const child of oxcChildren(node)) {
        if (node.decorators.some((decorator) => decorator === child)) continue;
        collectClasses(child, current);
      }
      return;
    }
    for (const child of oxcChildren(node)) collectClasses(child, current);
  };
  collectClasses(parsed.program, null);
  return { declarations, writes, ambiguousWrites, calls: frozen.calls, parameters, ...classFacts() };
}
