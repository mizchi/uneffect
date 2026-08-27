// An outer synchronous audit spans an inner asynchronous session. Either of
// two awaited operations may reject. Recovery continues through mandatory
// finally and inner disposal before the outer audit flush; rethrow skips the
// flush but still disposes inner then outer.

export interface RecoveryAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface RecoverySession extends AsyncDisposable {
  prepare(): Promise<void>;
  send(): Promise<void>;
}

export async function deliverNested(
  recover: boolean,
  openAudit: () => RecoveryAudit,
  openSession: () => RecoverySession,
): Promise<void> {
  using audit = openAudit();
  {
    await using session = openSession();
    try {
      await session.prepare().then(() => undefined);
      await session.send().then(() => undefined);
    } catch (error) {
      if (recover) {
        audit.record("recovered");
      } else {
        throw error;
      }
    } finally {
      audit.record("finally");
    }
  }
  await audit.flush().then(() => undefined);
}
