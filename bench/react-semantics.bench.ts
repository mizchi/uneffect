import ts from "typescript";
import { bench, describe } from "vitest";
import { analyzeReactProgram, analyzeReactSemantics, generateReactActionErrorBoundaryQuintFromAnalysis, generateReactActionQueueQuint, generateReactLifecycleQuint, generateReactNestedSuspenseQuintFromAnalysis, generateReactSuspenseBoundaryQuint, generateReactSuspenseFallbackQuintFromAnalysis, generateReactSuspenseTreeQuintFromAnalysis, generateReactTransitionQuint, generateReactTransitionSuspenseQuintFromAnalysis } from "../src/react-semantics.js";

const components = Array.from({ length: 128 }, (_, index) => `
  /* uneffect: react component */
  export const Item${index} = memo(function Item${index}(props: { label: string; active: boolean; ref: unknown }) {
    const options = useRef<{ method: "POST" } | null>(null)
    const optionsAlias = options
    if (optionsAlias.current === null) optionsAlias.current = { method: "POST" }
    const propsSnapshot = props
    const [selection] = useState({ active: propsSnapshot.active })
    const selectionSnapshot = selection
    const preferences = useContext(PreferencesContext) as { dense: boolean }
    const catalogVersion = useCatalogVersion()
    const [savedLabel, saveLabel] = useActionState(async (previous: string) => { await persistLabel(props.label); return previous }, props.label)
    const [optimisticLabel] = useOptimistic(savedLabel, (_previous, next: string) => next)
    useImperativeHandle(props.ref, () => ({ refresh() { fetch("/items/${index}/imperative") } }), [])
    useInsertionEffect(() => { insertRule(); return () => removeRule() }, [])
    useCatalogSubscription(props.label)
    const refresh = () => fetch("/items/${index}", optionsAlias.current ?? undefined)
    const refreshAlias = refresh
    const handleClick = () => startTransition(refreshAlias)
    const attach = () => { const subscription = subscribe(props.label); return () => unsubscribe(subscription) }
    const attachAlias = attach
    return <button
      ref={attachAlias}
      onClick={handleClick}
    >{props.label}{catalogVersion}{optimisticLabel}{selectionSnapshot.active && preferences.dense}</button>
  })
`).join("\n");

const source = `
  import { memo, startTransition, useActionState, useContext, useEffect, useEffectEvent, useImperativeHandle, useInsertionEffect, useOptimistic, useRef, useState, useSyncExternalStore } from "react"
  declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void; ref?: unknown; children?: unknown } } }
  declare const PreferencesContext: object
  interface Subscription { readonly label: string }
  /* uneffect: react acquire Subscription result */
  declare function subscribe(label: string): Subscription
  /* uneffect: react release Subscription parameter 0 */
  declare function unsubscribe(subscription: Subscription): void
  /* uneffect: effect StyleWrite */
  declare function insertRule(): void
  /* uneffect: effect StyleWrite */
  declare function removeRule(): void
  /* uneffect: effect LabelSave */
  declare function persistLabel(label: string): Promise<void>
  interface CatalogVersionSubscription { readonly id: string }
  /* uneffect: react acquire CatalogVersionSubscription result */
  declare function openCatalogVersion(notify: () => void): CatalogVersionSubscription
  /* uneffect: react release CatalogVersionSubscription parameter 0 */
  declare function closeCatalogVersion(subscription: CatalogVersionSubscription): void
  /* uneffect: effect CatalogVersionRead */
  declare function readCatalogVersion(): number
  function subscribeCatalogVersion(notify: () => void) {
    const subscription = openCatalogVersion(notify)
    return () => closeCatalogVersion(subscription)
  }
  function getCatalogVersionSnapshot() { return readCatalogVersion() }
  /* uneffect: react hook */
  function useCatalogVersion() {
    return useSyncExternalStore(subscribeCatalogVersion, getCatalogVersionSnapshot)
  }
  /* uneffect: react hook */
  function useCatalogSubscription(label: string) {
    const reportConnected = useEffectEvent(() => console.log(label))
    useEffect(() => {
      reportConnected()
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
const causalSource = `
  import { Suspense, use } from "react"
  const data = Promise.resolve("ready")
  /* uneffect: react component */ function Data() { use(data); return null }
  /* uneffect: react component */ function Static() { return null }
  /* uneffect: react component */ function Fallback() { return null }
  function App() { return <Suspense fallback={<Fallback />}><><Static /><Data /></></Suspense> }
