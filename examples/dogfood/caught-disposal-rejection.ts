// The inner async resource is acquired inside the try. Its async disposal is
// therefore part of try completion: rejection enters the enclosing catch,
// recovery continues through finally and the outer audit flush, while rethrow
// still executes finally and disposes the outer audit exactly once.

export interface DisposalAudit extends Disposable {
  record(event: "recovered" | "finally"): void;
  flush(): Promise<void>;
}

export interface RejectingSession extends AsyncDisposable {
  send(): Promise<void>;
}

export async function deliverAfterDisposal(
  recover: boolean,
  openAudit: () => DisposalAudit,
  openSession: () => RejectingSession,
): Promise<void> {
  using audit = openAudit();
  try {
    await using session = openSession();
    await session.send().then(() => undefined);
  } catch (error) {
    if (recover) {
      audit.record("recovered");
    } else {
      throw error;
    }
  } finally {
    audit.record("finally");
  }
  await audit.flush().then(() => undefined);
}
