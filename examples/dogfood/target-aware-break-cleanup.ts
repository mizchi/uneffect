// A bounded delivery loop whose policy exits early from mandatory finally.
// The loop-scoped session must finish asynchronous disposal before the
// post-loop report starts, while an ordinary iteration must still advance to
// the next acquisition generation.

export interface BreakableDeliverySession extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverUntilStop(
  stop: boolean,
  open: () => BreakableDeliverySession,
  report: () => Promise<void>,
): Promise<void> {
  attempts: for (let attempt = 0; attempt < 2; attempt++) {
    await using session = open();
    try {
      await session.send().then(() => undefined);
    } finally {
      if (stop) break attempts;
    }
  }
  await report().then(() => undefined);
}
