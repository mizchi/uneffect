import { readFileSync } from "node:fs";

/**
 * The interface inheritance the standard DOM library declares, read from the very `lib.dom.d.ts` the analyzing
 * compiler loaded.
 *
 * A reviewed contract is keyed by the interface that declares the member, and a receiver almost never has that
 * interface as its own type: `querySelector` is declared by `ParentNode` and reached through `Element`,
 * `addEventListener` by `EventTarget` and reached through every element type. The member itself is still
 * resolved by the checker, so this graph only answers which reviewed key that resolved member belongs to; it
 * never decides that a member exists.
 */
export interface DomInterfaceGraph {
  /** Interfaces the named one extends, transitively, nearest first. */
  ancestors(name: string): readonly string[];
  /** Interfaces the file declares, for diagnosing an empty graph. */
  readonly size: number;
}

/** Split an `extends` clause on commas that are not inside a type argument list. */
function splitHeritage(clause: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of clause) {
    if (character === "<") depth += 1;
    else if (character === ">") depth -= 1;
    if (character === "," && depth === 0) {
      names.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  names.push(current);
  return names
    .map((name) => name.replace(/<[\s\S]*$/u, "").trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name));
}

const interfaceDeclaration = /^\s*interface\s+([A-Za-z_$][\w$]*)(?:<[^{]*?>)?\s+extends\s+([^{]+)\{/gmu;

export function parseDomInterfaceGraph(libraryText: string): DomInterfaceGraph {
  const extended = new Map<string, readonly string[]>();
  for (const match of libraryText.matchAll(interfaceDeclaration)) {
    const name = match[1]!;
    const heritage = splitHeritage(match[2]!);
    // A merged declaration contributes its own heritage; the union is what the checker sees.
    const previous = extended.get(name);
    extended.set(name, previous === undefined ? heritage : [...new Set([...previous, ...heritage])]);
  }
  const cache = new Map<string, readonly string[]>();
  const ancestors = (name: string): readonly string[] => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    // Breadth first, so a nearer interface is preferred when several declare the same member name. A cycle
    // cannot outrun the visited set, and self-reference is excluded.
    const visited = new Set<string>([name]);
    const order: string[] = [];
    for (let frontier = [...extended.get(name) ?? []]; frontier.length > 0;) {
      const next: string[] = [];
      for (const item of frontier) {
        if (visited.has(item)) continue;
        visited.add(item);
        order.push(item);
        next.push(...extended.get(item) ?? []);
      }
      frontier = next;
    }
    cache.set(name, order);
    return order;
  };
  return { ancestors, size: extended.size };
}

const emptyGraph: DomInterfaceGraph = { ancestors: () => [], size: 0 };
const graphsByFile = new Map<string, DomInterfaceGraph>();

/**
 * Read the graph once per library file. A library the process cannot read yields an empty graph, which keeps
 * every inherited member an explicit unknown rather than guessing a contract from the member name alone.
 */
export function loadDomInterfaceGraph(libraryFile: string): DomInterfaceGraph {
  const cached = graphsByFile.get(libraryFile);
  if (cached !== undefined) return cached;
  let graph = emptyGraph;
  try {
    graph = parseDomInterfaceGraph(readFileSync(libraryFile, "utf8"));
  } catch {
    graph = emptyGraph;
  }
  graphsByFile.set(libraryFile, graph);
  return graph;
}
