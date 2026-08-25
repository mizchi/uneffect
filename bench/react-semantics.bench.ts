import ts from "typescript";
import { bench, describe } from "vitest";
import { analyzeReactProgram, analyzeReactSemantics, generateReactLifecycleQuint } from "../src/react-semantics.js";

const components = Array.from({ length: 128 }, (_, index) => `
  /* uneffect: react component */
  export function Item${index}(props: { label: string; active: boolean }) {
    const propsSnapshot = props
    const [selection] = useState({ active: propsSnapshot.active })
    const selectionSnapshot = selection
    const preferences = useContext(PreferencesContext) as { dense: boolean }
    useCatalogSubscription(props.label)
    return <button
      ref={() => { const subscription = subscribe(props.label); return () => unsubscribe(subscription) }}
      onClick={() => fetch("/items/${index}")}
    >{props.label}{selectionSnapshot.active && preferences.dense}</button>
  }
`).join("\n");

const source = `
  import { useContext, useEffect, useState } from "react"
  declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void; ref?: unknown; children?: unknown } } }
  declare const PreferencesContext: object
  interface Subscription { readonly label: string }
  /* uneffect: react acquire Subscription result */
  declare function subscribe(label: string): Subscription
  /* uneffect: react release Subscription parameter 0 */
  declare function unsubscribe(subscription: Subscription): void
  /* uneffect: react hook */
  function useCatalogSubscription(label: string) {
    useEffect(() => {
      const subscription = subscribe(label)
      return () => unsubscribe(subscription)
    }, [label])
  }
  ${components}
`;
const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.Preserve, noEmit: true };
const host = ts.createCompilerHost(compilerOptions), originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, languageVersion, onError, fresh) => fileName === "catalog.tsx"
  ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TSX)
  : originalGetSourceFile(fileName, languageVersion, onError, fresh);
const program = ts.createProgram(["catalog.tsx"], compilerOptions, host);
const analyzed = analyzeReactSemantics("catalog.tsx", source);

describe("React semantic analysis", () => {
  bench("parse and classify 128 opted-in components", () => {
    analyzeReactSemantics("catalog.tsx", source);
  }, { time: 500, iterations: 20 });

  bench("TypeScript TSX parse baseline", () => {
    ts.createSourceFile("catalog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }, { time: 500, iterations: 20 });

  bench("classify one reused TypeScript Program", () => {
    analyzeReactProgram(program);
  }, { time: 500, iterations: 20 });

  bench("generate Strict Mode Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`component_${index}`, component));
  }, { time: 500, iterations: 20 });

  bench("generate interrupted-render Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`interrupted_${index}`, component, "concurrentInterruption"));
  }, { time: 500, iterations: 20 });
});
