// A realistic boundary case: retry policy owns an outer attempt loop while
// await-using cleanup runs inside try/finally. Uneffect retains the continue
// target but currently refuses unified lowering because the outer loop is not
// yet part of the handler CFG. This explicit non-proof prevents cleanup from
// being certified by treating the retry as ordinary fallthrough.

export interface DeliverySession extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverWithRetry(
  retry: boolean,
  open: () => Promise<DeliverySession>,
): Promise<void> {
  attempts: for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await using session = await open();
      await session.send();
    } finally {
      if (retry) continue attempts;
    }
  }
}
