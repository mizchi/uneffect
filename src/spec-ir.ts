import ts from "typescript";
import { extractAnnotations, extractLocatedAnnotations, validateUneffectAnnotations, type SourceSpan } from "./annotations.js";
import { parseEffectExpression, splitTopLevel, type Effect } from "./capabilities.js";
import { assertGuardedTemporalMapGets, formatTemporalValueType, parseTemporalExpression, parseTemporalValueType, temporalTypesCompatible, typeCheckTemporalExpression, type TemporalExpression, type TemporalValueType } from "./temporal-expressions.js";
import { createDefaultTemporalDomainRegistry, type TemporalDomainRegistry } from "./temporal-domains.js";
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

/** A recurrence obligation: the predicate must hold infinitely often. */
export interface TemporalRecurrence extends TemporalProperty {}

/** A stabilization obligation: eventually the predicate must remain true. */
export interface TemporalStabilization extends TemporalProperty {}

export interface TemporalResponse {
  name: string;
  trigger: string;
  triggerAst: TemporalExpression;
  response: string;
  responseAst: TemporalExpression;
}

export interface TemporalSpec {
  stutteringPolicy: "explicit-unchanged";
  clocks: TemporalClock[];
  states: TemporalState[];
  init: TemporalAssignment[];
  actions: TemporalAction[];
  properties: TemporalProperty[];
  liveness: TemporalLiveness[];
  recurrences: TemporalRecurrence[];
  stabilizations: TemporalStabilization[];
  responses: TemporalResponse[];
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

function responseExpression(input: string): TemporalResponse {
  const { name, expression } = namedExpression(input, "temporal_response");
  let depth = 0, quote: "'" | '"' | "`" | undefined, escaped = false, separator = -1;
  for (let index = 0; index < expression.length - 1; index++) {
    const character = expression[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") depth--;
    else if (depth === 0 && character === "=" && expression[index + 1] === ">") {
      if (separator >= 0) throw new Error(`invalid temporal_response: ${input}`);
      separator = index++;
    }
  }
  if (separator < 0) throw new Error(`invalid temporal_response: ${input}; expected trigger => response`);
  const trigger = expression.slice(0, separator).trim(), response = expression.slice(separator + 2).trim();
  if (!trigger || !response) throw new Error(`invalid temporal_response: ${input}; expected non-empty trigger => response`);
  return { name, trigger, triggerAst: parseTemporalExpression(trigger), response, responseAst: parseTemporalExpression(response) };
}

function assignment(input: string, kind: string): TemporalAssignment {
  const match = /^([A-Za-z_$][\w$]*)'?\s*=\s*(.+)$/.exec(input);
  if (!match) throw new Error(`invalid ${kind} assignment: ${input}`);
  const expression = match[2]!.trim();
  return { target: match[1]!, expression, expressionAst: parseTemporalExpression(expression) };
}

function splitTemporalAssignments(input: string): string[] {
  const values: string[] = [];
  let start = 0, parenDepth = 0, bracketDepth = 0, braceDepth = 0, quote: string | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote && input[index - 1] !== "\\") quote = undefined;
    } else if (char === '"' || char === "`" || (char === "'" && !/[\w$]/.test(input[index - 1] ?? ""))) quote = char;
    else if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      values.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(input.slice(start).trim());
  if (values.some((value) => value.length === 0)) throw new Error("empty temporal action assignment");
  return values;
}

