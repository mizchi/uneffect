// A realistic bounded case: retry policy owns an outer attempt loop while an
// await-using resource spans delivery and its finally policy. Continuing the
// labeled loop exits that resource scope, so disposal must finish before the
// next acquisition generation begins.

export interface DeliverySession extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverWithRetry(
  retry: boolean,
  open: () => DeliverySession,
): Promise<void> {
  attempts: for (let attempt = 0; attempt < 2; attempt++) {
    await using session = open();
    try {
      await session.send().then(() => undefined);
    } finally {
      if (retry) continue attempts;
    }
  }
}
