import * as React from "react";
import * as views from "./react-suspense-symbol-barrel.js";

export function RemoteProfileBoundary() {
  return <React.Suspense fallback={<views.SpinnerFromBarrel />}>
    <views.ProfileFromBarrel />
  </React.Suspense>;
}
