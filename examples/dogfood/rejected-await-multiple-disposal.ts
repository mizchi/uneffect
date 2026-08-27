// A rejected awaited delivery is handled before mandatory finalization, then
// both function-scoped resources are disposed in reverse acquisition order.
// The sync audit resource is deliberately acquired before the async session.

export interface DeliveryAudit extends Disposable {
  record(event: "caught" | "finally"): void;
}

export interface DeliverySession extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverWithRecovery(
  openAudit: () => DeliveryAudit,
  openSession: () => DeliverySession,
): Promise<void> {
  using audit = openAudit();
  await using session = openSession();
  try {
    await session.send().then(() => undefined);
  } catch {
    audit.record("caught");
  } finally {
    audit.record("finally");
  }
}
