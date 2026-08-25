import { useActionState } from "react";

declare namespace JSX {
  interface IntrinsicElements {
    form: { action?: unknown; children?: unknown };
    button: { type?: string; children?: unknown };
    p: { role?: string; children?: unknown };
  }
}

/* uneffect: effect Fetch | Throw<TypeError> */
declare function submitOrder(quantity: number): Promise<number>;

/* uneffect: react component */
export function Checkout() {
  const [quantity, dispatchOrder, pending] = useActionState(async (previous: number, next: number) => {
    if (!Number.isSafeInteger(next) || next <= 0) throw new TypeError("quantity must be a positive integer");
    await submitOrder(next);
    return previous + next;
  }, 0);
  return <form action={dispatchOrder}>
    <button type="submit">{pending ? "Submitting" : `Order ${quantity}`}</button>
  </form>;
}

/* uneffect: react component */
export function CheckoutError() {
  return <p role="alert">The order could not be completed.</p>;
}

