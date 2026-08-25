import { Suspense } from "react";
import {
  ProfileFromBarrel as Profile,
  SpinnerFromBarrel as Spinner,
} from "./react-suspense-symbol-barrel.js";

export function RemoteProfileBoundary() {
  return <Suspense fallback={<Spinner />}><Profile /></Suspense>;
}
