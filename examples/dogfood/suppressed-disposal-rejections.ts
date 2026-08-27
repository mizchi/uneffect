// Both inner async disposals may reject. The later acquisition is disposed
// first, but either failure must not skip the remaining disposal. Catch sees a
// finite single-or-suppressed completion only after the inner stack is empty.

export interface SuppressionAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface FailingChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverWithSuppression(
  recover: boolean,
  openAudit: () => SuppressionAudit,
  openPrimary: () => FailingChannel,
  openSecondary: () => FailingChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    await using primary = openPrimary();
    await using secondary = openSecondary();
    await secondary.send().then(() => undefined);
  } catch (error) {
    if (recover) {
      audit.record("recovered");
    } else {
      throw error;
    }
  } finally {
    audit.record("finally");
  }
  await audit.flush().then(() => undefined);
}