export function parseSpec(fileName: string, text: string, options: { temporalSymbols?: ReadonlyMap<string, TemporalValueType>; temporalDomains?: TemporalDomainRegistry } = {}): ParsedSpec {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const temporalDomains = options.temporalDomains ?? createDefaultTemporalDomainRegistry();
  const annotationError = validateUneffectAnnotations(text, 0, temporalDomains.directives())[0];
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

  const domainExpansion = temporalDomains.expand(text);
  const clocks = [...(domainExpansion.clocks ?? [])];
  const states = [
    ...(domainExpansion.states ?? []),
    ...extractAnnotations(text, "state").map((value): TemporalState => {
    const parsed = namedExpression(value, "state");
    try {
      return { name: parsed.name, type: parseTemporalValueType(parsed.expression) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`unsupported state type: ${parsed.expression}: ${message}`);
    }
    }),
  ];
  const explicitInit = extractAnnotations(text, "init").map((value) => assignment(value, "init"));
  for (const [name, messages] of Object.entries(domainExpansion.protectedStates ?? {})) if (explicitInit.some((item) => item.target === name)) {
    throw new Error(messages.explicitInit);
  }
  const init = [
    ...(domainExpansion.init ?? []).map((item) => assignment(item, "temporal domain init")),
    ...explicitInit,
  ];
  const explicitActions = extractAnnotations(text, "action").map((value): TemporalAction => {
    const parsed = namedExpression(value, "action");
    return {
      name: parsed.name,
      assignments: splitTemporalAssignments(parsed.expression).map((item) => assignment(item, "action")),
    };
  });
  for (const [name, messages] of Object.entries(domainExpansion.protectedStates ?? {})) for (const action of explicitActions) if (action.assignments.some((item) => item.target === name)) {
    throw new Error(messages.explicitAssignment);
  }
  const actions: TemporalAction[] = [
    ...(domainExpansion.actions ?? []).map((action): TemporalAction => ({
      name: action.name,
      assignments: action.assignments.map((item) => assignment(item, "temporal domain action")),
      ...(action.guard ? { guard: { name: action.name, expression: action.guard, expressionAst: parseTemporalExpression(action.guard) } } : {}),
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
  for (const action of actions) {
    const declared = actionGuards.get(action.name);
    if (action.guard && declared) {
      const expression = `(${action.guard.expression}) && (${declared.expression})`;
      action.guard = { name: action.name, expression, expressionAst: parseTemporalExpression(expression) };
    } else if (declared) action.guard = declared;
  }
  const actionFairness = new Map(extractAnnotations(text, "action_fair").map((value) => {
    const parsed = namedExpression(value, "action_fair");
    if (parsed.expression !== "weak" && parsed.expression !== "strong") throw new Error(`action_fair for \`${parsed.name}\` requires weak or strong`);
    return [parsed.name, parsed.expression] as const;
  }));
  for (const name of actionFairness.keys()) if (!actions.some((action) => action.name === name)) throw new Error(`action_fair references unknown action \`${name}\``);
  for (const action of actions) action.fairness = actionFairness.get(action.name);
  const properties = [
    ...(domainExpansion.properties ?? []).map((property): TemporalProperty => ({ ...property, expressionAst: parseTemporalExpression(property.expression) })),
    ...extractAnnotations(text, "temporal").map((value): TemporalProperty => {
    const property = namedExpression(value, "temporal");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
    }),
  ];
  const liveness = extractAnnotations(text, "temporal_eventually").map((value): TemporalLiveness => {
    const property = namedExpression(value, "temporal_eventually");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
  });
  const recurrences = extractAnnotations(text, "temporal_repeatedly").map((value): TemporalRecurrence => {
    const property = namedExpression(value, "temporal_repeatedly");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
  });
  const stabilizations = extractAnnotations(text, "temporal_stabilizes").map((value): TemporalStabilization => {
    const property = namedExpression(value, "temporal_stabilizes");
    return { ...property, expressionAst: parseTemporalExpression(property.expression) };
  });
  const responses = extractAnnotations(text, "temporal_response").map(responseExpression);

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
  for (const item of init) { checkAssignment(item, "init"); assertGuardedTemporalMapGets(item.expressionAst); }
  for (const action of actions) for (const item of action.assignments) {
    checkAssignment(item, "action");
    assertGuardedTemporalMapGets(item.expressionAst, action.guard?.expressionAst);
  }
  for (const action of actions) if (action.guard) {
    assertGuardedTemporalMapGets(action.guard.expressionAst);
    if (typeCheckTemporalExpression(action.guard.expressionAst, symbols) !== "bool") throw new Error(`action guard \`${action.name}\` must be boolean`);
  }
  for (const property of properties) {
    assertGuardedTemporalMapGets(property.expressionAst);
    if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") {
      throw new Error(`temporal property \`${property.name}\` must be boolean`);
    }
  }
  for (const property of liveness) {
    assertGuardedTemporalMapGets(property.expressionAst);
    if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") throw new Error(`temporal liveness property \`${property.name}\` must be boolean`);
  }
  for (const property of recurrences) {
    assertGuardedTemporalMapGets(property.expressionAst);
    if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") throw new Error(`temporal recurrence property \`${property.name}\` must be boolean`);
  }
  for (const property of stabilizations) {
    assertGuardedTemporalMapGets(property.expressionAst);
    if (typeCheckTemporalExpression(property.expressionAst, symbols) !== "bool") throw new Error(`temporal stabilization property \`${property.name}\` must be boolean`);
  }
  for (const property of responses) {
    assertGuardedTemporalMapGets(property.triggerAst);
    assertGuardedTemporalMapGets(property.responseAst);
    if (typeCheckTemporalExpression(property.triggerAst, symbols) !== "bool") throw new Error(`temporal response trigger \`${property.name}\` must be boolean`);
    if (typeCheckTemporalExpression(property.responseAst, symbols) !== "bool") throw new Error(`temporal response target \`${property.name}\` must be boolean`);
  }

  return { fileName, capabilities, invariants, temporal: { stutteringPolicy: "explicit-unchanged", clocks, states, init, actions, properties, liveness, recurrences, stabilizations, responses } };
}
