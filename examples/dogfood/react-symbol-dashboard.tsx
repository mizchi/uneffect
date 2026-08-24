import { useDocumentTitle as useTitleFromBarrel } from "./react-symbol-barrel.js";
import useRefreshAudit, * as symbolHooks from "./react-symbol-hooks.js";

/* uneffect: react component */
export function SymbolResolvedDashboard(props: { title: string; endpoint: string }): null {
  useTitleFromBarrel(props.title);
  symbolHooks.useDocumentTitle(props.title);
  useRefreshAudit(props.endpoint);
  return null;
}
