export interface UploadSession extends AsyncDisposable {
  upload(part: Uint8Array): Promise<void>;
  abort(): void;
}

declare function openUploadSession(destination: string): Promise<UploadSession>;

export async function uploadConfiguredParts(
  destination: string,
  parts: readonly Uint8Array[],
): Promise<void> {
  let activeSession: UploadSession | undefined;

  for (const part of parts) {
    await using session = await openUploadSession(destination);
    activeSession = session;
    try {
      await session.upload(part);
    } finally {
      // This must execute on fulfillment, rejection, and loop transfer before
      // the session's lexical async disposal completes.
      activeSession = undefined;
    }
  }

  // A stale session here would already have been asynchronously disposed.
  activeSession?.abort();
}
