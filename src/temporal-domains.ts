import { extractAnnotations, isCoreUneffectDirective } from "./annotations.js";
import type { TemporalClock, TemporalState } from "./spec-ir.js";
import type { TemporalValueType } from "./temporal-expressions.js";

export interface TemporalDomainActionSource {
  name: string;
  assignments: readonly string[];
  guard?: string;
}

export interface TemporalDomainPropertySource { name: string; expression: string }

export interface TemporalDomainExpansion {
  states?: readonly TemporalState[];
  init?: readonly string[];
  actions?: readonly TemporalDomainActionSource[];
  clocks?: readonly TemporalClock[];
  protectedStates?: Readonly<Record<string, { explicitInit: string; explicitAssignment: string }>>;
  properties?: readonly TemporalDomainPropertySource[];
}

export interface TemporalSemanticDomain {
  name: string;
  directives: readonly string[];
  expand(source: string): TemporalDomainExpansion;
}

const builtinDirectiveAuthority = {};

export class TemporalDomainRegistry {
  readonly #domains = new Map<string, TemporalSemanticDomain>();

  register(domain: TemporalSemanticDomain, authority?: object): this {
    for (const directive of domain.directives) {
      if (!/^[a-z][a-z0-9_]*$/.test(directive)) throw new Error(`invalid temporal domain directive \`${directive}\``);
      if (isCoreUneffectDirective(directive) && authority !== builtinDirectiveAuthority) {
        throw new Error(`temporal directive \`${directive}\` collides with a core Uneffect directive`);
      }
      const owner = this.#domains.get(directive);
      if (owner) throw new Error(`temporal directive \`${directive}\` is already owned by domain \`${owner.name}\``);
      this.#domains.set(directive, domain);
    }
    return this;
  }

