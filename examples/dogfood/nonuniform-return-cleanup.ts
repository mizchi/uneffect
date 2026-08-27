export type NonUniformDeliveryRoute = "archive" | "mirror";

export interface NonUniformAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface NonUniformChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverNonUniform(
  returnEarly: boolean,
  laterRoute: NonUniformDeliveryRoute,
  recover: boolean,
  openAudit: () => NonUniformAudit,
  openPrimary: () => NonUniformChannel,
  openSecondary: () => NonUniformChannel,
  openArchive: () => NonUniformChannel,
  openMirror: () => NonUniformChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    if (returnEarly) {
      await using primary = openPrimary();
      await primary.send().then(() => undefined);
      return;
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
