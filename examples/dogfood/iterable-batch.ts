function* pendingTelemetryBatches(): Generator<Promise<number>, void, void> {
  yield Promise.resolve(1);
  throw new Error("telemetry spool is corrupt");
}

export async function drainTelemetrySpool(): Promise<void> {
  try {
    await Promise.allSettled(pendingTelemetryBatches());
  } catch {
    // allSettled contains element rejection, but iterator failure still rejects.
  }
}
