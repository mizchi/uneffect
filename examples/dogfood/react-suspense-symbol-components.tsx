import { useEffect } from "react";

/* uneffect:react-component */
export default function RemoteProfile() {
  useEffect(() => {
    console.log("remote profile visible");
    return () => console.log("remote profile hidden");
  }, []);
  return <article>Remote profile</article>;
}

/* uneffect:react-component */
export function RemoteSpinner() {
  useEffect(() => {
    console.log("remote spinner visible");
    return () => console.log("remote spinner hidden");
  }, []);
  return <p>Loading remote profile…</p>;
}
