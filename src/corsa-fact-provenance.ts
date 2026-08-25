const authenticatedCheckerFacts = new WeakSet<object>();

export function authenticateCorsaCheckerFacts<T extends object>(facts: T): T {
  authenticatedCheckerFacts.add(facts);
  return facts;
}

export function isAuthenticatedCorsaCheckerFacts(facts: unknown): facts is object {
  return typeof facts === "object" && facts !== null && authenticatedCheckerFacts.has(facts);
}
