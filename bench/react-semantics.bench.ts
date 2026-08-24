import ts from "typescript";
import { bench, describe } from "vitest";
import { analyzeReactSemantics } from "../src/react-semantics.js";

const components = Array.from({ length: 128 }, (_, index) => `
  /* uneffect: react component */
  export function Item${index}(props: { label: string; active: boolean }) {
    useEffect(() => {
      subscribe()
      return () => unsubscribe()
    }, [props.label])
    return <button onClick={() => fetch("/items/${index}")}>{props.label}</button>
  }
`).join("\n");

const source = `
  import { useEffect } from "react"
  declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void; children?: unknown } } }
  /* uneffect: react acquire Subscription */
  declare function subscribe(): void
  /* uneffect: react release Subscription */
  declare function unsubscribe(): void
  ${components}
`;

describe("React semantic analysis", () => {
  bench("parse and classify 128 opted-in components", () => {
    analyzeReactSemantics("catalog.tsx", source);
  }, { time: 500, iterations: 20 });

  bench("TypeScript TSX parse baseline", () => {
    ts.createSourceFile("catalog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }, { time: 500, iterations: 20 });
});
