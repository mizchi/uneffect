import { extractAnnotations } from "./annotations.js";
import type { TemporalClock, TemporalState } from "./spec-ir.js";
import type { TemporalValueType } from "./temporal-expressions.js";

export interface TemporalDomainActionSource {
  name: string;
  assignments: readonly string[];
}

export interface TemporalDomainExpansion {
  states?: readonly TemporalState[];
  init?: readonly string[];
  actions?: readonly TemporalDomainActionSource[];
  clocks?: readonly TemporalClock[];
  protectedStates?: Readonly<Record<string, { explicitInit: string; explicitAssignment: string }>>;
}

export interface TemporalSemanticDomain {
  name: string;
  directives: readonly string[];
  expand(source: string): TemporalDomainExpansion;
}

export class TemporalDomainRegistry {
  readonly #domains = new Map<string, TemporalSemanticDomain>();

  register(domain: TemporalSemanticDomain): this {
    for (const directive of domain.directives) {
      if (!/^[a-z][a-z0-9_]*$/.test(directive)) throw new Error(`invalid temporal domain directive \`${directive}\``);
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
    };
  }
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
  return new TemporalDomainRegistry().register(createLogicalClockDomain());
}
