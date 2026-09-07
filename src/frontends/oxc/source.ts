import { parseSync, visitorKeys, type Node, type Program, type Function as OxcFunction, type BindingIdentifier, type FunctionBody, type ParamPattern, type TSType } from "oxc-parser";

/** Source spans and line/column positions use JavaScript UTF-16 offsets. */
export interface OxcSource {
  readonly fileName: string;
  readonly text: string;
  readonly program: Program;
  textOf(node: Pick<Node, "start" | "end">): string;
  positionAt(offset: number): { line: number; character: number };
}

/** Reject parser recovery before consumers can issue a positive analysis result. */
export function parseOxcSource(fileName: string, text: string): OxcSource {
  const parsed = parseSync(fileName, text, { lang: "ts" });
  if (parsed.errors.length) throw new Error(`${fileName}: invalid TypeScript syntax: ${parsed.errors.map(error => error.message).join("; ")}`);
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\r") { if (text[index + 1] === "\n") index++; starts.push(index + 1); }
    else if (char === "\n" || char === "\u2028" || char === "\u2029") starts.push(index + 1);
  }
  return {
    fileName, text, program: parsed.program,
    textOf: node => text.slice(node.start, node.end),
    positionAt(offset) {
      let low = 0, high = starts.length;
      while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle; else high = middle; }
      return { line: low, character: offset - starts[low]! };
    },
  };
}

export type NamedOxcFunction = OxcFunction & { id: BindingIdentifier; body: FunctionBody };
export interface OxcFunctionSource {
  readonly node: NamedOxcFunction;
  /** Includes the export modifier, when present. */
  readonly start: number;
  readonly end: number;
  readonly leadingStart: number;
  readonly comments: string;
}

/** Preserve declaration-leading annotation attachment across export wrappers. */
export function topLevelOxcFunctions(source: OxcSource): OxcFunctionSource[] {
  const functions: OxcFunctionSource[] = [];
  let previousEnd = 0;
  for (const statement of source.program.body) {
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    if (node?.type === "FunctionDeclaration" && node.id && node.body) {
      functions.push({ node: node as NamedOxcFunction, start: statement.start, end: statement.end, leadingStart: previousEnd,
        comments: source.text.slice(previousEnd, statement.start) });
    }
    previousEnd = statement.end;
  }
  return functions;
}

export function oxcChildren(node: Node): Node[] {
  const fields = node as unknown as Record<string, unknown>;
  return (visitorKeys[node.type] ?? []).flatMap(key => {
    const value = fields[key];
    return (Array.isArray(value) ? value : [value]).filter((item): item is Node =>
      item !== null && typeof item === "object" && "type" in item);
  });
}

export function oxcParameterBinding(parameter: ParamPattern): BindingIdentifier | undefined {
  const binding = parameter.type === "AssignmentPattern" ? parameter.left : parameter.type === "RestElement" ? parameter.argument : parameter;
  return binding.type === "Identifier" ? binding : undefined;
}

export function oxcParameterType(parameter: ParamPattern): TSType | undefined {
  return (parameter.type === "RestElement" ? parameter.typeAnnotation : oxcParameterBinding(parameter)?.typeAnnotation)?.typeAnnotation;
}
