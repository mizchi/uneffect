import { lookup } from "node:dns";

/** Resolve and report a deployment endpoint without wrapping the Node builtin. */
/* uneffect:effect Net | Console */
export function reportDeploymentAddress(hostname: string): void {
  lookup(hostname, (error, address) => {
    if (error) {
      console.error("DNS lookup failed", error.message);
      return;
    }
    console.info("deployment address", address);
  });
}
