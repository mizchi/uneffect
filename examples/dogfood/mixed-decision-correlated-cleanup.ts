export type MixedDeliveryRoute = "preferred" | "backup";

export interface MixedDecisionAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface MixedDecisionChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverMixedChoice(
  route: MixedDeliveryRoute,
  usePrimary: boolean,
  recover: boolean,
  openAudit: () => MixedDecisionAudit,
  openPrimary: () => MixedDecisionChannel,
  openSecondary: () => MixedDecisionChannel,
  openBackup: () => MixedDecisionChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    switch (route) {
      case "preferred": {
        if (usePrimary) {
          await using primary = openPrimary();
          await primary.send().then(() => undefined);
        } else {
          await using secondary = openSecondary();
          await secondary.send().then(() => undefined);
        }
        break;
      }
      default: {
        await using backup = openBackup();
        await backup.send().then(() => undefined);
      }
    }
  } catch (error) {
    if (recover) audit.record("recovered");
    else throw error;
  } finally {
    audit.record("finally");
  }
  await audit.flush().then(() => undefined);
}
