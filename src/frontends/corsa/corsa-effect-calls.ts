import { parseSync, type Node } from "oxc-parser";
import { oxcChildren } from "../oxc/source.js";
import { receiverTokenPosition } from "../oxc-syntax.js";

/** Compiler `TypeFlags` values, measured against the analyzing compiler and pinned in `corsa-source-facts.test.ts`. */
const anyTypeFlag = 1;
const unknownTypeFlag = 2;
const unionTypeFlag = 134217728;
/** String, Number, BigInt, Boolean, Symbol, Undefined, Null and Void, including their literal types. */
const primitiveTypeFlags = 4 | 8 | 16 | 32 | 64 | 128 | 512 | 1024 | 2048 | 8192;
const intersectionTypeFlag = 268435456;
import type { CorsaApiFrontend, CorsaApiTypeFact } from "./corsa-api-frontend.js";
import { collectFrozenEffectTables } from "./corsa-effect-tables.js";

export interface CorsaClassFact {
  readonly symbolId: string;
  /** Checker identity of the class the `extends` clause names, when it names one this path can resolve. */
  readonly superSymbolId: string | null;
  /** `false` when an `extends` clause is present but names something other than a resolvable identifier. */
  readonly superResolvable: boolean;
  /** Key position of the declared constructor, or `null` when the class declares none. */
  readonly constructorPosition: number | null;
  readonly bodyStart: number;
  /**
   * The class declares a `private`, `protected` or `#` member, which makes its type nominal: TypeScript accepts
   * only that class and its subclasses, so no object literal can stand in for an instance.
   */
  readonly nominal: boolean;
}

export interface CorsaMethodFact {
  /** Checker declaration identity, the same string a member resolved through a receiver type reports. */
  readonly declaration: string;
  readonly position: number;
  readonly classSymbolId: string;
  readonly name: string;
  /**
   * A `#`-private member, or one TypeScript marks `private`: no subclass may redeclare it and no code outside
   * the class body may write it, so its body is fixed without any whole-program reasoning.
   */
  readonly restricted: boolean;
}

