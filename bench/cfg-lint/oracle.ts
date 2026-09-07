import type { RuleCfg } from "../../src/lint/contracts.js";

export function generatedRuleCfg(seed: number): RuleCfg {
  let state = seed;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const count = 3 + seed % 5;
  return { entry: "0", blocks: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    successors: [...new Set(Array.from({ length: next() % 3 }, () => String(next() % count)))],
    events: Array.from({ length: 1 + next() % 3 }, (_, offset) => ({
      operation: ["initialize", "use", "reset"][next() % 3]!,
      subject: next() % 2 === 0 ? "a" : "b",
      location: { fileName: "generated.ts", start: index * 10 + offset, end: index * 10 + offset + 1 },
    })),
  })) };
}

/** Exhaust concrete (block, two-subject bitset) configurations; no lattice or workflow code. */
export function referenceMissingUses(cfg: RuleCfg): { missing: number[]; configurations: number } {
  const blocks = new Map(cfg.blocks.map(block => [block.id, block]));
  const queue: Array<{ block: string; initialized: number }> = [{ block: cfg.entry, initialized: 0 }];
  const seen = new Set<string>(), missing = new Set<number>();
  while (queue.length) {
    const current = queue.pop()!;
    const key = `${current.block}:${current.initialized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let initialized = current.initialized;
    const block = blocks.get(current.block)!;
    for (const event of block.events) {
      const bit = event.subject === "a" ? 1 : 2;
      if (event.operation === "initialize") initialized |= bit;
      else if (event.operation === "reset") initialized &= ~bit;
      else if (event.operation === "use" && !(initialized & bit)) missing.add(event.location.start);
    }
    for (const successor of block.successors) queue.push({ block: successor, initialized });
  }
  return { missing: [...missing].sort((a, b) => a - b), configurations: seen.size };
}
