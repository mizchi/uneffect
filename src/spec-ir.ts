import ts from "typescript";
import { extractAnnotations, extractLocatedAnnotations, validateUneffectAnnotations, type SourceSpan } from "./annotations.js";
import { parseEffectExpression, splitTopLevel, type Effect } from "./capabilities.js";
import { formatTemporalValueType, parseTemporalExpression, temporalTypesCompatible, typeCheckTemporalExpression, type TemporalExpression, type TemporalValueType } from "./temporal-expressions.js";
import type { NumericDomain } from "./invariant-ir.js";

export interface CapabilitySpec {
  functionName: string;
  effects: LocatedEffect[];
}

export interface LocatedEffect { value: Effect; span: SourceSpan }

export interface InvariantSpec {
  fileName?: string;
  functionName: string;
  parameters: string[];
  parameterDomains?: Record<string, NumericDomain>;
  resultDomain?: NumericDomain;
  requires: string[];
  ensures: string[];
  result?: string;
  span?: SourceSpan;
}

export interface TemporalState {
  name: string;
  type: TemporalValueType;
}

export interface TemporalClock {
  name: string;
  granularity: number;
}

export interface TemporalAssignment {
  target: string;
  expression: string;
  expressionAst: TemporalExpression;
}

export interface TemporalAction {
  name: string;
  assignments: TemporalAssignment[];
  guard?: TemporalProperty;
  fairness?: "weak" | "strong";
}

export interface TemporalProperty {
  name: string;
  expression: string;
  expressionAst: TemporalExpression;
}

export interface TemporalLiveness extends TemporalProperty {}

export interface TemporalSpec {
  stutteringPolicy: "explicit-unchanged";
  clocks: TemporalClock[];
  states: TemporalState[];
  init: TemporalAssignment[];
  actions: TemporalAction[];
  properties: TemporalProperty[];
  liveness: TemporalLiveness[];
}

export interface ParsedSpec {
  fileName: string;
  capabilities: CapabilitySpec[];
  invariants: InvariantSpec[];
  temporal: TemporalSpec;
}

function leading(source: ts.SourceFile, node: ts.Node): string {
  return source.text.slice(node.getFullStart(), node.getStart(source));
}

function namedExpression(input: string, kind: string): { name: string; expression: string } {
  const match = /^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/.exec(input);
  if (!match) throw new Error(`invalid ${kind}: ${input}`);
  return { name: match[1]!, expression: match[2]!.trim() };
}

function assignment(input: string, kind: string): TemporalAssignment {
  const match = /^([A-Za-z_$][\w$]*)'?\s*=\s*(.+)$/.exec(input);
  if (!match) throw new Error(`invalid ${kind} assignment: ${input}`);
  const expression = match[2]!.trim();
  return { target: match[1]!, expression, expressionAst: parseTemporalExpression(expression) };
}

