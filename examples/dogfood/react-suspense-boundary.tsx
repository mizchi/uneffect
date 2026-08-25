import { Suspense, useEffect } from "react";

declare function readProfile(userId: string): string;

/* uneffect: react component */
export function Profile({ userId }: { userId: string }) {
  const profile = readProfile(userId);
  useEffect(() => {
    console.log("profile visible", userId);
    return () => console.log("profile hidden", userId);
  }, [userId]);
  return <article>{profile}</article>;
}

/* uneffect: react component */
export function ProfileSpinner() {
  useEffect(() => {
    console.log("spinner visible");
    return () => console.log("spinner hidden");
  }, []);
  return <p>Loading profile…</p>;
}

export function ProfileBoundary({ userId }: { userId: string }) {
  return <Suspense fallback={<ProfileSpinner />}><Profile userId={userId} /></Suspense>;
}
