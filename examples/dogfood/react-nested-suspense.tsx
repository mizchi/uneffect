import { Suspense, use, useEffect } from "react";

declare const accountPromise: Promise<{ name: string }>;

/* uneffect:react-component */
export function AccountPanel() {
  const account = use(accountPromise);
  useEffect(() => {
    console.log("account visible");
    return () => console.log("account hidden");
  }, []);
  return <section>{account.name}</section>;
}

/* uneffect:react-component */
export function AccountSpinner() {
  useEffect(() => () => console.log("account spinner hidden"), []);
  return <p>Loading account…</p>;
}

/* uneffect:react-component */
export function PageSpinner() {
  useEffect(() => () => console.log("page spinner hidden"), []);
  return <p>Loading page…</p>;
}

/* uneffect:react-component */
export function AccountNavigation() {
  return <nav>Account navigation</nav>;
}

export function AccountPage() {
  return <Suspense fallback={<PageSpinner />}>
    <>
      <AccountNavigation />
      <Suspense fallback={<AccountSpinner />}><AccountPanel /></Suspense>
    </>
  </Suspense>;
}
