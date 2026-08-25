import ts from "typescript";
import { bench, describe } from "vitest";
import { analyzeReactProgram, analyzeReactSemantics, generateReactLifecycleQuint, generateReactNestedSuspenseQuintFromAnalysis, generateReactSuspenseBoundaryQuint, generateReactSuspenseTreeQuintFromAnalysis } from "../src/react-semantics.js";

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
const nested = analyzeReactSemantics("nested.tsx", `
  import { Suspense } from "react"
  /* uneffect: react component */ function Primary() { return null }
  /* uneffect: react component */ function InnerFallback() { return null }
  /* uneffect: react component */ function OuterFallback() { return null }
  function App() { return <Suspense fallback={<OuterFallback />}><Suspense fallback={<InnerFallback />}><Primary /></Suspense></Suspense> }
`);
const suspenseTree = analyzeReactSemantics("tree.tsx", `
  import { Suspense } from "react"
  /* uneffect: react component */ function OuterLeaf() { return null }
  /* uneffect: react component */ function InnerLeafA() { return null }
  /* uneffect: react component */ function InnerLeafB() { return null }
  /* uneffect: react component */ function InnerFallback() { return null }
  /* uneffect: react component */ function OuterFallback() { return null }
  function App() { return <Suspense fallback={<OuterFallback />}><><OuterLeaf /><Suspense fallback={<InnerFallback />}><><InnerLeafA /><InnerLeafB /></></Suspense></></Suspense> }
`);

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

  bench("generate dependency-change Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`dependency_${index}`, component, "dependencyChange"));
  }, { time: 500, iterations: 20 });

  bench("generate Suspense-retry Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`suspense_${index}`, component, "suspenseRetry"));
  }, { time: 500, iterations: 20 });

  bench("generate repeated-Suspense-retry Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`repeated_suspense_${index}`, component, "repeatedSuspenseRetry"));
  }, { time: 500, iterations: 20 });

  bench("generate Suspense fallback-boundary Quint for 64 pairs", () => {
    for (let index = 0; index < analyzed.components.length; index += 2) {
      generateReactSuspenseBoundaryQuint(`fallback_boundary_${index}`, analyzed.components[index]!, analyzed.components[index + 1]!);
    }
  }, { time: 500, iterations: 20 });

  bench("generate nested-Suspense ownership Quint", () => {
    generateReactNestedSuspenseQuintFromAnalysis("nested_boundary", nested);
  }, { time: 500, iterations: 20 });

  bench("generate Fragment/multi-child Suspense-tree Quint", () => {
    generateReactSuspenseTreeQuintFromAnalysis("suspense_tree", suspenseTree);
  }, { time: 500, iterations: 20 });
});
