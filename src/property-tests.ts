import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, posix } from "node:path";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { parseLogicExpression } from "./invariant-ir.js";

export type PropertyBoundaryKind = "Int" | "Nat" | "U8" | "U32" | "I32";

export interface PropertyTestBoundary {
  fileName: string;
  functionName: string;
  generators: PropertyBoundaryKind[];
  shrinkers: PropertyBoundaryKind[];
  requires: string[];
  ensures: string[];
}

export interface GenerateUneffectPropertyTestsOptions {
  files: Record<string, string>;
  backend?: "quickcheck";
  shrinking?: boolean;
  cases?: number;
  seed?: number;
}

export interface GenerateUneffectPropertyTestsResult {
  generatedFiles: Record<string, string>;
  boundaries: PropertyTestBoundary[];
  diagnostics: Array<{ fileName: string; functionName: string; message: string }>;
}

export interface PropertyCounterexample {
  version: "uneffect-counterexample/v1";
  functionName: string;
  arguments: number[];
  seed: number;
}

export interface CheckUneffectPropertyOptions {
  functionName: string;
  domains: readonly PropertyBoundaryKind[];
  property: (...values: number[]) => boolean | Promise<boolean>;
  precondition?: (...values: number[]) => boolean;
  cases?: number;
  seed?: number;
  shrinking?: boolean;
  counterexamplePath?: string;
}

export interface CheckUneffectPropertyResult {
  status: "passed" | "counterexample";
  counterexample?: PropertyCounterexample;
  replayed: boolean;
  tested: number;
}

interface InternalBoundary extends PropertyTestBoundary { parameters: string[] }

const supported = new Set<PropertyBoundaryKind>(["Int", "Nat", "U8", "U32", "I32"]);
const edgeValues: Record<PropertyBoundaryKind, readonly number[]> = {
  Int: [0, 1, -1, 2, -2, 2_147_483_647, -2_147_483_648], Nat: [0, 1, 2, 255, 65_535],
  U8: [0, 1, 2, 254, 255], U32: [0, 1, 2, 4_294_967_294, 4_294_967_295], I32: [0, 1, -1, 2_147_483_647, -2_147_483_648],
};

function shrinkNumber(value: number, domain: PropertyBoundaryKind): number[] {
  const values: number[] = [];
  let current = value;
  while (Math.abs(current) > 1) { current = Math.trunc(current / 2); values.push(current); }
  values.push(0);
  return [...new Set(values)].filter((candidate) => domain !== "Nat" && domain !== "U8" && domain !== "U32" || candidate >= 0);
}

