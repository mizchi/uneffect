interface DeliverySession {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openDeliverySession(): DeliverySession;

export async function finalizeDelivery(status: "sent" | "cancelled" | "expired" | "already-closed"): Promise<void> {
  let pending: DeliverySession | undefined;
  {
    await using session = openDeliverySession();
    pending = session;
  }
  switch (status) {
    case "sent":
    case "cancelled": pending = undefined; break;
    case "expired": pending = undefined; break;
    case "already-closed": return;
  }
  pending?.flush();
}

export async function finalizeConditional(alreadyClosed: boolean): Promise<void> {
  let pending: DeliverySession | undefined;
  {
    await using session = openDeliverySession();
    pending = session;
  }
  if (alreadyClosed) return;
  else pending = undefined;
  pending?.flush();
}

export async function finalizeDeliveryBatch(deliveryIds: readonly string[]): Promise<void> {
  let pending: DeliverySession | undefined;
  for (const deliveryId of deliveryIds) {
    {
      await using session = openDeliverySession();
      pending = session;
      void deliveryId;
    }
    pending = undefined; // iteration cleanup
  }
  pending?.flush();
}
