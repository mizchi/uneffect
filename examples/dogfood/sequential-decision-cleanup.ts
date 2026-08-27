export type SequentialDeliveryRoute = "archive" | "mirror";

export interface SequentialAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface SequentialChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverSequential(
  usePrimary: boolean,
  laterRoute: SequentialDeliveryRoute,
  recover: boolean,
  openAudit: () => SequentialAudit,
  openPrimary: () => SequentialChannel,
  openSecondary: () => SequentialChannel,
  openArchive: () => SequentialChannel,
  openMirror: () => SequentialChannel,
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

    switch (laterRoute) {
      case "archive": {
        await using archive = openArchive();
        await archive.send().then(() => undefined);
        break;
      }
      default: {
        await using mirror = openMirror();
        await mirror.send().then(() => undefined);
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