function makeSamples(domains: readonly PropertyBoundaryKind[], cases: number, seed: number): number[][] {
  const samples: number[][] = [];
  const visit = (index: number, values: number[]): void => {
    if (samples.length >= cases) return;
    if (index === domains.length) { samples.push(values); return; }
    for (const value of edgeValues[domains[index]!]!) visit(index + 1, [...values, value]);
  };
  visit(0, []);
  let state = seed >>> 0;
  const random = (): number => ((state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 0x1_0000_0000);
  while (samples.length < cases) samples.push(domains.map((domain) => edgeValues[domain][Math.floor(random() * edgeValues[domain].length)]!));
  return samples;
}

/** Runs generated-test semantics, minimizes failures, and optionally persists a replay artifact. */
export async function checkUneffectProperty(options: CheckUneffectPropertyOptions): Promise<CheckUneffectPropertyResult> {
  const seed = options.seed ?? 0x5eed, precondition = options.precondition ?? (() => true);
  let replay: PropertyCounterexample | undefined;
  if (options.counterexamplePath) {
    try { replay = JSON.parse(await readFile(options.counterexamplePath, "utf8")) as PropertyCounterexample; } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const samples = [...(replay?.functionName === options.functionName ? [replay.arguments] : []), ...makeSamples(options.domains, options.cases ?? 100, seed)];
  let tested = 0;
  for (const sample of samples) {
    if (!precondition(...sample)) continue;
    tested++;
    if (await options.property(...sample)) continue;
    const minimal = [...sample];
    if (options.shrinking !== false) for (let index = 0; index < minimal.length; index++) {
      for (const value of shrinkNumber(minimal[index]!, options.domains[index]!)) {
        const candidate = minimal.with(index, value);
        if (precondition(...candidate) && !(await options.property(...candidate))) minimal[index] = value;
      }
    }
    const counterexample: PropertyCounterexample = { version: "uneffect-counterexample/v1", functionName: options.functionName, arguments: minimal, seed };
    if (options.counterexamplePath) await writeFile(options.counterexamplePath, `${JSON.stringify(counterexample, null, 2)}\n`);
    return { status: "counterexample", counterexample, replayed: replay?.functionName === options.functionName && sample === samples[0], tested };
  }
  return { status: "passed", replayed: false, tested };
}

function typeName(type: ts.TypeNode | undefined): PropertyBoundaryKind | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  return supported.has(type.typeName.text as PropertyBoundaryKind) ? type.typeName.text as PropertyBoundaryKind : undefined;
}

function generatedName(fileName: string): string {
  const extension = extname(fileName);
  return `${fileName.slice(0, -extension.length)}.uneffect.test.ts`;
}

function importPath(sourceName: string, generatedFile: string): string {
  const relative = posix.relative(dirname(generatedFile), sourceName.replace(/\.[cm]?tsx?$/, ".js"));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function validateExpression(expression: string): void { parseLogicExpression(expression); }

function emitTest(boundary: InternalBoundary, sourceName: string, outputName: string, cases: number, seed: number, shrinking: boolean): string {
  const parameterNames = boundary.parameters;
  const predicates = boundary.requires.length ? boundary.requires.map((value) => `(${value})`).join(" && ") : "true";
  const postconditions = boundary.ensures.map((value) => `(${value})`).join(" && ");
  return `// Generated by Uneffect. Test-only code; no production runtime dependency.\n` +
    `import { expect, test } from "vitest"\n` +
    `import { ${boundary.functionName} } from ${JSON.stringify(importPath(sourceName, outputName))}\n\n` +
    `const domains = ${JSON.stringify(boundary.generators)} as const\n` +
    `const limits: Record<string, readonly number[]> = ${JSON.stringify(edgeValues)}\n` +
    `function shrink(value: number, domain: string): number[] { const values: number[] = []; let current = value; while (Math.abs(current) > 1) { current = Math.trunc(current / 2); values.push(current) } values.push(0); return [...new Set(values)].filter(value => domain !== "Nat" || value >= 0) }\n` +
    `function random(seed: number) { let state = seed >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000) }\n` +
    `function samples() { const out: number[][] = []; const visit = (at: number, row: number[]) => { if (at === domains.length) { out.push(row); return } for (const value of limits[domains[at]]!) visit(at + 1, [...row, value]) }; visit(0, []); const next = random(${seed}); while (out.length < ${cases}) out.push(domains.map(domain => limits[domain]![Math.floor(next() * limits[domain]!.length)]!)); return out.slice(0, Math.max(${cases}, out.length)) }\n` +
    `const precondition = (${parameterNames.join(", ")}) => ${predicates}\n` +
    `const property = (${parameterNames.join(", ")}) => { const result = ${boundary.functionName}(${parameterNames.join(", ")}); return ${postconditions} }\n\n` +
    `test(${JSON.stringify(`uneffect property: ${boundary.functionName}`)}, () => {\n` +
    `  for (const candidate of samples()) {\n` +
    `    if (!precondition(...candidate)) continue\n` +
    `    if (property(...candidate)) continue\n` +
    (shrinking ? `    const minimal = [...candidate]; for (let index = 0; index < minimal.length; index++) for (const value of shrink(minimal[index]!, domains[index]!)) { const next = minimal.with(index, value); if (precondition(...next) && !property(...next)) minimal[index] = value }\n` : `    const minimal = candidate\n`) +
    `    expect.fail("Uneffect counterexample: " + JSON.stringify({ functionName: ${JSON.stringify(boundary.functionName)}, arguments: minimal }))\n` +
    `  }\n` +
    `})\n`;
}

/** Generates standalone Vitest property tests. It never changes production JavaScript emit. */
export function generateUneffectPropertyTests(options: GenerateUneffectPropertyTestsOptions): GenerateUneffectPropertyTestsResult {
  if (options.backend !== undefined && options.backend !== "quickcheck") throw new Error(`unsupported property backend: ${options.backend}`);
  const generatedFiles: Record<string, string> = {}, boundaries: InternalBoundary[] = [], diagnostics: GenerateUneffectPropertyTestsResult["diagnostics"] = [];
  for (const [fileName, text] of Object.entries(options.files)) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fileBoundaries: InternalBoundary[] = [];
    for (const node of source.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
      const comments = text.slice(node.getFullStart(), node.getStart(source));
      const requires = extractAnnotations(comments, "requires"), ensures = extractAnnotations(comments, "ensures");
      if (requires.length === 0 && ensures.length === 0) continue;
      if (ensures.length === 0) { diagnostics.push({ fileName, functionName: node.name.text, message: "property generation requires at least one ensures clause" }); continue; }
      const domains = node.parameters.map((parameter) => typeName(parameter.type));
      if (domains.some((value) => !value) || node.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) {
        diagnostics.push({ fileName, functionName: node.name.text, message: "property generation currently supports identifier parameters typed Int, Nat, U8, U32, or I32" }); continue;
      }
      try { [...requires, ...ensures].forEach(validateExpression); } catch (cause) {
        diagnostics.push({ fileName, functionName: node.name.text, message: cause instanceof Error ? cause.message : String(cause) }); continue;
      }
      const boundary: InternalBoundary = { fileName, functionName: node.name.text, generators: domains as PropertyBoundaryKind[], shrinkers: domains as PropertyBoundaryKind[], parameters: node.parameters.map((parameter) => (parameter.name as ts.Identifier).text), requires, ensures };
      boundaries.push(boundary); fileBoundaries.push(boundary);
    }
    if (fileBoundaries.length > 0) {
      const outputName = generatedName(fileName);
      generatedFiles[outputName] = fileBoundaries.map((boundary) => emitTest(boundary, fileName, outputName, options.cases ?? 100, options.seed ?? 0x5eed, options.shrinking !== false)).join("\n");
    }
  }
  return { generatedFiles, boundaries: boundaries.map(({ parameters: _, ...boundary }) => boundary), diagnostics };
}
