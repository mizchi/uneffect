import { parseSync, type Node } from "oxc-parser";
import { oxcChildren, oxcLanguage } from "../oxc/source.js";

/** The seven error constructors the effect language names; anything else is spelled `Throw<unknown>`. */
const ecmaScriptErrorConstructors = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);
const ecmaScriptLibraryFile = /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/i;
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
  /** The class's own name, which is the term a `Throw<E>` of it is spelled with. */
  readonly name: string | null;
  /**
   * The class extends one of the seven ECMAScript error constructors directly. A chain of user classes is
   * resolved by the consumer, which holds every class this run read rather than only this file's.
   */
  readonly extendsEcmaScriptError: boolean;
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
  /**
   * `const a = b` with `b` a bare identifier, from the alias's symbol to the one `b` resolves to. The alias holds
   * whatever `b` held when it was initialized, so it names `b`'s body exactly when `b` itself does.
   */
  aliases: Array<{ symbolId: string; targetSymbolId: string }>;
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
   * Class declarations whose body evaluates something when the DECLARATION is evaluated rather than when an
   * instance is constructed, and the exact spans of that work. The construction boundary a sibling instance
   * initializer opens covers the whole body, so it would otherwise absorb every site inside those spans. The
   * spans are published rather than the class alone, because they are what distinguishes a site the region
   * evaluates from a function body merely written inside it, which runs only when it is called.
   */
  staticInitializers: Array<{ declaration: number; regions: Array<{ start: number; end: number }> }>;
  /**
   * One entry per decorator, keyed by the declaration offset of the class that carries it. Applying a decorator
   * invokes it, and no call expression spells that invocation: `@deco m() {}` records nothing at all, and
   * `@deco()` records the factory rather than the application of what it returns. The scope that declares the
   * class performs the application, so it is charged there.
   *
   * `symbolId` is the decorator's own symbol, and only a bare identifier has one — that is the form where the
   * value being applied IS the named function, so the scope can be linked to its body. Any other form (a
   * factory call, a member expression) applies a value this path cannot name, and the scope is unresolved.
   */
  decoratorApplications: Array<{ declaration: number; symbolId: string | null }>;
  /**
   * Members carrying a decorator, by the offset their syntax boundary starts at. A decorator's return value
   * replaces the member, so the declared body is not necessarily the one that runs — its own summary is a claim
   * about a name whose behaviour at runtime this path did not read.
   */
  decoratedMembers: number[];
} {
  const parsed = parseSync(file, text, { lang: oxcLanguage(file) });
  const declarations: Array<{ symbolId: string; start: number; name: string }> = [];
  const aliases: Array<{ symbolId: string; targetSymbolId: string }> = [];
  const writes = new Set<string>();
  const ambiguousWrites = new Set<string>();
  const calls = new Map<number, string>();
  const parameters: Array<{ symbolId: string; name: string; position: number; index: number }> = [];
  const classes: CorsaClassFact[] = [];
  const methods: CorsaMethodFact[] = [];
  const superCalls = new Map<number, string>();
  const privateCalls = new Map<number, string>();
  const staticInitializers: Array<{ declaration: number; regions: Array<{ start: number; end: number }> }> = [];
  const decoratorApplications: Array<{ declaration: number; symbolId: string | null }> = [];
  const decoratedMembers: number[] = [];
  const classFacts = () => ({
    classes, methods, superCalls, privateCalls, staticInitializers, decoratorApplications, decoratedMembers,
  });
  if (parsed.errors.length) return { declarations, aliases, writes, ambiguousWrites, calls, parameters, ...classFacts() };
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
  if (dynamicScope) return { declarations, aliases, writes, ambiguousWrites, calls, parameters, ...classFacts() };
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
        if (init.type === "Identifier") {
          const alias = frontend.getSymbolAtPosition(file, declarator.id.start);
          const target = frontend.getSymbolAtPosition(file, init.start);
          if (alias?.declarations?.length === 1 && target) {
            aliases.push({ symbolId: alias.id, targetSymbolId: (frontend.getAliasedSymbol(target) ?? target).id });
          }
          continue;
        }
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
      let extendsEcmaScriptError = false;
      if (heritage && heritage.type === "Identifier") {
        const base = frontend.getSymbolAtPosition(file, heritage.start);
        if (base) {
          const resolved = frontend.getAliasedSymbol(base) ?? base;
          superSymbolId = resolved.id;
          superResolvable = true;
          extendsEcmaScriptError = ecmaScriptErrorConstructors.has(resolved.name)
            && (resolved.declarations ?? []).some((item) => ecmaScriptLibraryFile.test(item));
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
      const definitionTimeRegions: Array<{ start: number; end: number }> = [];
      const region = (value: unknown): void => {
        const item = value as { start?: unknown; end?: unknown } | null | undefined;
        if (!item || typeof item.start !== "number" || typeof item.end !== "number") return;
        definitionTimeRegions.push({ start: item.start, end: item.end });
      };
      /**
       * A parameter decorator is applied when the declaration is evaluated like any other, but it is written on
       * the parameter rather than on the member, so reading `member.decorators` alone misses it entirely. The
       * span is inside the method's own boundary, which would otherwise charge the application to every call of
       * that method — and to every construction, for a constructor parameter.
       */
      const parameterDecorators = (member: unknown): readonly unknown[] => {
        const params = ((member as { value?: { params?: unknown } }).value)?.params;
        if (!Array.isArray(params)) return [];
        // A `private dep` parameter property carries its decorators on the property node, not on the name it wraps.
        return params.flatMap((param: { decorators?: unknown }) =>
          Array.isArray(param?.decorators) ? param.decorators : []);
      };
      const applied = (decorator: unknown): void => {
        const expression = (decorator as { expression?: { type?: string; start?: number } } | null)?.expression;
        const symbol = expression?.type === "Identifier" && typeof expression.start === "number"
          ? frontend.getSymbolAtPosition(file, expression.start) : null;
        const resolved = symbol === null ? null : frontend.getAliasedSymbol(symbol) ?? symbol;
        decoratorApplications.push({ declaration: node.start, symbolId: resolved?.id ?? null });
      };
      for (const decorator of (Array.isArray(node.decorators) ? node.decorators : [])) applied(decorator);
      let decorated = Array.isArray(node.decorators) && node.decorators.length > 0;
      for (const member of node.body.body) {
        if (member.type === "StaticBlock") region(member);
        if ((member.type === "PropertyDefinition" || member.type === "AccessorProperty") && member.static && member.value !== null) region(member.value);
        if ("decorators" in member && Array.isArray(member.decorators)) for (const decorator of member.decorators) region(decorator);
        for (const decorator of parameterDecorators(member)) region(decorator);
        if ("computed" in member && member.computed === true && "key" in member) region(member.key);
        const decoratedMember = ("decorators" in member && Array.isArray(member.decorators) && member.decorators.length > 0)
          || parameterDecorators(member).length > 0;
        if (decoratedMember) decoratedMembers.push(member.start);
        if (decoratedMember) {
          for (const decorator of ("decorators" in member && Array.isArray(member.decorators) ? member.decorators : [])) applied(decorator);
          for (const decorator of parameterDecorators(member)) applied(decorator);
        }
        decorated ||= decoratedMember;
      }
      // Published whenever the body evaluates anything, not only when an instance initializer widens the
      // construction boundary over it. A decorated member's own boundary starts at its `@` token, so a
      // decorator factory's call already sits inside a boundary that runs per call without any widening.
      if (definitionTimeRegions.length > 0) {
        staticInitializers.push({ declaration: node.start, regions: definitionTimeRegions });
      }
      if (symbolId !== null) {
        const members = node.body.body;
        const span = constructionBoundarySpan(node.body as unknown as Parameters<typeof constructionBoundarySpan>[0]);
        classes.push({
          symbolId,
          superSymbolId,
          superResolvable,
          constructionSpan: span === undefined ? null : span,
          declaresConstructor: declaredConstructor(node.body as unknown as Parameters<typeof declaredConstructor>[0]) !== undefined,
          linkable: !decorated,
          name: id?.type === "Identifier" && typeof id.name === "string" ? id.name : null,
          extendsEcmaScriptError,
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
  return { declarations, aliases, writes, ambiguousWrites, calls: frozen.calls, parameters, ...classFacts() };
}
