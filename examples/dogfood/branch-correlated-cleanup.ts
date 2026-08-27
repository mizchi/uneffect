// Exactly one branch-local async resource exists per invocation. Rejection from
// its body or disposal must clean the selected generation before the shared
// catch/finally; the unselected branch must remain unacquired and undisposed.

export interface BranchAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface BranchChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverSelected(
  usePrimary: boolean,
  recover: boolean,
  openAudit: () => BranchAudit,
  openPrimary: () => BranchChannel,
  openSecondary: () => BranchChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    if (usePrimary) {
      await using primary = openPrimary();
      await primary.send().then(() => undefined);
    } else {
      await using secondary = openSecondary();
      await secondary.send().then(() => undefined);
    }
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