export function parseSpec(fileName: string, text: string, options: { temporalSymbols?: ReadonlyMap<string, TemporalValueType> } = {}): ParsedSpec {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const annotationError = validateUneffectAnnotations(text)[0];
  if (annotationError) {
    const position = source.getLineAndCharacterOfPosition(annotationError.span.start);
    throw new Error(`${fileName}:${position.line + 1}:${position.character + 1}: ${annotationError.message}`);
  }
  const capabilities: CapabilitySpec[] = [];
  const invariants: InvariantSpec[] = [];

  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const comments = leading(source, node);
    const effects = extractLocatedAnnotations(comments, "effect", node.getFullStart()).flatMap((annotation): LocatedEffect[] => {
      let terms: string[];
      try {
        terms = splitTopLevel(annotation.value, "|");
      } catch (cause) {
        const position = source.getLineAndCharacterOfPosition(annotation.span.start);
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${fileName}:${position.line + 1}:${position.character + 1}: ${message}`);
      }
      let cursor = 0;
      return terms.map((text): LocatedEffect => {
        const relative = annotation.value.indexOf(text, cursor);
        cursor = relative + text.length;
        const span = { start: annotation.span.start + relative, end: annotation.span.start + relative + text.length };
        try {
          return { value: parseEffectExpression(text), span };
        } catch (cause) {
          const position = source.getLineAndCharacterOfPosition(span.start);
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`${fileName}:${position.line + 1}:${position.character + 1}: ${message}`);
        }
      });
    });
    if (effects.length > 0) capabilities.push({ functionName: node.name.text, effects });
    const requires = extractAnnotations(comments, "requires");
    const ensures = extractAnnotations(comments, "ensures");
    if (requires.length > 0 || ensures.length > 0) {
      const returned = node.body.statements.find(ts.isReturnStatement);
      invariants.push({
        fileName,
        functionName: node.name.text,
        parameters: node.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []),
        parameterDomains: Object.fromEntries(node.parameters.flatMap((parameter) => {
          if (!ts.isIdentifier(parameter.name)) return [];
          const name = parameter.type?.getText(source) ?? "number";
          const domain: NumericDomain = name === "Nat" ? "nat" : name === "Float" ? "float" : name === "boolean" ? "bool" : "int";
          return [[parameter.name.text, domain]];
        })),
        resultDomain: node.type?.getText(source) === "Float" ? "float" : node.type?.getText(source) === "boolean" ? "bool" : "int",
        requires,
        ensures,
        result: returned?.expression?.getText(source),
        span: { start: node.getStart(source), end: node.getEnd() },
      });
    }
  }

  const clocks = extractAnnotations(text, "clock").map((value): TemporalClock => {
    const parsed = namedExpression(value, "clock");
    if (!/^[1-9]\d*$/.test(parsed.expression)) throw new Error(`clock \`${parsed.name}\` granularity must be a positive integer`);
    return { name: parsed.name, granularity: Number(parsed.expression) };
  });
  const states = [
    ...clocks.map((clock): TemporalState => ({ name: clock.name, type: "int" })),
    ...extractAnnotations(text, "state").map((value): TemporalState => {
    const parsed = namedExpression(value, "state");
    if (parsed.expression === "int" || parsed.expression === "bool") return { name: parsed.name, type: parsed.expression };
    const set = /^Set<(int|bool)>$/.exec(parsed.expression);
    if (set) return { name: parsed.name, type: { kind: "set", element: set[1] as "int" | "bool" } };
    const map = /^Map<(int|bool),\s*(int|bool)>$/.exec(parsed.expression);
    if (map) return { name: parsed.name, type: { kind: "map", key: map[1] as "int" | "bool", value: map[2] as "int" | "bool" } };
    throw new Error(`unsupported state type: ${parsed.expression}`);
    }),
  ];
  const explicitInit = extractAnnotations(text, "init").map((value) => assignment(value, "init"));
  for (const clock of clocks) if (explicitInit.some((item) => item.target === clock.name)) {
    throw new Error(`clock \`${clock.name}\` has an implicit zero init`);
  }
  const init = [
    ...clocks.map((clock) => assignment(`${clock.name} = 0`, "clock init")),
    ...explicitInit,
  ];
  const explicitActions = extractAnnotations(text, "action").map((value): TemporalAction => {
    const parsed = namedExpression(value, "action");
    return {
      name: parsed.name,
      assignments: splitTopLevel(parsed.expression, ",").map((item) => assignment(item, "action")),
    };
  });
  for (const clock of clocks) for (const action of explicitActions) if (action.assignments.some((item) => item.target === clock.name)) {
    throw new Error(`only generated action \`tick_${clock.name}\` may update clock \`${clock.name}\``);
  }
  const actions: TemporalAction[] = [
    ...clocks.map((clock): TemporalAction => ({
      name: `tick_${clock.name}`,
      assignments: [assignment(`${clock.name}' = ${clock.name} + ${clock.granularity}`, "clock tick")],
    })),
    ...explicitActions,
  ];
  if (new Set(actions.map((action) => action.name)).size !== actions.length) throw new Error("duplicate temporal action name");
  const actionGuards = new Map(extractAnnotations(text, "action_when").map((value) => {
    const parsed = namedExpression(value, "action_when");
    return [parsed.name, { ...parsed, expressionAst: parseTemporalExpression(parsed.expression) }] as const;
  }));
  for (const name of actionGuards.keys()) {
    if (!actions.some((action) => action.name === name)) throw new Error(`action_when references unknown action \`${name}\``);
  }
  for (const action of actions) action.guard = actionGuards.get(action.name);
  const actionFairness = new Map(extractAnnotations(text, "action_fair").map((value) => {
    const parsed = namedExpression(value, "action_fair");
    if (parsed.expression !== "weak" && parsed.expression !== "strong") throw new Error(`action_fair for \`${parsed.name}\` requires weak or strong`);
    return [parsed.name, parsed.expression] as const;
  }));
  for (const name of actionFairness.keys()) if (!actions.some((action) => action.name === name)) throw new Error(`action_fair references unknown action \`${name}\``);
  for (const action of actions) action.fairness = actionFairness.get(action.name);
  const properties = extractAnnotations(text, "temporal").map((value): TemporalProperty => {
    const property = namedExpression(value, "temporal");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
  });
  const liveness = extractAnnotations(text, "temporal_eventually").map((value): TemporalLiveness => {
    const property = namedExpression(value, "temporal_eventually");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
  });

  const symbols = new Map<string, TemporalValueType>(options.temporalSymbols);
  for (const state of states) {
    if (symbols.has(state.name)) throw new Error(`duplicate temporal symbol \`${state.name}\``);
    symbols.set(state.name, state.type);
  }
  const checkAssignment = (item: TemporalAssignment, kind: string): void => {
    const target = symbols.get(item.target);
    if (!target) throw new Error(`unknown temporal ${kind} target \`${item.target}\``);
    const actual = typeCheckTemporalExpression(item.expressionAst, symbols);
    if (!temporalTypesCompatible(actual, target)) throw new Error(`temporal ${kind} assigns ${formatTemporalValueType(actual)} to ${formatTemporalValueType(target)} state \`${item.target}\``);
  };
  for (const item of init) checkAssignment(item, "init");
  for (const action of actions) for (const item of action.assignments) checkAssignment(item, "action");
  for (const action of actions) if (action.guard && typeCheckTemporalExpression(action.guard.expressionAst, symbols) !== "bool") {
    throw new Error(`action guard \`${action.name}\` must be boolean`);
  }
  for (const property of properties) {
    if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") {
      throw new Error(`temporal property \`${property.name}\` must be boolean`);
    }
  }
  for (const property of liveness) if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") throw new Error(`temporal liveness property \`${property.name}\` must be boolean`);

  return { fileName, capabilities, invariants, temporal: { stutteringPolicy: "explicit-unchanged", clocks, states, init, actions, properties, liveness } };
}
