declare function sendTelemetryBatch(): Promise<void>;
/* uneffect: consumes_rejection 0 */
declare function keepSendingWhileOnline(delivery: Promise<void>): boolean;
/* uneffect: effect Throw<Error> */
declare function failTelemetryGate(): never;

export async function deliverTelemetry(mode: "required" | "best-effort"): Promise<void> {
  let delivery: Promise<void>;
  delivery = sendTelemetryBatch();
  switch (mode) {
    case "required":
      await delivery;
      break;
    case "best-effort":
      delivery.catch(() => undefined);
      break;
  }
}

export async function flushTelemetryBeforeExit(skipWork: boolean): Promise<void> {
  const delivery = sendTelemetryBatch();
  try {
    if (skipWork) return;
  } finally {
    await delivery;
  }
}

export async function handOffTelemetryUntilOffline(): Promise<void> {
  const delivery = sendTelemetryBatch();
  while (keepSendingWhileOnline(delivery)) break;
}

export async function deliverTelemetryAtLeastOnce(): Promise<void> {
  const delivery = sendTelemetryBatch();
  while (true) {
    await delivery;
    break;
  }
}

export async function recoverFromTelemetryGateFailure(): Promise<void> {
  const delivery = sendTelemetryBatch();
  try {
    while (failTelemetryGate()) {}
  } catch {
    await delivery;
  }
}