  directives(): readonly string[] { return [...this.#domains.keys()]; }

  expand(source: string): TemporalDomainExpansion {
    const domains = [...new Set(this.#domains.values())];
    const expansions = domains.map((domain) => domain.expand(source));
    return {
      states: expansions.flatMap((item) => item.states ?? []),
      init: expansions.flatMap((item) => item.init ?? []),
      actions: expansions.flatMap((item) => item.actions ?? []),
      clocks: expansions.flatMap((item) => item.clocks ?? []),
      protectedStates: Object.assign({}, ...expansions.map((item) => item.protectedStates ?? {})),
      properties: expansions.flatMap((item) => item.properties ?? []),
    };
  }
}

export function createPhysicalClockDomain(): TemporalSemanticDomain {
  return {
    name: "physical-clock",
    directives: ["monotonic_clock", "wall_clock", "wall_clock_jump", "clock_skew"],
    expand(source) {
      const parseClock = (directive: string) => extractAnnotations(source, directive).map((value) => {
        const match = /^([A-Za-z_$][\w$]*)\s*:\s*([1-9]\d*)(?:\.\.([1-9]\d*))?$/.exec(value);
        if (!match) throw new Error(`${directive} requires name: positiveInteger or name: minimum..maximum`);
        const minimum = Number(match[2]), maximum = Number(match[3] ?? match[2]);
        if (maximum < minimum || maximum - minimum > 31) throw new Error(`${directive} range must be ascending and contain at most 32 values`);
        return { name: match[1]!, step: minimum, steps: Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index) };
      });
      const monotonic = parseClock("monotonic_clock"), wall = parseClock("wall_clock");
      const jumps = new Map(parseClock("wall_clock_jump").map((item) => [item.name, item.steps]));
      for (const name of jumps.keys()) if (!wall.some((item) => item.name === name)) throw new Error("wall_clock_jump must reference a wall_clock declared in the same physical-clock pack");
      const skews = extractAnnotations(source, "clock_skew").map((value) => {
        const match = /^([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*:\s*(\d+)$/.exec(value);
        if (!match) throw new Error("clock_skew requires wallClock, monotonicClock: nonNegativeBound");
        if (!wall.some((item) => item.name === match[1]) || !monotonic.some((item) => item.name === match[2])) throw new Error("clock_skew must reference clocks declared in the same physical-clock pack");
        return { wall: match[1]!, monotonic: match[2]!, bound: Number(match[3]) };
      });
      const guardFor = (name: string, next: string): string | undefined => {
        const terms = skews.filter((item) => item.wall === name || item.monotonic === name).map((item) => {
          const wallValue = item.wall === name ? next : item.wall;
          const monotonicValue = item.monotonic === name ? next : item.monotonic;
          return `${wallValue} <= ${monotonicValue} + ${item.bound} && ${monotonicValue} <= ${wallValue} + ${item.bound}`;
        });
        return terms.length ? terms.join(" && ") : undefined;
      };
      const actions: TemporalDomainActionSource[] = [
        ...monotonic.flatMap((item) => item.steps.map((step) => ({ name: `tick_${item.name}${item.steps.length > 1 ? `_${step}` : ""}`, assignments: [`${item.name}' = ${item.name} + ${step}`], guard: guardFor(item.name, `${item.name} + ${step}`) }))),
        ...wall.flatMap((item) => [
          ...item.steps.map((step) => ({ name: `tick_${item.name}${item.steps.length > 1 ? `_${step}` : ""}`, assignments: [`${item.name}' = ${item.name} + ${step}`], guard: guardFor(item.name, `${item.name} + ${step}`) })),
          ...(jumps.get(item.name) ?? item.steps).map((step) => ({ name: `jump_back_${item.name}${(jumps.get(item.name) ?? item.steps).length > 1 ? `_${step}` : ""}`, assignments: [`${item.name}' = ${item.name} - ${step}`], guard: [`${item.name} >= ${step}`, guardFor(item.name, `${item.name} - ${step}`)].filter(Boolean).join(" && ") })),
        ]),
      ];
      const clocks = [...monotonic, ...wall];
      return {
        states: clocks.map((item) => ({ name: item.name, type: "int" as const })),
        init: clocks.map((item) => `${item.name} = 0`), actions,
        properties: skews.map((item) => ({ name: `skew_${item.wall}_${item.monotonic}`, expression: `${item.wall} <= ${item.monotonic} + ${item.bound} && ${item.monotonic} <= ${item.wall} + ${item.bound}` })),
        protectedStates: Object.fromEntries(clocks.map((item) => [item.name, { explicitInit: `physical clock \`${item.name}\` owns its init`, explicitAssignment: `physical clock \`${item.name}\` owns its transitions` }])),
      };
    },
  };
}

export function createLogicalClockDomain(): TemporalSemanticDomain {
  return {
    name: "logical-clock",
    directives: ["clock"],
    expand(source) {
      const clocks = extractAnnotations(source, "clock").map((value): TemporalClock => {
        const match = /^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/.exec(value);
        if (!match) throw new Error(`invalid clock: ${value}`);
        if (!/^[1-9]\d*$/.test(match[2]!)) throw new Error(`clock \`${match[1]}\` granularity must be a positive integer`);
        return { name: match[1]!, granularity: Number(match[2]) };
      });
      return {
        clocks,
        states: clocks.map((clock) => ({ name: clock.name, type: "int" as TemporalValueType })),
        init: clocks.map((clock) => `${clock.name} = 0`),
        actions: clocks.map((clock) => ({ name: `tick_${clock.name}`, assignments: [`${clock.name}' = ${clock.name} + ${clock.granularity}`] })),
        protectedStates: Object.fromEntries(clocks.map((clock) => [clock.name, {
          explicitInit: `clock \`${clock.name}\` has an implicit zero init`,
          explicitAssignment: `only generated action \`tick_${clock.name}\` may update clock \`${clock.name}\``,
        }])),
      };
    },
  };
}

export function createDefaultTemporalDomainRegistry(): TemporalDomainRegistry {
  return new TemporalDomainRegistry().register(createLogicalClockDomain(), builtinDirectiveAuthority);
}
