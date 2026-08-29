import { refreshRemoteTelemetry, useDocumentTitle as useTitleFromBarrel } from "./react-symbol-barrel.js";
import useRefreshAudit, * as symbolHooks from "./react-symbol-hooks.js";

declare namespace JSX {
  interface IntrinsicElements {
    button: { onClick?: () => void; ref?: unknown };
  }
}

/* uneffect:react-component */
export function SymbolResolvedDashboard(props: { title: string; endpoint: string }) {
  useTitleFromBarrel(props.title);
  symbolHooks.useDocumentTitle(props.title);
  useRefreshAudit(props.endpoint);
  return <button onClick={refreshRemoteTelemetry} ref={symbolHooks.attachRemoteTelemetry} />;
}
