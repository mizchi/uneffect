declare function sendTelemetryBatch(): Promise<void>;

export async function deliverTelemetry(mode: "required" | "best-effort"): Promise<void> {
  const delivery = sendTelemetryBatch();
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
