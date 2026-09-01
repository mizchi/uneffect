import type { RefinementBindingManifest } from "../src/refinement-bindings.js";
import type { TemporalSpec } from "../src/spec-ir.js";
import ts from "typescript";

/** Explicit test-fixture manifest; never parses source comments. */
export function refinementManifest(
  fileName: string,
  adapterName: string,
  actions: Readonly<Record<string, string>>,
  options: {
    create?: string;
    observe?: string;
    abstractions?: Readonly<Record<string, string>>;
    invariants?: Readonly<Record<string, string>>;
  } = {},
): RefinementBindingManifest {
  return {
    schema: "uneffect-refinement-bindings/v1",
    fileName,
    adapterName,
    version: "1",
    create: options.create ?? "create",
    observe: options.observe ?? "observe",
    abstractions: { ...options.abstractions },
    actions: { ...actions },
    invariants: { ...options.invariants },
  };
}

/** Infers only unambiguous test-fixture bindings from exported function names. */
export function generatedRefinementManifest(
  fileName: string,
  source: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementBindingManifest {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exportedFunctions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name !== undefined
      && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true);
  const names = new Set(exportedFunctions.map((declaration) => declaration.name!.text));
  const selectRole = (role: "create" | "observe"): string => {
    if (names.has(role)) return role;
    const matches = [...names].filter((name) => name.toLowerCase().startsWith(role));
    if (matches.length !== 1) throw new Error(`${fileName}: generated ${role} binding is ambiguous`);
    return matches[0]!;
  };
  const create = selectRole("create"), observe = selectRole("observe");
  const reserved = new Set([create, observe]);
  const actions: Record<string, string> = {};
  const invariants: Record<string, string> = {};
  const unresolvedActions: string[] = [], unresolvedInvariants: string[] = [];
  for (const { name } of spec.actions) {
    if (names.has(name)) { actions[name] = name; reserved.add(name); }
    else unresolvedActions.push(name);
  }
  for (const { name } of spec.properties) {
    if (names.has(name)) { invariants[name] = name; reserved.add(name); }
    else unresolvedInvariants.push(name);
  }
  const remaining = () => [...names].filter((candidate) => !reserved.has(candidate));
  if (unresolvedActions.length === 1 && remaining().length === 1 && unresolvedInvariants.length === 0) {
    actions[unresolvedActions[0]!] = remaining()[0]!;
    reserved.add(remaining()[0]!);
  }
  if (unresolvedInvariants.length === 1 && remaining().length === 1 && unresolvedActions.length === 0) {
    invariants[unresolvedInvariants[0]!] = remaining()[0]!;
    reserved.add(remaining()[0]!);
  }
  return refinementManifest(fileName, adapterName, actions, { create, observe, invariants });
}
