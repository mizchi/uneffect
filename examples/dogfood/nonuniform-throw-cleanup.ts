export type NonUniformThrowRoute = "archive" | "mirror";

export class NonUniformDeliveryError extends Error {}

export interface NonUniformThrowAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface NonUniformThrowChannel extends AsyncDisposable {
  send(): Promise<void>;
}

/* uneffect:effect Throw<NonUniformDeliveryError> */
export async function deliverNonUniformThrow(
  throwEarly: boolean,
  laterRoute: NonUniformThrowRoute,
  recover: boolean,
  openAudit: () => NonUniformThrowAudit,
  openPrimary: () => NonUniformThrowChannel,
  openSecondary: () => NonUniformThrowChannel,
  openArchive: () => NonUniformThrowChannel,
  openMirror: () => NonUniformThrowChannel,
): Promise<void> {
  using audit = openAudit();
  try {
    if (throwEarly) {
      await using primary = openPrimary();
      await primary.send().then(() => undefined);
      throw new NonUniformDeliveryError("primary delivery failed");
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
    if (recover && error instanceof NonUniformDeliveryError) audit.record("recovered");
    else throw error;
  } finally {
    audit.record("finally");
  }
  await audit.flush().then(() => undefined);
}