/** Native identities link bodies; shorthand writes conservatively exclude same-name candidates. */
export function collectCorsaEffectBindings(frontend: CorsaApiFrontend, file: string, text: string): {
  declarations: Array<{ symbolId: string; start: number; name: string }>;
  writes: Set<string>;
  ambiguousWrites: Set<string>;
  calls: Map<number, string>;
  parameters: Array<{ symbolId: string; name: string; position: number; index: number }>;
  classes: CorsaClassFact[];
  /** Receiver type identity to the member names written through it, which no class declaration is trusted over. */
  assignedMembers: Map<string, Set<string>>;
  /** Receiver type identities written under a computed key, where no member name of that type is trustworthy. */
  computedMemberOwners: Set<string>;
  /** Member names written through a receiver whose type this path could not name. */
  opaquelyAssignedNames: Set<string>;
  /** Receiver types of computed member writes this path could not attribute to one declaration. */
  opaqueComputedWriteTypes: CorsaApiTypeFact[];
  /** `true` when a member write has a receiver the checker reports no type for at all. */
  untypedMemberWrite: boolean;
  /** A class body this path cannot identify, or one whose `extends` clause it cannot resolve, may override anything. */
  opaqueSubclass: boolean;
  /** Declaration files of every statically imported binding, to decide whether the analyzed set is closed. */
  importedDeclarationFiles: Set<string>;
  methods: CorsaMethodFact[];
  /** Call-expression start offset of `super(...)`, to the class whose `extends` clause names the base. */
  superCalls: Map<number, string>;
  /** Call-expression start offset of `super.member(...)`, to the same class and the member it names. */
  superMemberCalls: Map<number, { classSymbolId: string; name: string }>;
  /** Call-expression start offsets whose receiver is `this`. */
  thisCalls: Set<number>;
} {
  const parsed = parseSync(file, text, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const declarations: Array<{ symbolId: string; start: number; name: string }> = [];
  const writes = new Set<string>();
  const ambiguousWrites = new Set<string>();
  const calls = new Map<number, string>();
  const parameters: Array<{ symbolId: string; name: string; position: number; index: number }> = [];
  const classes: CorsaClassFact[] = [];
  const assignedMembers = new Map<string, Set<string>>();
  const computedMemberOwners = new Set<string>();
  const importedDeclarationFiles = new Set<string>();
  const opaquelyAssignedNames = new Set<string>();
  const opaqueComputedWriteTypes: CorsaApiTypeFact[] = [];
  let untypedMemberWrite = false;
  let opaqueSubclass = false;
  const methods: CorsaMethodFact[] = [];
  const superCalls = new Map<number, string>();
  const superMemberCalls = new Map<number, { classSymbolId: string; name: string }>();
  const thisCalls = new Set<number>();
  const classFacts = () => ({
    classes, methods, superCalls, superMemberCalls, thisCalls, assignedMembers, computedMemberOwners,
    importedDeclarationFiles, opaquelyAssignedNames, opaqueComputedWriteTypes, untypedMemberWrite, opaqueSubclass,
  });
  if (parsed.errors.length) return { declarations, writes, ambiguousWrites, calls, parameters, ...classFacts() };
  /**
   * Whether the value an assignment stores could be a function. A member write can only replace a method with
   * one, so a write of a primitive leaves every declared body standing. `any` and `unknown` could be anything.
   */
  const callableValue = (value: Node | null | undefined): boolean => {
    if (!value || typeof value.start !== "number") return true;
    const type = frontend.getTypeAtPosition(file, value.start);
    const flags = type?.flags;
    if (typeof flags !== "number") return true;
    if ((flags & (anyTypeFlag | unknownTypeFlag)) !== 0) return true;
    return (flags & primitiveTypeFlags) === 0;
  };
  const recordWrite = (node: Node, shorthand = false, callable = true): void => {
    if (node.type === "Identifier") {
      const symbol = frontend.getSymbolAtPosition(file, node.start);
      if (symbol) writes.add((frontend.getAliasedSymbol(symbol) ?? symbol).id);
      // At a shorthand target, the position query can return the property symbol,
      // not the binding being assigned. Never use that as evidence of no write.
      if (shorthand) ambiguousWrites.add(node.name);
    } else if (node.type === "MemberExpression") {
      if (!callable) return;
      // `C.prototype.m = f` and `this.m = f` replace a body a class declaration would otherwise fix. The write
      // is attributed to the receiver's own type, so only that type's methods stop being trustworthy.
      const object = node.object as unknown as Parameters<typeof receiverTokenPosition>[0];
      const receiver = receiverTokenPosition(object) ?? node.object.start;
      const type = frontend.getTypeAtPosition(file, receiver);
      const owner = type ? frontend.getSymbolOfType(type) : null;
      if (owner === null) {
        // A receiver with no type symbol is only a class instance when the checker could not name one type for
        // it: `any`, `unknown`, a union, or an intersection. Anything else — a primitive, an anonymous object —
        // is no class, so the write cannot replace a method a class declaration fixes. A named member still
        // names which method could have been replaced; only a computed key leaves every name in doubt.
        if (type === null) { untypedMemberWrite = true; return; }
        if ((type.flags ?? 0) & (anyTypeFlag | unknownTypeFlag | unionTypeFlag | intersectionTypeFlag)) {
          if (!node.computed && (node.property.type === "Identifier" || node.property.type === "PrivateIdentifier")) {
            opaquelyAssignedNames.add(node.property.name);
          } else opaqueComputedWriteTypes.push(type);
        }
        return;
      }
      if (node.computed) computedMemberOwners.add(owner.id);
      else if (node.property.type === "Identifier" || node.property.type === "PrivateIdentifier") {
        const written = assignedMembers.get(owner.id) ?? new Set<string>();
        written.add(node.property.name);
        assignedMembers.set(owner.id, written);
      }
    } else {
      for (const child of oxcChildren(node)) recordWrite(child, shorthand || node.type === "Property" && node.shorthand, callable);
    }
  };
  let dynamicScope = false;
  const visit = (node: Node): void => {
    if (node.type === "AssignmentExpression") recordWrite(node.left, false, callableValue(node.right));
    // An update writes a number back, which cannot stand in for a method.
    if (node.type === "UpdateExpression") recordWrite(node.argument, false, false);
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
  const collectClasses = (node: Node, enclosing: string | null): void => {
    let current = enclosing;
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && !("declare" in node && node.declare === true)) {
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
      // A class body with no identity of its own, one whose base this path cannot name, and one a decorator may
      // replace are each a subclass that could be overriding anything, so no class keeps a fixed method body.
      if (heritage && (symbolId === null || !superResolvable)) opaqueSubclass = true;
      if (Array.isArray(node.decorators) && node.decorators.length > 0) opaqueSubclass = true;
      if (symbolId !== null) {
        const members = node.body.body;
        const declared = members.find((member) => member.type === "MethodDefinition" && member.kind === "constructor");
        const nominal = members.some((member) =>
          ("accessibility" in member && (member.accessibility === "private" || member.accessibility === "protected"))
          || ("key" in member && member.key?.type === "PrivateIdentifier"));
        classes.push({
          symbolId,
          superSymbolId,
          superResolvable,
          constructorPosition: declared && declared.type === "MethodDefinition" ? declared.key.start : null,
          bodyStart: node.body.start,
          nominal,
        });
        current = symbolId;
        for (const member of members) {
          if (member.type !== "MethodDefinition" || member.computed || member.kind !== "method" || member.static) continue;
          if (member.key.type !== "Identifier" && member.key.type !== "PrivateIdentifier") continue;
          // A decorator's return value replaces the method, so the declared body is not the one that runs.
          if (Array.isArray(member.decorators) && member.decorators.length > 0) continue;
          const method = frontend.getSymbolAtPosition(file, member.key.start);
          const declaration = method?.declarations?.length === 1 ? method.declarations[0]! : undefined;
          const restricted = member.key.type === "PrivateIdentifier"
            || ("accessibility" in member && member.accessibility === "private");
          if (declaration !== undefined) {
            methods.push({ declaration, position: member.key.start, classSymbolId: symbolId, name: member.key.name, restricted });
          }
        }
      }
    }
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        const imported = frontend.getSymbolAtPosition(file, specifier.local.start);
        const target = imported ? frontend.getAliasedSymbol(imported) ?? imported : null;
        for (const declaration of target?.declarations ?? []) importedDeclarationFiles.add(declaration);
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "Super") {
        if (current !== null) superCalls.set(node.start, current);
      } else if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        if (callee.object.type === "Super") {
          if (current !== null) superMemberCalls.set(node.start, { classSymbolId: current, name: callee.property.name });
        } else if (callee.object.type === "ThisExpression" && current !== null) thisCalls.add(node.start);
      }
    }
    for (const child of oxcChildren(node)) collectClasses(child, current);
  };
  collectClasses(parsed.program, null);
  return { declarations, writes, ambiguousWrites, calls: frozen.calls, parameters, ...classFacts() };
}
