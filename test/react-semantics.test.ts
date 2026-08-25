import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { reportDiagnostic } from "../src/diagnostics.js";
import { analyzeReactSemantics, analyzeReactSemanticsInProgram, generateReactLifecycleQuint, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis } from "../src/react-semantics.js";

describe("React Function Component semantics", () => {
  it("checks only explicitly annotated components during gradual adoption", () => {
    const result = analyzeReactSemantics("components.tsx", `
      declare namespace JSX { interface IntrinsicElements { button: unknown } }
      /* uneffect: react component */
      function Checked() {
        console.log("render")
        return <button />
      }
      function Legacy() {
        console.log("legacy render")
        return <button />
      }
    `);

    expect(result.components.map(({ name }) => name)).toEqual(["Checked"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ component: "Checked", kind: "render-effect", phase: "render", effect: "Console" }),
    ]);
  });

  it("rejects malformed or meaningless React annotations", () => {
    const result = analyzeReactSemantics("invalid.tsx", `
      /* uneffect: react components */
      function Typo() { return null }
      /* uneffect: react acquire */
      declare function incomplete(): void
      /* uneffect: react release Socket trailing */
      declare function excessive(): void
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ functionName: "Typo", kind: "invalid-react-annotation" }),
      expect.objectContaining({ functionName: "incomplete", kind: "invalid-react-annotation" }),
      expect.objectContaining({ functionName: "excessive", kind: "invalid-react-annotation" }),
    ]);
  });

  it("separates render, event, passive-effect, layout-effect, and cleanup phases", () => {
    const result = analyzeReactSemantics("phases.tsx", `
      import { useEffect as passive, useLayoutEffect as layout } from "react"
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
      /* uneffect: react component */
      const Panel = () => {
        passive(() => {
          console.log("connect")
          return () => console.log("disconnect")
        }, [])
        layout(() => { document.title = "ready" }, [])
        return <button onClick={() => console.log("click")} />
      }
    `);

    expect(result.components).toEqual([
      expect.objectContaining({
        name: "Panel",
        phases: expect.arrayContaining([
          expect.objectContaining({ phase: "render" }),
          expect.objectContaining({ phase: "event" }),
          expect.objectContaining({ phase: "passive-effect" }),
          expect.objectContaining({ phase: "layout-effect" }),
          expect.objectContaining({ phase: "cleanup" }),
        ]),
      }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("separates callback refs from render and models their Strict Mode replay", () => {
    const result = analyzeReactSemantics("callback-ref.tsx", `
      import { useRef as ref } from "react"
      declare namespace JSX { interface IntrinsicElements { section: { ref?: unknown; children?: unknown } } }
      interface Observer { readonly id: string }
      /* uneffect: effect Console */
      /* uneffect: react acquire Observer result */
      declare function observe(node: Element | null): Observer
      /* uneffect: effect Console */
      /* uneffect: react release Observer parameter 0 */
      declare function disconnect(observer: Observer): void
      /* uneffect: react component */
      function Panel() {
        const host = ref<Element | null>(null)
        const observed = host.current
        host.current = observed
        return <section ref={(node) => {
          const observer = observe(node)
          return () => disconnect(observer)
        }}><section ref={host} /></section>
      }
    `);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "render-ref-access", phase: "render", operation: "host.current" }),
      expect.objectContaining({ kind: "render-ref-access", phase: "render", operation: "host.current" }),
    ]);
    expect(result.components[0]!.phases).toEqual(expect.arrayContaining([
      { phase: "ref-callback", effects: ["Console", "Acquire<Observer>"] },
      { phase: "cleanup", effects: ["Console", "Release<Observer>"] },
    ]));
    expect(result.components[0]!.replay.production.effects).toContainEqual(expect.objectContaining({
      phase: "ref-callback", transitions: ["setup"], setupEffects: ["Console", "Acquire<Observer>"],
      cleanupEffects: ["Console", "Release<Observer>"],
    }));
    expect(result.components[0]!.replay.strictModeDevelopment.effects).toContainEqual(expect.objectContaining({
      phase: "ref-callback", transitions: ["setup", "cleanup", "setup"],
    }));
  });

  it("requires callback-ref acquisitions to return matching cleanup", () => {
    const result = analyzeReactSemantics("leaking-ref.tsx", `
      declare namespace JSX { interface IntrinsicElements { div: { ref?: unknown } } }
      /* uneffect: react acquire Observer */
      declare function observe(node: Element | null): void
      /* uneffect: react component */
      function Leaking() {
        return <div ref={(node) => { observe(node) }} />
      }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: "missing-effect-cleanup", phase: "ref-callback", effect: "Observer",
    }));
  });

  it("fails closed for referenced or dynamically selected callback refs", () => {
    const result = analyzeReactSemantics("unknown-ref.tsx", `
      import { useRef } from "react"
      declare namespace JSX { interface IntrinsicElements { div: { ref?: unknown } } }
      declare const attach: (node: Element | null) => void
      declare const alternate: (node: Element | null) => void
      /* uneffect: react component */
      function Panel(props: { alternate: boolean }) {
        const objectRef = useRef<Element | null>(null)
        return <div ref={objectRef}><div ref={attach} /><div ref={props.alternate ? alternate : attach} /></div>
      }
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "unknown-ref-callback", phase: "ref-callback", operation: "attach" }),
      expect.objectContaining({ kind: "unknown-ref-callback", phase: "ref-callback", operation: "props.alternate ? alternate : attach" }),
    ]);
  });

  it("rejects non-idempotent render operations and mutation of props", () => {
    const result = analyzeReactSemantics("impure.tsx", `
      declare namespace JSX { interface IntrinsicElements { span: unknown } }
      interface Props { label: string }
      /* uneffect: react component */
      function Badge(props: Props) {
        props.label = String(Date.now() + Math.random())
        return <span>{props.label}</span>
      }
    `);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "Badge", kind: "immutable-input-mutation", phase: "render" }),
      expect.objectContaining({ component: "Badge", kind: "non-idempotent-render", operation: "Date.now" }),
      expect.objectContaining({ component: "Badge", kind: "non-idempotent-render", operation: "Math.random" }),
    ]));
  });

  it("tracks immutable props, state, and context snapshots through local aliases", () => {
    const result = analyzeReactSemantics("immutable-regions.tsx", `
      import { useContext as context, useReducer as reducer, useRef, useState as state } from "react"
      declare const ThemeContext: object
      interface Model { value: number }
      interface Props { profile: { name: string }; model: Model }
      /* uneffect: react component */
      function Editor({ profile, model }: Props) {
        const modelAlias = model
        let rebound = model
        rebound = { value: 3 }
        const [snapshot, setSnapshot] = state<Model>({ value: 0 })
        const snapshotAlias = snapshot
        const [reduced] = reducer((current: Model) => current, { value: 0 })
        const theme = context(ThemeContext) as { mode: string }
        const themeAlias = theme
        const ref = useRef<Model>({ value: 0 })
        profile.name = "render"
        modelAlias.value++
        snapshot.value = 1
        delete snapshotAlias.value
        reduced.value -= 1
        themeAlias.mode = "dark"
        rebound.value++
        setSnapshot({ value: 2 })
        return <button onClick={() => { ref.current.value++ }} />
      }
    `);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "profile.name" }),
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "modelAlias.value" }),
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "snapshot.value" }),
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "snapshotAlias.value" }),
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "reduced.value" }),
      expect.objectContaining({ kind: "immutable-input-mutation", operation: "themeAlias.mode" }),
    ]);
  });

  it("applies immutable snapshot regions inside annotated custom Hooks", () => {
    const result = analyzeReactSemantics("hook-regions.tsx", `
      import { useContext } from "react"
      declare const ModelContext: object
      /* uneffect: react hook */
      function useBrokenModel(input: { value: number }) {
        const inputAlias = input
        const context = useContext(ModelContext) as { value: number }
        inputAlias.value = 1
        context.value++
      }
    `);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ component: "useBrokenModel", kind: "immutable-input-mutation", operation: "inputAlias.value" }),
      expect.objectContaining({ component: "useBrokenModel", kind: "immutable-input-mutation", operation: "context.value" }),
    ]);
  });

  it("reports Hooks whose call order depends on control flow", () => {
    const result = analyzeReactSemantics("hooks.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Conditional({ enabled }: { enabled: boolean }) {
        if (enabled) useEffect(() => {}, [])
        return null
      }
    `);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      component: "Conditional", kind: "conditional-hook", hook: "useEffect", phase: "render",
    }));
  });

  it("composes an annotated custom Hook into the component phases", () => {
    const result = analyzeReactSemantics("custom-hook.tsx", `
      import { useEffect } from "react"
      /* uneffect: react hook */
      function useAudit() {
        useEffect(() => { console.log("committed") }, [])
      }
      /* uneffect: react component */
      function Dashboard({ enabled }: { enabled: boolean }) {
        useAudit()
        if (enabled) useAudit()
        return null
      }
    `);

    expect(result.components[0]!.phases).toContainEqual({ phase: "passive-effect", effects: ["Console"] });
    expect(result.hooks[0]!.replay.production.effects).toEqual([
      expect.objectContaining({ instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", setupEffects: ["Console"], cleanupEffects: [] }),
    ]);
    expect(result.components[0]!.replay.production.effects).toEqual([
      expect.objectContaining({ instance: expect.stringMatching(/^useAudit@\d+\/passive-effect@/), setupEffects: ["Console"], cleanupEffects: [] }),
      expect.objectContaining({ instance: expect.stringMatching(/^useAudit@\d+\/passive-effect@/), setupEffects: ["Console"], cleanupEffects: [] }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ component: "Dashboard", kind: "conditional-hook", hook: "useAudit" }),
    ]);
  });

  it("composes a custom Hook through a TypeScript-resolved import alias", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-hook-program-"));
    const hooksFile = join(directory, "hooks.tsx"), appFile = join(directory, "app.tsx");
    try {
      writeFileSync(hooksFile, `
        import { useLayoutEffect } from "react"
        /* uneffect: react hook */
        export function useDocumentTitle() {
          useLayoutEffect(() => { document.title = "ready" }, [])
        }
      `);
      writeFileSync(appFile, `
        import { useDocumentTitle as useTitle } from "./hooks.js"
        /* uneffect: react component */
        export function App({ active }: { active: boolean }) {
          if (active) useTitle()
          return null
        }
      `);
      const program = ts.createProgram([hooksFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const result = analyzeReactSemanticsInProgram(program, program.getSourceFile(appFile)!);
      expect(result.components[0]!.phases).toContainEqual({ phase: "layout-effect", effects: ["DomWrite"] });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ component: "App", kind: "conditional-hook", hook: "useTitle" }),
      ]);
      const checked = await checkFiles([hooksFile, appFile]);
      expect(checked.diagnostics.filter((diagnostic) => "component" in diagnostic)).toContainEqual(
        expect.objectContaining({ component: "App", kind: "conditional-hook", hook: "useTitle" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves barrel, namespace, and default custom Hook calls by TypeScript symbol", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-hook-imports-"));
    const namedFile = join(directory, "named.tsx"), barrelFile = join(directory, "barrel.ts");
    const defaultFile = join(directory, "default.tsx"), appFile = join(directory, "app.tsx");
    try {
      writeFileSync(namedFile, `
        import { useEffect, useLayoutEffect } from "react"
        /* uneffect: react hook */
        export function useAudit() { useEffect(() => console.log("audit"), []) }
        /* uneffect: react hook */
        export function useTitle() { useLayoutEffect(() => { document.title = "ready" }, []) }
      `);
      writeFileSync(barrelFile, `export { useAudit } from "./named.js"`);
      writeFileSync(defaultFile, `
        import { useEffect } from "react"
        /* uneffect: react hook */
        export default function useRefresh() { useEffect(() => { fetch("/refresh") }, []) }
      `);
      writeFileSync(appFile, `
        import { useAudit as useBarrelAudit } from "./barrel.js"
        import * as namedHooks from "./named.js"
        import useRefresh from "./default.js"
        /* uneffect: react component */
        export function App() {
          useBarrelAudit()
          namedHooks.useTitle()
          useRefresh()
          return null
        }
      `);
      const program = ts.createProgram([namedFile, barrelFile, defaultFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const result = analyzeReactSemanticsInProgram(program, program.getSourceFile(appFile)!);
      expect(result.diagnostics).toEqual([]);
      expect(result.components[0]!.phases).toEqual(expect.arrayContaining([
        { phase: "passive-effect", effects: expect.arrayContaining(["Console", "Fetch"]) },
        { phase: "layout-effect", effects: ["DomWrite"] },
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves lifecycle instances through transitive cross-module custom Hooks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-hook-transitive-"));
    const innerFile = join(directory, "inner.tsx"), outerFile = join(directory, "outer.tsx"), appFile = join(directory, "app.tsx");
    try {
      writeFileSync(innerFile, `
        import { useEffect } from "react"
        /* uneffect: react hook */
        export function useInner() { useEffect(() => { console.log("inner"); return () => console.log("cleanup") }, []) }
      `);
      writeFileSync(outerFile, `
        import { useInner } from "./inner.js"
        /* uneffect: react hook */
        export function useOuter() { useInner() }
      `);
      writeFileSync(appFile, `
        import { useOuter } from "./outer.js"
        /* uneffect: react component */
        export function App() { useOuter(); return null }
      `);
      const program = ts.createProgram([innerFile, outerFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const result = analyzeReactSemanticsInProgram(program, program.getSourceFile(appFile)!);
      expect(result.components[0]!.phases).toContainEqual({ phase: "passive-effect", effects: ["Console"] });
      expect(result.components[0]!.replay.production.effects).toEqual([
        expect.objectContaining({
          instance: expect.stringMatching(/^useOuter@\d+\/useInner@\d+\/passive-effect@/),
          phase: "passive-effect", setupEffects: ["Console"], cleanupEffects: ["Console"],
        }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects indirect custom Hook recursion", () => {
    const result = analyzeReactSemantics("recursive-hooks.tsx", `
      /* uneffect: react hook */
      function useFirst() { useSecond() }
      /* uneffect: react hook */
      function useSecond() { useThird() }
      /* uneffect: react hook */
      function useThird() { useFirst() }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "useFirst", kind: "recursive-hook", hook: "useSecond" }),
      expect.objectContaining({ functionName: "useSecond", kind: "recursive-hook", hook: "useThird" }),
      expect.objectContaining({ functionName: "useThird", kind: "recursive-hook", hook: "useFirst" }),
    ]));
  });

  it("rejects indirect custom Hook recursion across modules", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-hook-cycle-"));
    const firstFile = join(directory, "first.tsx"), secondFile = join(directory, "second.tsx");
    try {
      writeFileSync(firstFile, `
        import { useSecond } from "./second.js"
        /* uneffect: react hook */
        export function useFirst() { useSecond() }
      `);
      writeFileSync(secondFile, `
        import { useFirst } from "./first.js"
        /* uneffect: react hook */
        export function useSecond() { useFirst() }
      `);
      const program = ts.createProgram([firstFile, secondFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const first = analyzeReactSemanticsInProgram(program, program.getSourceFile(firstFile)!);
      const second = analyzeReactSemanticsInProgram(program, program.getSourceFile(secondFile)!);
      expect(first.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "useFirst", kind: "recursive-hook", hook: "useSecond",
      }));
      expect(second.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "useSecond", kind: "recursive-hook", hook: "useFirst",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks an annotated custom Hook as a replayable render boundary", () => {
    const result = analyzeReactSemantics("broken-hook.tsx", `
      import { useEffect } from "react"
      /* uneffect: react hook */
      function useBroken(options: { stamp: number; enabled: boolean }) {
        options.stamp = Date.now()
        if (options.enabled) useEffect(() => {}, [])
      }
    `);
    expect(result.diagnostics.map(({ functionName, kind }) => ({ functionName, kind }))).toEqual([
      { functionName: "useBroken", kind: "immutable-input-mutation" },
      { functionName: "useBroken", kind: "non-idempotent-render" },
      { functionName: "useBroken", kind: "conditional-hook" },
    ]);
  });

  it("fails closed for unresolved and directly recursive custom Hooks", () => {
    const result = analyzeReactSemantics("unknown-hooks.tsx", `
      declare function useOpaque(): void
      /* uneffect: react hook */
      function useRecursive() { useRecursive() }
      /* uneffect: react component */
      function App() { useOpaque(); return null }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "useRecursive", kind: "recursive-hook", hook: "useRecursive" }),
      expect.objectContaining({ functionName: "App", kind: "unknown-hook-summary", hook: "useOpaque" }),
    ]));
  });

  it("recognizes other named React Hooks without treating them as unresolved custom Hooks", () => {
    const result = analyzeReactSemantics("state.tsx", `
      import { useState as state } from "react"
      /* uneffect: react component */
      function Counter({ extra }: { extra: boolean }) {
        state(0)
        if (extra) state(1)
        return null
      }
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ functionName: "Counter", kind: "conditional-hook", hook: "state" }),
    ]);
  });

  it("executes reviewed lazy and memo callbacks in the replayable render phase", () => {
    const result = analyzeReactSemantics("render-hooks.tsx", `
      import { useMemo, useState, useCallback } from "react"
      /* uneffect: react component */
      function Values() {
        useMemo(() => { console.log("memo"); return Date.now() }, [])
        useState(() => Math.random())
        useCallback(() => console.log("event only"), [])
        return null
      }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "render-effect", effect: "Console" }),
      expect.objectContaining({ kind: "non-idempotent-render", operation: "Date.now" }),
      expect.objectContaining({ kind: "non-idempotent-render", operation: "Math.random" }),
    ]));
    expect(result.diagnostics).toHaveLength(3);
  });

  it("rejects stale Effect and memo closures with missing dependencies", () => {
    const result = analyzeReactSemantics("dependencies.tsx", `
      import { useEffect as effect, useMemo } from "react"
      /* uneffect: react component */
      function Dashboard(props: { service: string; rows: string[] }) {
        const prefix = props.service + ":"
        effect(() => console.log(props.service, prefix), [])
        useMemo(() => props.rows.map((row) => prefix + row), [props.rows])
        return null
      }
      /* uneffect: react component */
      function Shadowing({ row, rows }: { row: string; rows: string[] }) {
        useMemo(() => { console.log(row); return rows.map((row) => row) }, [rows])
        return null
      }
      /* uneffect: react component */
      function LocalFunction(props: { service: string }) {
        function load() { return props.service }
        effect(() => console.log(load()), [props.service])
        return null
      }
    `);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: "Dashboard", kind: "missing-hook-dependency", hook: "effect",
        dependencies: ["prefix", "props.service"],
      }),
      expect.objectContaining({
        component: "Dashboard", kind: "missing-hook-dependency", hook: "useMemo",
        dependencies: ["prefix"],
      }),
      expect.objectContaining({
        component: "Shadowing", kind: "missing-hook-dependency", hook: "useMemo",
        dependencies: ["row"],
      }),
      expect.objectContaining({
        component: "LocalFunction", kind: "missing-hook-dependency", hook: "effect",
        dependencies: ["load"],
      }),
    ]));
  });

  it("accepts covering dependencies and ignores stable state setters and Effect locals", () => {
    const result = analyzeReactSemantics("safe-dependencies.tsx", `
      import { useEffect, useRef, useState } from "react"
      /* uneffect: react component */
      function Dashboard(props: { service: string }) {
        const [count, setCount] = useState(0)
        const latest = useRef(props.service)
        useEffect(() => {
          const message = props.service + count
          setCount(message.length)
          latest.current = message
          return () => console.log(message)
        }, [props, count])
        return null
      }
      /* uneffect: react component */
      function LoopShadow({ index, rows }: { index: number; rows: number[] }) {
        useEffect(() => { for (const index of rows) console.log(index) }, [rows])
        return null
      }
    `);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails closed for opaque and unstable dependency expressions", () => {
    const result = analyzeReactSemantics("opaque-dependencies.tsx", `
      import { useEffect, useMemo } from "react"
      /* uneffect: react component */
      function Dashboard(props: { service: string }, dependencies: unknown[]) {
        const callback = () => console.log(props.service)
        useEffect(callback, [props.service])
        useEffect(() => console.log(props.service), dependencies)
        useMemo(() => props.service, [{ service: props.service }])
        return null
      }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unknown-hook-closure", hook: "useEffect" }),
      expect.objectContaining({ kind: "unknown-hook-dependencies", hook: "useEffect" }),
      expect.objectContaining({ kind: "unstable-hook-dependency", hook: "useMemo" }),
    ]));
  });

  it("marks effects without cleanup as replay-sensitive when they acquire capabilities", () => {
    const result = analyzeReactSemantics("replay.tsx", `
      import { useEffect } from "react"
      /* uneffect: react acquire Subscription */
      declare function subscribe(): void
      /* uneffect: react component */
      function Feed() {
        useEffect(() => { subscribe() }, [])
        return null
      }
    `);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      component: "Feed", kind: "missing-effect-cleanup", phase: "passive-effect",
    }));
  });

  it("discharges an acquired capability only through a matching cleanup release", () => {
    const safe = analyzeReactSemantics("subscription.tsx", `
      import { useEffect } from "react"
      /* uneffect: react acquire Subscription */
      declare function subscribe(): void
      /* uneffect: react release Subscription */
      declare function unsubscribe(): void
      /* uneffect: react component */
      function Feed() {
        useEffect(() => {
          subscribe()
          return () => unsubscribe()
        }, [])
        return null
      }
    `);
    expect(safe.diagnostics).toEqual([]);
    expect(safe.components[0]!.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "passive-effect", effects: ["Acquire<Subscription>"] }),
      expect.objectContaining({ phase: "cleanup", effects: ["Release<Subscription>"] }),
    ]));

    const mismatched = analyzeReactSemantics("subscription.tsx", `
      import { useEffect } from "react"
      /* uneffect: react acquire Subscription */
      declare function subscribe(): void
      /* uneffect: react release Socket */
      declare function closeSocket(): void
      /* uneffect: react component */
      function Feed() {
        useEffect(() => {
          subscribe()
          return () => closeSocket()
        }, [])
        return null
      }
    `);
    expect(mismatched.diagnostics).toContainEqual(expect.objectContaining({
      component: "Feed", kind: "missing-effect-cleanup", effect: "Subscription",
    }));
  });

  it("matches Effect cleanup by acquired resource identity", () => {
    const safe = analyzeReactSemantics("identity.tsx", `
      import { useEffect } from "react"
      interface Subscription { readonly id: string }
      /* uneffect: react acquire Subscription result */
      declare function subscribe(): Subscription
      /* uneffect: react release Subscription parameter 0 */
      declare function unsubscribe(value: Subscription): void
      /* uneffect: react component */
      function Feed() {
        useEffect(() => {
          const acquired = subscribe()
          const alias = acquired
          return () => unsubscribe(alias)
        }, [])
        return null
      }
    `);

    expect(safe.diagnostics).toEqual([]);
    expect(safe.components[0]!.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "passive-effect", effects: ["Acquire<Subscription>"] }),
      expect.objectContaining({ phase: "cleanup", effects: ["Release<Subscription>"] }),
    ]));
  });

  it("rejects releasing a different resource identity and duplicate cleanup", () => {
    const result = analyzeReactSemantics("identity.tsx", `
      import { useEffect } from "react"
      interface Subscription { readonly id: string }
      /* uneffect: react acquire Subscription result */
      declare function subscribe(): Subscription
      /* uneffect: react release Subscription parameter 0 */
      declare function unsubscribe(value: Subscription): void
      declare const other: Subscription
      /* uneffect: react component */
      function WrongIdentity() {
        useEffect(() => {
          const acquired = subscribe()
          return () => unsubscribe(other)
        }, [])
        return null
      }
      /* uneffect: react component */
      function DuplicateCleanup() {
        useEffect(() => {
          const acquired = subscribe()
          return () => { unsubscribe(acquired); unsubscribe(acquired) }
        }, [])
        return null
      }
      /* uneffect: react component */
      function LeavesSecondIdentityOpen() {
        useEffect(() => {
          const first = subscribe()
          const second = subscribe()
          return () => unsubscribe(first)
        }, [])
        return null
      }
      /* uneffect: react component */
      function ReassignedIdentity() {
        useEffect(() => {
          let acquired = subscribe()
          acquired = other
          return () => unsubscribe(acquired)
        }, [])
        return null
      }
      /* uneffect: react component */
      function ConditionalCleanup(props: { enabled: boolean }) {
        useEffect(() => {
          const acquired = subscribe()
          return () => { if (props.enabled) unsubscribe(acquired) }
        }, [props.enabled])
        return null
      }
      /* uneffect: react component */
      function ConditionalAcquisition(props: { enabled: boolean }) {
        useEffect(() => {
          if (props.enabled) subscribe()
        }, [props.enabled])
        return null
      }
    `);

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "WrongIdentity", kind: "resource-identity-mismatch", effect: "Subscription" }),
      expect.objectContaining({ component: "DuplicateCleanup", kind: "duplicate-effect-cleanup", effect: "Subscription" }),
      expect.objectContaining({ component: "LeavesSecondIdentityOpen", kind: "missing-effect-cleanup", effect: "Subscription" }),
      expect.objectContaining({ component: "ReassignedIdentity", kind: "resource-identity-mismatch", effect: "Subscription" }),
      expect.objectContaining({ component: "ConditionalCleanup", kind: "conditional-resource-lifecycle", effect: "Subscription" }),
      expect.objectContaining({ component: "ConditionalAcquisition", kind: "conditional-resource-lifecycle", effect: "Subscription" }),
    ]));
  });

  it("rejects malformed resource identity lifecycle annotations", () => {
    const result = analyzeReactSemantics("invalid-identity.tsx", `
      /* uneffect: react acquire Socket parameter 0 */
      declare function open(): object
      /* uneffect: react release Socket result */
      declare function close(value: object): void
      /* uneffect: react release Socket parameter 1 */
      declare function closeMissingParameter(value: object): void
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalid-react-annotation" }),
    ]));
    expect(result.diagnostics).toHaveLength(3);
  });

  it("exposes production and Strict Mode development replay models", () => {
    const result = analyzeReactSemantics("strict-mode.tsx", `
      import { useEffect, useLayoutEffect } from "react"
      /* uneffect: effect Console */
      declare function observe(): void
      /* uneffect: react component */
      function Panel() {
        useLayoutEffect(() => { observe(); return () => observe() }, [])
        useEffect(() => { observe(); return () => observe() }, [])
        return null
      }
    `);

    expect(result.components[0]!.replay).toEqual({
      production: {
        renderInvocations: 1,
        renderAttempts: [{ instance: "render@0", outcome: "committed", commit: "commit@0" }],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
      strictModeDevelopment: {
        renderInvocations: 2,
        renderAttempts: [
          { instance: "render@0", outcome: "discarded", reason: "strict-mode-replay" },
          { instance: "render@1", outcome: "committed", commit: "commit@0" },
        ],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup", "cleanup", "setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }, { transition: "cleanup", commit: "commit@0" }, { transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup", "cleanup", "setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }, { transition: "cleanup", commit: "commit@0" }, { transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
      concurrentInterruption: {
        renderInvocations: 2,
        renderAttempts: [
          { instance: "render@0", outcome: "discarded", reason: "concurrent-interruption" },
          { instance: "render@1", outcome: "committed", commit: "commit@0" },
        ],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
      dependencyChange: {
        renderInvocations: 2,
        renderAttempts: [
          { instance: "render@0", outcome: "committed", commit: "commit@0" },
          { instance: "render@1", outcome: "committed", commit: "commit@1" },
        ],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup", "cleanup", "setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }, { transition: "cleanup", commit: "commit@0" }, { transition: "setup", commit: "commit@1" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup", "cleanup", "setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }, { transition: "cleanup", commit: "commit@0" }, { transition: "setup", commit: "commit@1" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
      suspenseRetry: {
        renderInvocations: 2,
        renderAttempts: [
          { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
          { instance: "render@1", outcome: "committed", commit: "commit@0", retryOf: "suspension@0" },
        ],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
      repeatedSuspenseRetry: {
        renderInvocations: 3,
        renderAttempts: [
          { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
          { instance: "render@1", outcome: "suspended", suspension: "suspension@1", retryOf: "suspension@0" },
          { instance: "render@2", outcome: "committed", commit: "commit@0", retryOf: "suspension@1" },
        ],
        effects: [
          { instance: expect.stringMatching(/^layout-effect@/), phase: "layout-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
          { instance: expect.stringMatching(/^passive-effect@/), phase: "passive-effect", transitions: ["setup"], lifecycle: [{ transition: "setup", commit: "commit@0" }], setupEffects: ["Console"], cleanupEffects: ["Console"] },
        ],
      },
    });
  });

  it("keeps cleanup effects associated with their individual commit instances", () => {
    const result = analyzeReactSemantics("precise-replay.tsx", `
      import { useEffect, useLayoutEffect } from "react"
      declare namespace JSX { interface IntrinsicElements { main: { ref?: unknown } } }
      /* uneffect: react acquire Layout result */
      declare function mountLayout(): object
      /* uneffect: react release Layout parameter 0 */
      declare function unmountLayout(value: object): void
      /* uneffect: react acquire Subscription result */
      declare function subscribe(): object
      /* uneffect: react release Subscription parameter 0 */
      declare function unsubscribe(value: object): void
      /* uneffect: react acquire Host result */
      declare function attach(node: Element | null): object
      /* uneffect: react release Host parameter 0 */
      declare function detach(value: object): void
      /* uneffect: react component */
      function App() {
        useLayoutEffect(() => { const value = mountLayout(); return () => unmountLayout(value) }, [])
        useEffect(() => { const value = subscribe(); return () => unsubscribe(value) }, [])
        return <main ref={(node) => { const value = attach(node); return () => detach(value) }} />
      }
    `);

    expect(result.components[0]!.replay.production.effects).toEqual([
      expect.objectContaining({ phase: "layout-effect", setupEffects: ["Acquire<Layout>"], cleanupEffects: ["Release<Layout>"] }),
      expect.objectContaining({ phase: "passive-effect", setupEffects: ["Acquire<Subscription>"], cleanupEffects: ["Release<Subscription>"] }),
      expect.objectContaining({ phase: "ref-callback", setupEffects: ["Acquire<Host>"], cleanupEffects: ["Release<Host>"] }),
    ]);
    expect(result.components[0]!.replay.production.effects.map((effect) => effect.instance)).toEqual([
      expect.stringMatching(/^layout-effect@/),
      expect.stringMatching(/^passive-effect@/),
      expect.stringMatching(/^ref-callback@/),
    ]);
  });

  it("generates an instance-preserving Strict Mode Quint lifecycle model", () => {
    const result = analyzeReactSemantics("model.tsx", `
      import { useEffect } from "react"
      declare namespace JSX { interface IntrinsicElements { div: { ref?: unknown } } }
      /* uneffect: react component */
      function App() {
        useEffect(() => { console.log("setup"); return () => console.log("cleanup") }, [])
        return <div ref={() => { console.log("attach"); return () => console.log("detach") }} />
      }
    `);
    const quint = generateReactLifecycleQuint("react_lifecycle", result.components[0]!);
    expect(quint).toContain("module react_lifecycle");
    expect(quint).toContain("action cleanup_0_strict_replay");
    expect(quint).toContain("action setup_1_strict_replay");
    expect(quint).toContain("cleanup_0 <= setup_0");
    expect(quint).toContain("val reactLifecycleSafe");
    for (const effect of result.components[0]!.replay.strictModeDevelopment.effects) {
      expect(quint).toContain(`instance: ${effect.instance}`);
    }
  });

  it("models concurrent render interruption without committing discarded work", () => {
    const result = analyzeReactSemantics("interrupted.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function SearchResults() {
        useEffect(() => { console.log("commit"); return () => console.log("cleanup") }, [])
        return null
      }
    `);
    const replay = result.components[0]!.replay.concurrentInterruption;
    expect(replay.renderAttempts).toEqual([
      { instance: "render@0", outcome: "discarded", reason: "concurrent-interruption" },
      { instance: "render@1", outcome: "committed", commit: "commit@0" },
    ]);
    const quint = generateReactLifecycleQuint("interrupted_render", result.components[0]!, "concurrentInterruption");
    expect(quint).toContain("action discard_render_0");
    expect(quint).toContain("action commit_render_1");
    expect(quint).toContain("setup_0 >= 1 implies commit_generation_0 == 1");
    expect(quint).toContain("val reactLifecycleSafe");
  });

  it("associates dependency cleanup and setup with their owning commit generations", () => {
    const result = analyzeReactSemantics("dependency-change.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Room({ roomId }: { roomId: string }) {
        useEffect(() => { console.log("connect", roomId); return () => console.log("disconnect", roomId) }, [roomId])
        return null
      }
    `);
    const replay = result.components[0]!.replay.dependencyChange;
    expect(replay.effects[0]!.lifecycle).toEqual([
      { transition: "setup", commit: "commit@0" },
      { transition: "cleanup", commit: "commit@0" },
      { transition: "setup", commit: "commit@1" },
    ]);
    const quint = generateReactLifecycleQuint("dependency_change", result.components[0]!, "dependencyChange");
    expect(quint).toContain("var commit_generation_0: int");
    expect(quint).toContain("var commit_generation_1: int");
    expect(quint).toContain("setup_0 >= 2 implies commit_generation_1 == 1");
  });

  it("rejects inconsistent externally supplied lifecycle replay IR", () => {
    const result = analyzeReactSemantics("invalid-replay.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function App() { useEffect(() => {}, []); return null }
    `);
    const missingCommit = structuredClone(result.components[0]!);
    delete missingCommit.replay.production.renderAttempts[0]!.commit;
    expect(() => generateReactLifecycleQuint("missing_commit", missingCommit, "production"))
      .toThrow("committed render render@0 has no commit generation");

    const mismatchedLifecycle = structuredClone(result.components[0]!);
    mismatchedLifecycle.replay.production.effects[0]!.transitions = ["cleanup"];
    expect(() => generateReactLifecycleQuint("mismatched_lifecycle", mismatchedLifecycle, "production"))
      .toThrow("transitions do not match lifecycle steps");

    expect(() => generateReactSuspenseBoundaryQuint("invalid_boundary", missingCommit, result.components[0]!))
      .toThrow("primary committed render render@0 has no commit generation");
  });

  it("models Suspense resolution as a prerequisite for retry commit", () => {
    const result = analyzeReactSemantics("suspense.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("visible") }, []); return null }
    `);
    const replay = result.components[0]!.replay.suspenseRetry;
    expect(replay.renderAttempts).toEqual([
      { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
      { instance: "render@1", outcome: "committed", commit: "commit@0", retryOf: "suspension@0" },
    ]);
    const quint = generateReactLifecycleQuint("suspense_retry", result.components[0]!, "suspenseRetry");
    expect(quint).toContain("action suspend_render_0");
    expect(quint).toContain("action resolve_suspension_0");
    expect(quint).toContain("resolved_suspension_0 == 1");
    expect(quint).toContain("commit_generation_0 == 1 implies resolved_suspension_0 == 1");
  });

  it("models a retry that suspends again before the final commit", () => {
    const result = analyzeReactSemantics("repeated-suspense.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("visible") }, []); return null }
    `);
    const replay = result.components[0]!.replay.repeatedSuspenseRetry;
    expect(replay.renderAttempts).toEqual([
      { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
      { instance: "render@1", outcome: "suspended", suspension: "suspension@1", retryOf: "suspension@0" },
      { instance: "render@2", outcome: "committed", commit: "commit@0", retryOf: "suspension@1" },
    ]);
    const quint = generateReactLifecycleQuint("repeated_suspense", result.components[0]!, "repeatedSuspenseRetry");
    expect(quint).toContain("action resolve_suspension_1");
    expect(quint).toContain("suspension_1 == 1 implies resolved_suspension_0 == 1");
    expect(quint).toContain("commit_generation_0 == 1 implies resolved_suspension_1 == 1");
  });

  it("composes fallback commit and cleanup with primary reveal", () => {
    const primary = analyzeReactSemantics("profile.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("profile"); return () => console.log("hide profile") }, []); return null }
    `).components[0]!;
    const fallback = analyzeReactSemantics("spinner.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Spinner() { useEffect(() => { console.log("spinner"); return () => console.log("hide spinner") }, []); return null }
    `).components[0]!;

    const quint = generateReactSuspenseBoundaryQuint("profile_boundary", primary, fallback);
    expect(quint).toContain("action suspend_primary");
    expect(quint).toContain("action commit_fallback");
    expect(quint).toContain("action resolve_primary_suspension");
    expect(quint).toContain("action reveal_primary");
    expect(quint).toContain("fallback_cleanup_0 == 1 implies primary_committed == 1");
    expect(quint).toContain("primary_setup_0 == 1 implies fallback_cleanup_0 == 1");
    expect(quint).toContain("val suspenseBoundarySafe");
  });

  it("extracts a direct Suspense primary/fallback edge through a named import alias", () => {
    const result = analyzeReactSemantics("boundary.tsx", `
      import { Suspense as AsyncBoundary, useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("profile"); return () => console.log("hide") }, []); return null }
      /* uneffect: react component */
      function Spinner() { useEffect(() => { console.log("spinner"); return () => console.log("hide") }, []); return null }
      function App() { return <AsyncBoundary fallback={<Spinner />}><Profile /></AsyncBoundary> }
    `);
    expect(result.suspenseBoundaries).toEqual([
      expect.objectContaining({ instance: expect.stringMatching(/^suspense@\d+$/), primary: "Profile", fallback: "Spinner" }),
    ]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);
    const quint = generateReactSuspenseBoundaryQuintFromAnalysis("extracted_boundary", result);
    expect(quint).toContain("component: Profile");
    expect(quint).toContain("component: Spinner");
  });

  it("reports unsupported Suspense child shapes without claiming a boundary", () => {
    const result = analyzeReactSemantics("unsupported-boundary.tsx", `
      import { Suspense } from "react"
      /* uneffect: react component */ function First() { return null }
      /* uneffect: react component */ function Second() { return null }
      /* uneffect: react component */ function Spinner() { return null }
      function App() { return <Suspense fallback={<Spinner />}><First /><Second /></Suspense> }
    `);
    expect(result.suspenseBoundaries).toEqual([]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([
      expect.objectContaining({ reason: "primary-must-be-one-direct-component" }),
    ]);
    expect(() => generateReactSuspenseBoundaryQuintFromAnalysis("missing_boundary", result))
      .toThrow("Suspense boundary 0 is not available");
  });

  it("rejects direct network and DOM writes in render but not inside an event callback", () => {
    const result = analyzeReactSemantics("render-effects.tsx", `
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
      /* uneffect: react component */
      function Page() {
        document.title = "rendering"
        fetch("/render")
        return <button onClick={() => { document.title = "clicked"; fetch("/event") }} />
      }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "render-effect", phase: "render", effect: "DomWrite" }),
      expect.objectContaining({ kind: "render-effect", phase: "render", effect: "Fetch" }),
    ]));
    expect(result.diagnostics).toHaveLength(2);
    expect(result.components[0]!.phases).toContainEqual(expect.objectContaining({
      phase: "event", effects: expect.arrayContaining(["DomWrite", "Fetch"]),
    }));
  });

  it("reports React obligations through the shared check command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-check-"));
    const fileName = join(directory, "page.tsx");
    try {
      writeFileSync(fileName, `
        /* uneffect: react component */
        export function Page() { console.log("render"); return null }
      `);
      const result = await checkFiles([fileName]);
      const diagnostic = result.diagnostics.find((item) => "component" in item);
      expect(diagnostic).toEqual(expect.objectContaining({ kind: "render-effect", functionName: "Page" }));
      expect(reportDiagnostic(diagnostic!)).toEqual(expect.objectContaining({
        code: "react/render-effect", severity: "error", functionName: "Page",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("dogfoods a telemetry dashboard with state, memo, event, and subscription phases", () => {
    const fileName = "examples/dogfood/react-telemetry-dashboard.tsx";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeReactSemantics(fileName, source);
    expect(result.diagnostics).toEqual([]);
    expect(result.components).toContainEqual(expect.objectContaining({
      name: "TelemetryDashboard",
      phases: expect.arrayContaining([
        expect.objectContaining({ phase: "event", effects: ["Fetch"] }),
        expect.objectContaining({ phase: "passive-effect", effects: ["Acquire<TelemetrySubscription>"] }),
        expect.objectContaining({ phase: "ref-callback", effects: ["Acquire<TelemetryViewport>"] }),
        expect.objectContaining({ phase: "cleanup", effects: expect.arrayContaining(["Release<TelemetrySubscription>", "Release<TelemetryViewport>"]) }),
      ]),
    }));
    const replay = result.components.find(({ name }) => name === "TelemetryDashboard")!.replay.production.effects;
    expect(replay.find(({ phase }) => phase === "passive-effect")).toEqual(expect.objectContaining({
      cleanupEffects: ["Release<TelemetrySubscription>"],
    }));
    expect(replay.find(({ phase }) => phase === "ref-callback")).toEqual(expect.objectContaining({
      cleanupEffects: ["Release<TelemetryViewport>"],
    }));
    const interrupted = generateReactLifecycleQuint(
      "telemetry_interrupted",
      result.components.find(({ name }) => name === "TelemetryDashboard")!,
      "concurrentInterruption",
    );
    expect(interrupted).toContain("action discard_render_0");
    expect(interrupted).toContain("setup_0 >= 1 implies commit_generation_0 == 1");
    const suspense = generateReactLifecycleQuint(
      "telemetry_suspense",
      result.components.find(({ name }) => name === "TelemetryDashboard")!,
      "suspenseRetry",
    );
    expect(suspense).toContain("action suspend_render_0");
    expect(suspense).toContain("action resolve_suspension_0");
    expect(suspense).toContain("commit_generation_0 == 1 implies resolved_suspension_0 == 1");

    const leaking = analyzeReactSemantics(fileName, source.replace(
      "return () => unsubscribeFromTelemetry(subscription);",
      "return undefined;",
    ));
    expect(leaking.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "useTelemetrySubscription", kind: "missing-effect-cleanup", effect: "TelemetrySubscription",
    }));

    const wrongIdentity = analyzeReactSemantics(fileName, source.replace(
      "return () => unsubscribeFromTelemetry(subscription);",
      "return () => unsubscribeFromTelemetry({ service });",
    ));
    expect(wrongIdentity.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "useTelemetrySubscription", kind: "resource-identity-mismatch", effect: "TelemetrySubscription",
    }));

    const staleClosure = analyzeReactSemantics(fileName, source.replace(
      "}, [service]);",
      "}, []);",
    ));
    expect(staleClosure.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "useTelemetrySubscription", kind: "missing-hook-dependency", dependencies: ["service"],
    }));

    const mutating = analyzeReactSemantics(fileName, source.replace(
      "const [showFailures, setShowFailures] = useState(false);",
      "props.service = \"all\";\n  const [showFailures, setShowFailures] = useState(false);",
    ));
    expect(mutating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "TelemetryDashboard", kind: "immutable-input-mutation",
    }));

    const leakingRef = analyzeReactSemantics(fileName, source.replace(
      "return () => detachTelemetryViewport(viewport);",
      "return undefined;",
    ));
    expect(leakingRef.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "TelemetryDashboard", kind: "missing-effect-cleanup", phase: "ref-callback", effect: "TelemetryViewport",
    }));
  });

  it("dogfoods a separate primary and fallback component boundary", () => {
    const fileName = "examples/dogfood/react-suspense-boundary.tsx";
    const result = analyzeReactSemantics(fileName, readFileSync(fileName, "utf8"));
    expect(result.diagnostics).toEqual([]);
    const primary = result.components.find(({ name }) => name === "Profile")!;
    const fallback = result.components.find(({ name }) => name === "ProfileSpinner")!;
    expect(primary).toBeDefined();
    expect(fallback).toBeDefined();
    expect(result.suspenseBoundaries).toEqual([
      expect.objectContaining({ primary: "Profile", fallback: "ProfileSpinner" }),
    ]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);
    const quint = generateReactSuspenseBoundaryQuintFromAnalysis("profile_dogfood", result);
    expect(quint).toContain("component: Profile");
    expect(quint).toContain("component: ProfileSpinner");
    expect(quint).toContain("primary_setup_0 == 1 implies fallback_cleanup_0 == 1");
  });

  it("dogfoods checked-in symbol-resolved React modules", async () => {
    const hooksFile = "examples/dogfood/react-symbol-hooks.tsx";
    const barrelFile = "examples/dogfood/react-symbol-barrel.ts";
    const appFile = "examples/dogfood/react-symbol-dashboard.tsx";
    const program = ts.createProgram([hooksFile, barrelFile, appFile], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
    });
    const result = analyzeReactSemanticsInProgram(program, program.getSourceFile(appFile)!);
    expect(result.diagnostics).toEqual([]);
    expect(result.components[0]!.phases).toEqual(expect.arrayContaining([
      { phase: "layout-effect", effects: ["DomWrite"] },
      { phase: "passive-effect", effects: ["Console"] },
    ]));
    const checked = await checkFiles([hooksFile, barrelFile, appFile]);
    expect(checked.diagnostics.filter((diagnostic) => "component" in diagnostic)).toEqual([]);
  });
});