`;
const causalOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.Preserve, noEmit: true };
const causalHost = ts.createCompilerHost(causalOptions), causalOriginalGetSourceFile = causalHost.getSourceFile.bind(causalHost);
causalHost.getSourceFile = (fileName, languageVersion, onError, fresh) => fileName === "causal.tsx"
  ? ts.createSourceFile(fileName, causalSource, languageVersion, true, ts.ScriptKind.TSX)
  : causalOriginalGetSourceFile(fileName, languageVersion, onError, fresh);
const causalProgram = ts.createProgram(["causal.tsx"], causalOptions, causalHost);
const causalResults = analyzeReactProgram(causalProgram);
const actionError = analyzeReactSemantics("checkout.tsx", `
  import { useActionState } from "react"
  /* uneffect: react component */ function Checkout() {
    useActionState(() => { throw new Error("failed") }, 0)
    return null
  }
  /* uneffect: react component */ function CheckoutError() { return null }
`);

describe("React semantic analysis", () => {
  bench("parse and classify 128 opted-in components", () => {
    analyzeReactSemantics("catalog.tsx", source);
  }, { time: 1_000, iterations: 30 });

  bench("TypeScript TSX parse baseline", () => {
    ts.createSourceFile("catalog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }, { time: 1_000, iterations: 30 });

  bench("classify one reused TypeScript Program", () => {
    analyzeReactProgram(program);
  }, { time: 1_000, iterations: 30 });

  bench("generate Strict Mode Quint for 128 summaries", () => {
    analyzed.components.forEach((component, index) => generateReactLifecycleQuint(`component_${index}`, component));
  }, { time: 500, iterations: 20 });

  bench("generate 128 bounded React Action queues", () => {
    analyzed.components.forEach((_component, index) => generateReactActionQueueQuint(`action_queue_${index}`, { maxQueuedActions: 3 }));
  }, { time: 500, iterations: 20 });

  bench("generate Action/Error Boundary Quint", () => {
    generateReactActionErrorBoundaryQuintFromAnalysis(
      "action_error", actionError, "Checkout", "CheckoutError", { maxQueuedActions: 3 },
    );
  }, { time: 500, iterations: 20 });

  bench("generate 128 bounded React Transitions", () => {
    analyzed.components.forEach((_component, index) => generateReactTransitionQuint(`transition_${index}`, { maxActions: 3 }));
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

  bench("generate already-revealed Transition/Suspense Quint", () => {
    generateReactTransitionSuspenseQuintFromAnalysis("transition_suspense", nested);
  }, { time: 500, iterations: 20 });

  bench("generate fallback-eligible Suspense Quint", () => {
    generateReactSuspenseFallbackQuintFromAnalysis("fallback_eligible", nested, { scenario: "newlyMountedTransition" });
  }, { time: 500, iterations: 20 });

  bench("generate Fragment/multi-child Suspense-tree Quint", () => {
    generateReactSuspenseTreeQuintFromAnalysis("suspense_tree", suspenseTree);
  }, { time: 500, iterations: 20 });

  bench("classify one reused causal Suspense Program", () => {
    analyzeReactProgram(causalProgram);
  }, { time: 500, iterations: 20 });

  bench("generate known-thenable Suspense-tree Quint", () => {
    generateReactSuspenseTreeQuintFromAnalysis("causal_tree", causalResults.get("causal.tsx")!, 0, { requireKnownSuspension: true });
  }, { time: 500, iterations: 20 });
});
