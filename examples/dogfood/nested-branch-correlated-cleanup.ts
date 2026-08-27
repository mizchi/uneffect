export interface NestedBranchAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface NestedBranchChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverNestedChoice(
  usePreferred: boolean,
  usePrimary: boolean,
  recover: boolean,
  openAudit: () => NestedBranchAudit,
  openPrimary: () => NestedBranchChannel,
  openSecondary: () => NestedBranchChannel,
  openBackup: () => NestedBranchChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    if (usePreferred) {
      if (usePrimary) {
        await using primary = openPrimary();
        await primary.send().then(() => undefined);
      } else {
        await using secondary = openSecondary();
        await secondary.send().then(() => undefined);
      }
    } else {
      await using backup = openBackup();
      await backup.send().then(() => undefined);
    }
  } catch (error) {
    if (recover) audit.record("recovered");
    else throw error;
  } finally {
    audit.record("finally");
  }
  await audit.flush().then(() => undefined);
}
