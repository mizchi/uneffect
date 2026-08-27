export interface ConditionalLoopChannel extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverConditionalGenerations(
  usePrimary: boolean,
  retry: boolean,
  stop: boolean,
  openPrimary: () => ConditionalLoopChannel,
  openSecondary: () => ConditionalLoopChannel,
  checkpoint: () => Promise<void>,
  report: () => Promise<void>,
): Promise<void> {
  attempts: for (let attempt = 0; attempt < 2; attempt++) {
    if (usePrimary) {
      await using primary = openPrimary();
      await primary.send().then(() => undefined);
    } else {
      await using secondary = openSecondary();
      await secondary.send().then(() => undefined);
    }

    try {
      await checkpoint().then(() => undefined);
    } catch {
      void 0;
    } finally {
      if (stop) break attempts;
      if (retry) continue attempts;
    }
  }
  await report().then(() => undefined);
}
