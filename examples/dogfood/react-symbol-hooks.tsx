import { useEffect, useLayoutEffect } from "react";

/* uneffect: react hook */
export function useDocumentTitle(title: string): void {
  useLayoutEffect(() => {
    document.title = title;
  }, [title]);
}

/* uneffect: react hook */
export default function useRefreshAudit(endpoint: string): void {
  useEffect(() => {
    console.log("refresh audit", endpoint);
  }, [endpoint]);
}
