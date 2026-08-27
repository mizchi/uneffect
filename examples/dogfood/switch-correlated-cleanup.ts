export type DeliveryRoute = "primary" | "secondary" | "backup";

export interface SwitchAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface SwitchChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverByRoute(
  route: DeliveryRoute,
  recover: boolean,
  openAudit: () => SwitchAudit,
  openPrimary: () => SwitchChannel,
  openSecondary: () => SwitchChannel,
  openBackup: () => SwitchChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    switch (route) {
      case "primary": {
        await using primary = openPrimary();
        await primary.send().then(() => undefined);
        break;
      }
      case "secondary": {
        await using secondary = openSecondary();
        await secondary.send().then(() => undefined);
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
