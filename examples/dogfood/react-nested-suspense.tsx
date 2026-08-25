import { Suspense, useEffect } from "react";

/* uneffect: react component */
export function AccountPanel() {
  useEffect(() => {
    console.log("account visible");
    return () => console.log("account hidden");
  }, []);
  return <section>Account</section>;
}

/* uneffect: react component */
export function AccountSpinner() {
  useEffect(() => () => console.log("account spinner hidden"), []);
  return <p>Loading account…</p>;
}

/* uneffect: react component */
export function PageSpinner() {
  useEffect(() => () => console.log("page spinner hidden"), []);
  return <p>Loading page…</p>;
}

export function AccountPage() {
  return <Suspense fallback={<PageSpinner />}>
    <Suspense fallback={<AccountSpinner />}><AccountPanel /></Suspense>
  </Suspense>;
}
