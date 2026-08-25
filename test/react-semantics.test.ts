import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { reportDiagnostic } from "../src/diagnostics.js";
import { analyzeReactProgram, analyzeReactSemantics, analyzeReactSemanticsInProgram, generateReactLifecycleQuint, generateReactNestedSuspenseQuintFromAnalysis, generateReactNestedSuspenseQuintFromProgram, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis, generateReactSuspenseBoundaryQuintFromProgram, generateReactSuspenseTreeQuintFromAnalysis, generateReactSuspenseTreeQuintFromProgram } from "../src/react-semantics.js";

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

  it("classifies locally referenced and aliased JSX handlers as event work", () => {
    const result = analyzeReactSemantics("referenced-events.tsx", `
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
      /* uneffect: react component */
      function Panel() {
        function submit() { fetch("/submit") }
        const handleClick = submit
        return <button onClick={handleClick} />
      }
    `);

    expect(result.diagnostics).toEqual([]);
    expect(result.components[0]!.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "render", effects: [] }),
      expect.objectContaining({ phase: "event", effects: ["Fetch"] }),
    ]));
  });

  it("fails closed when a referenced JSX handler is reassigned", () => {
    const result = analyzeReactSemantics("unstable-event.tsx", `
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
      /* uneffect: react component */
      function Panel() {
        function submit() { fetch("/submit") }
        submit = () => console.log("changed")
        return <button onClick={submit} />
      }
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "unknown-event-handler", phase: "event", operation: "submit" }),
    ]);
  });

  it("executes React transition action callbacks in their enclosing phase", () => {
    const result = analyzeReactSemantics("transitions.tsx", `
      import React, { startTransition as defer, useTransition } from "react"
      declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
      declare const externalAction: () => void
      /* uneffect: react component */
      function Panel() {
        const [, schedule] = useTransition()
        const refresh = () => fetch("/refresh")
        const refreshAlias = refresh
        function logSchedule() { console.log("scheduled") }
        const handleClick = () => {
          defer(refreshAlias)
          schedule(logSchedule)
          defer(externalAction)
        }
        return <button onClick={handleClick} />
      }
      /* uneffect: react component */
      function InvalidRender() {
        React.startTransition(() => fetch("/during-render"))
        return null
      }
      /* uneffect: react hook */
      function useInvalidTransition() {
        const log = () => console.log("hook-render")
        const logAlias = log
        defer(logAlias)
      }
      /* uneffect: react component */
      function InvalidHookRender() { useInvalidTransition(); return null }
    `);

    expect(result.components.find(({ name }) => name === "Panel")!.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "event", effects: ["Fetch", "Console"] }),
    ]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ component: "Panel", kind: "unknown-transition-action", phase: "event", operation: "externalAction" }),
      expect.objectContaining({ component: "InvalidRender", kind: "render-effect", effect: "Fetch" }),
      expect.objectContaining({ component: "InvalidHookRender", kind: "render-effect", effect: "Console" }),
    ]);
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

  it("reports dynamic Suspense child expressions without claiming a boundary", () => {
    const result = analyzeReactSemantics("unsupported-boundary.tsx", `
      import { Suspense } from "react"
      /* uneffect: react component */ function First() { return null }
      /* uneffect: react component */ function Second() { return null }
      /* uneffect: react component */ function Spinner() { return null }
      declare const showSecond: boolean
      function App() { return <Suspense fallback={<Spinner />}><First />{showSecond && <Second />}</Suspense> }
    `);
    expect(result.suspenseBoundaries).toEqual([]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([
      expect.objectContaining({ reason: "primary-must-be-one-direct-component" }),
    ]);
    expect(() => generateReactSuspenseBoundaryQuintFromAnalysis("missing_boundary", result))
      .toThrow("Suspense boundary 0 is not available");
  });

  it("extracts a nested direct Suspense chain and keeps a leaf suspension at the nearest boundary", () => {
    const result = analyzeReactSemantics("nested-boundary.tsx", `
      import { Suspense, useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => () => console.log("hide profile"), []); return null }
      /* uneffect: react component */
      function InnerSpinner() { useEffect(() => () => console.log("hide inner"), []); return null }
      /* uneffect: react component */
      function OuterSpinner() { useEffect(() => () => console.log("hide outer"), []); return null }
      function App() {
        return <Suspense fallback={<OuterSpinner />}>
          <Suspense fallback={<InnerSpinner />}><Profile /></Suspense>
        </Suspense>
      }
    `);

    expect(result.suspenseBoundaries).toHaveLength(2);
    const outer = result.suspenseBoundaries.find((boundary) => boundary.parentBoundary === undefined)!;
    const inner = result.suspenseBoundaries.find((boundary) => boundary.parentBoundary === outer.instance)!;
    expect(outer).toEqual(expect.objectContaining({
      fallback: "OuterSpinner", primaryBoundary: inner.instance,
    }));
    expect(inner).toEqual(expect.objectContaining({
      primary: "Profile", fallback: "InnerSpinner", parentBoundary: outer.instance,
    }));
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);

    const quint = generateReactNestedSuspenseQuintFromAnalysis("nested_boundary", result);
    expect(quint).toContain("action suspend_leaf_primary");
    expect(quint).toContain("action commit_fallback_1");
    expect(quint).not.toContain("action commit_fallback_0");
    expect(quint).toContain("fallback_committed_0 == 0");
    expect(quint).toContain("val nestedSuspenseSafe");
  });

  it("flattens Fragment and multiple direct children into a nearest-boundary ownership tree", () => {
    const result = analyzeReactSemantics("suspense-tree.tsx", `
      import React, { Fragment, Suspense } from "react"
      /* uneffect: react component */ function OuterLeaf() { return null }
      /* uneffect: react component */ function InnerLeafA() { return null }
      /* uneffect: react component */ function InnerLeafB() { return null }
      /* uneffect: react component */ function OuterFallback() { return null }
      /* uneffect: react component */ function InnerFallback() { return null }
      function App() {
        return <Suspense fallback={<OuterFallback />}><>
          <OuterLeaf />
          <Suspense fallback={<InnerFallback />}>
            <Fragment><InnerLeafA /><React.Fragment><InnerLeafB /></React.Fragment></Fragment>
          </Suspense>
        </></Suspense>
      }
    `);
    expect(result.suspenseBoundaries).toHaveLength(2);
    const outer = result.suspenseBoundaries.find((boundary) => boundary.parentBoundary === undefined)!;
    const inner = result.suspenseBoundaries.find((boundary) => boundary.parentBoundary === outer.instance)!;
    expect(outer.primaryNodes).toEqual([
      expect.objectContaining({ kind: "component", displayName: "OuterLeaf" }),
      { kind: "boundary", instance: inner.instance },
    ]);
    expect(inner.primaryNodes).toEqual([
      expect.objectContaining({ kind: "component", displayName: "InnerLeafA" }),
      expect.objectContaining({ kind: "component", displayName: "InnerLeafB" }),
    ]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);

    const quint = generateReactSuspenseTreeQuintFromAnalysis("suspense_tree", result);
    expect(quint).toContain("leaf 0: OuterLeaf; owner boundary 0");
    expect(quint).toContain("leaf 1: InnerLeafA; owner boundary 1");
    expect(quint).toContain("leaf 2: InnerLeafB; owner boundary 1");
    expect(quint).toContain("fallback_owner == suspension_owner");
    expect(quint).toContain("val suspenseTreeSafe");
  });

  it("uses Program types to restrict a Suspense tree to leaves with known thenable use calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspense-causality-"));
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(appFile, `
        import { Suspense, use as consume } from "react"
        declare const profilePromise: Promise<{ name: string }>
        declare const maybePromise: Promise<string> | { current: string }
        /* uneffect: react component */ function Profile() { const profile = consume(profilePromise); return <p>{profile.name}</p> }
        /* uneffect: react component */ function MaybeProfile() { consume(maybePromise); return null }
        /* uneffect: react component */ function Navigation() { return <nav>Navigation</nav> }
        /* uneffect: react component */ function Spinner() { return <p>Loading</p> }
        function App() { return <Suspense fallback={<Spinner />}><><Navigation /><MaybeProfile /><Profile /></></Suspense> }
      `);
      const program = ts.createProgram([appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const app = results.get(appFile)!;
      expect(app.diagnostics).toEqual([]);
      expect(app.components.find(({ name }) => name === "Profile")!.suspensions).toEqual([
        expect.objectContaining({ kind: "react-use", certainty: "thenable", expression: "profilePromise" }),
      ]);
      expect(app.components.find(({ name }) => name === "Navigation")!.suspensions).toEqual([]);
      expect(app.components.find(({ name }) => name === "MaybeProfile")!.suspensions).toEqual([
        expect.objectContaining({ kind: "react-use", certainty: "unknown", expression: "maybePromise" }),
      ]);
      const quint = generateReactSuspenseTreeQuintFromProgram("causal_tree", results, appFile, 0, {
        requireKnownSuspension: true,
      });
      expect(quint).toContain("leaf 0: Profile; owner boundary 0; cause react-use(profilePromise)");
      expect(quint).not.toContain("Navigation; owner boundary");
      expect(quint).not.toContain("MaybeProfile; owner boundary");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not promote a source-only React use call to known thenable evidence", () => {
    const result = analyzeReactSemantics("unknown-use.tsx", `
      import { Suspense, use } from "react"
      declare const input: unknown
      /* uneffect: react component */ function Primary() { use(input); return null }
      /* uneffect: react component */ function Fallback() { return null }
      function App() { return <Suspense fallback={<Fallback />}><Primary /></Suspense> }
    `);
    expect(result.components.find(({ name }) => name === "Primary")!.suspensions).toEqual([
      expect.objectContaining({ certainty: "unknown", expression: "input" }),
    ]);
    expect(() => generateReactSuspenseTreeQuintFromAnalysis("unknown_cause", result, 0, {
      requireKnownSuspension: true,
    })).toThrow("has no leaf with a known thenable suspension cause");
  });

  it("recognizes React use through default and namespace objects but not unrelated properties", () => {
    const defaultResult = analyzeReactSemantics("default-use.tsx", `
      import React from "react"
      declare const promise: Promise<string>
      /* uneffect: react component */ function DefaultUse() { React.use(promise); return null }
    `);
    const namespaceResult = analyzeReactSemantics("namespace-use.tsx", `
      import * as R from "react"
      declare const promise: Promise<string>
      /* uneffect: react component */ function NamespaceUse() { R.use(promise); return null }
    `);
    const unrelated = analyzeReactSemantics("unrelated-use.tsx", `
      declare const UI: { use(value: unknown): unknown }
      /* uneffect: react component */ function Unrelated() { UI.use(1); return null }
    `);
    expect(defaultResult.components[0]!.suspensions).toHaveLength(1);
    expect(namespaceResult.components[0]!.suspensions).toHaveLength(1);
    expect(unrelated.components[0]!.suspensions).toEqual([]);
  });

  it("composes a known React use suspension through a cross-file custom Hook", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspending-hook-"));
    const hookFile = join(directory, "hook.ts");
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(hookFile, `
        import { use } from "react"
        /* uneffect: react hook */
        export function useProfile<T>(promise: Promise<T>): T { return use(promise) }
      `);
      writeFileSync(appFile, `
        import { Suspense } from "react"
        import { useProfile } from "./hook.js"
        declare const profilePromise: Promise<{ name: string }>
        /* uneffect: react component */ function Profile() { const profile = useProfile(profilePromise); return <p>{profile.name}</p> }
        /* uneffect: react component */ function Spinner() { return null }
        function App() { return <Suspense fallback={<Spinner />}><Profile /></Suspense> }
      `);
      const program = ts.createProgram([hookFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const profile = results.get(appFile)!.components.find(({ name }) => name === "Profile")!;
      expect(profile.suspensions).toEqual([
        expect.objectContaining({ kind: "react-use", certainty: "thenable", expression: "promise", fileName: hookFile }),
      ]);
      expect(generateReactSuspenseTreeQuintFromProgram("hook_causal_tree", results, appFile, 0, {
        requireKnownSuspension: true,
      })).toContain("cause react-use(promise)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a thrown thenable from an ordinary thrown Error in render", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-thrown-thenable-"));
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(appFile, `
        import { Suspense } from "react"
        declare const pending: Promise<string>
        /* uneffect: react component */ function Pending() { throw pending }
        /* uneffect: react component */ function Broken() { throw new Error("broken") }
        /* uneffect: react component */ function Spinner() { return null }
        function App() { return <Suspense fallback={<Spinner />}><><Broken /><Pending /></></Suspense> }
      `);
      const program = ts.createProgram([appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const app = results.get(appFile)!;
      expect(app.components.find(({ name }) => name === "Pending")!.suspensions).toEqual([
        expect.objectContaining({ kind: "throw-thenable", certainty: "thenable", expression: "pending" }),
      ]);
      expect(app.components.find(({ name }) => name === "Broken")!.suspensions).toEqual([
        expect.objectContaining({ kind: "throw-thenable", certainty: "non-thenable", expression: 'new Error("broken")' }),
      ]);
      const quint = generateReactSuspenseTreeQuintFromProgram("thrown_causal_tree", results, appFile, 0, {
        requireKnownSuspension: true,
      });
      expect(quint).toContain("leaf 0: Pending; owner boundary 0; cause throw-thenable(pending)");
      expect(quint).not.toContain("Broken; owner boundary");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a source-only thrown value uncertain", () => {
    const result = analyzeReactSemantics("unknown-throw.tsx", `
      declare const pending: unknown
      /* uneffect: react component */ function Pending() { throw pending }
    `);
    expect(result.components[0]!.suspensions).toEqual([
      expect.objectContaining({ kind: "throw-thenable", certainty: "unknown", expression: "pending" }),
    ]);
  });

  it("composes a thrown thenable through a cross-file custom Hook", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-hook-throw-"));
    const hookFile = join(directory, "hook.ts");
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(hookFile, `
        declare const pending: Promise<string>
        /* uneffect: react hook */ export function useLegacyResource() { throw pending }
      `);
      writeFileSync(appFile, `
        import { Suspense } from "react"
        import { useLegacyResource } from "./hook.js"
        /* uneffect: react component */ function Profile() { useLegacyResource(); return null }
        /* uneffect: react component */ function Spinner() { return null }
        function App() { return <Suspense fallback={<Spinner />}><Profile /></Suspense> }
      `);
      const program = ts.createProgram([appFile, hookFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      expect(results.get(appFile)!.components.find(({ name }) => name === "Profile")!.suspensions).toEqual([
        expect.objectContaining({ kind: "throw-thenable", certainty: "thenable", expression: "pending" }),
      ]);
      expect(generateReactSuspenseTreeQuintFromProgram("hook_throw_tree", results, appFile, 0, {
        requireKnownSuspension: true,
      })).toContain("cause throw-thenable(pending)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not recognize an unrelated namespace property named Suspense", () => {
    const result = analyzeReactSemantics("unrelated-suspense.tsx", `
      declare const UI: { Suspense: unknown }
      /* uneffect: react component */ function Primary() { return null }
      /* uneffect: react component */ function Fallback() { return null }
      function App() { return <UI.Suspense fallback={<Fallback />}><Primary /></UI.Suspense> }
    `);
    expect(result.suspenseBoundaries).toEqual([]);
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);
  });

  it("resolves cross-file Suspense components through barrel and default import aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspense-symbols-"));
    const componentsFile = join(directory, "components.tsx");
    const barrelFile = join(directory, "index.ts");
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(componentsFile, `
        import { useEffect } from "react"
        /* uneffect: react component */
        export default function Profile() { useEffect(() => () => console.log("hide"), []); return null }
        /* uneffect: react component */
        export function Spinner() { useEffect(() => () => console.log("hide"), []); return null }
      `);
      writeFileSync(barrelFile, `export { default as LoadedProfile, Spinner as Busy } from "./components.js"`);
      writeFileSync(appFile, `
        import { Suspense } from "react"
        import { LoadedProfile as Primary, Busy as Fallback } from "./index.js"
        export function App() { return <Suspense fallback={<Fallback />}><Primary /></Suspense> }
      `);
      const program = ts.createProgram([componentsFile, barrelFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const app = results.get(appFile)!;
      expect(app.suspenseBoundaries).toEqual([
        expect.objectContaining({ primary: "Primary", fallback: "Fallback", primaryKey: `${componentsFile}:Profile`, fallbackKey: `${componentsFile}:Spinner` }),
      ]);
      expect(app.unsupportedSuspenseBoundaries).toEqual([]);
      const quint = generateReactSuspenseBoundaryQuintFromProgram("cross_file_boundary", results, appFile);
      expect(quint).toContain("component: Profile");
      expect(quint).toContain("component: Spinner");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves React and component namespace JSX tags", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspense-namespace-"));
    const componentsFile = join(directory, "views.tsx");
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(componentsFile, `
        /* uneffect: react component */ export function Profile() { return null }
        /* uneffect: react component */ export function Spinner() { return null }
      `);
      writeFileSync(appFile, `
        import * as React from "react"
        import * as views from "./views.js"
        export function App() { return <React.Suspense fallback={<views.Spinner />}><views.Profile /></React.Suspense> }
      `);
      const program = ts.createProgram([componentsFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const app = results.get(appFile)!;
      expect(app.suspenseBoundaries).toEqual([
        expect.objectContaining({
          primary: "views.Profile", fallback: "views.Spinner",
          primaryKey: `${componentsFile}:Profile`, fallbackKey: `${componentsFile}:Spinner`,
        }),
      ]);
      expect(app.unsupportedSuspenseBoundaries).toEqual([]);
      expect(generateReactSuspenseBoundaryQuintFromProgram("namespace_boundary", results, appFile))
        .toContain("val suspenseBoundarySafe");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves a nested Suspense chain whose leaf and fallbacks are imported", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-nested-suspense-"));
    const componentsFile = join(directory, "views.tsx");
    const appFile = join(directory, "app.tsx");
    try {
      writeFileSync(componentsFile, `
        /* uneffect: react component */ export function Profile() { return null }
        /* uneffect: react component */ export function Navigation() { return null }
        /* uneffect: react component */ export function InnerSpinner() { return null }
        /* uneffect: react component */ export function OuterSpinner() { return null }
      `);
      writeFileSync(appFile, `
        import { Suspense } from "react"
        import * as views from "./views.js"
        export function App() {
          return <Suspense fallback={<views.OuterSpinner />}>
            <><views.Navigation /><Suspense fallback={<views.InnerSpinner />}><views.Profile /></Suspense></>
          </Suspense>
        }
      `);
      const program = ts.createProgram([componentsFile, appFile], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
      });
      const results = analyzeReactProgram(program);
      const app = results.get(appFile)!;
      expect(app.suspenseBoundaries).toHaveLength(2);
      const outer = app.suspenseBoundaries.find((boundary) => boundary.parentBoundary === undefined)!;
      const inner = app.suspenseBoundaries.find((boundary) => boundary.parentBoundary === outer.instance)!;
      expect(outer.fallbackKey).toBe(`${componentsFile}:OuterSpinner`);
      expect(outer.primaryNodes).toEqual([
        { kind: "component", displayName: "views.Navigation", componentKey: `${componentsFile}:Navigation` },
        { kind: "boundary", instance: inner.instance },
      ]);
      expect(inner).toEqual(expect.objectContaining({
        primaryKey: `${componentsFile}:Profile`, fallbackKey: `${componentsFile}:InnerSpinner`,
      }));
      expect(app.unsupportedSuspenseBoundaries).toEqual([]);
      const quint = generateReactSuspenseTreeQuintFromProgram("imported_suspense_tree", results, appFile);
      expect(quint).toContain("leaf 0: views.Navigation; owner boundary 0");
      expect(quint).toContain("leaf 1: views.Profile; owner boundary 1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("dogfoods nearest-boundary ownership in a checked-in Suspense tree", () => {
    const fileName = "examples/dogfood/react-nested-suspense.tsx";
    const result = analyzeReactSemantics(fileName, readFileSync(fileName, "utf8"));
    expect(result.diagnostics).toEqual([]);
    expect(result.suspenseBoundaries).toHaveLength(2);
    expect(result.unsupportedSuspenseBoundaries).toEqual([]);
    const quint = generateReactSuspenseTreeQuintFromAnalysis("account_suspense_tree", result);
    expect(quint).toContain("leaf 0: AccountNavigation; owner boundary 0");
    expect(quint).toContain("leaf 1: AccountPanel; owner boundary 1");
    expect(quint).toContain("fallback_owner == suspension_owner");
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
    });
    const results = analyzeReactProgram(program);
    expect(results.get(fileName)!.components.find(({ name }) => name === "AccountPanel")!.suspensions)
      .toContainEqual(expect.objectContaining({ certainty: "thenable", expression: "accountPromise" }));
    const causal = generateReactSuspenseTreeQuintFromProgram("account_causal_tree", results, fileName, 0, {
      requireKnownSuspension: true,
    });
    expect(causal).toContain("leaf 0: AccountPanel; owner boundary 1; cause react-use(accountPromise)");
    expect(causal).not.toContain("AccountNavigation; owner boundary");
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

  it("dogfoods a checked-in cross-file Suspense boundary", async () => {
    const componentsFile = "examples/dogfood/react-suspense-symbol-components.tsx";
    const barrelFile = "examples/dogfood/react-suspense-symbol-barrel.ts";
    const appFile = "examples/dogfood/react-suspense-symbol-app.tsx";
    const program = ts.createProgram([componentsFile, barrelFile, appFile], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
    });
    const results = analyzeReactProgram(program);
    const app = results.get(appFile)!;
    expect(app.suspenseBoundaries).toEqual([
      expect.objectContaining({
        primary: "views.ProfileFromBarrel", fallback: "views.SpinnerFromBarrel",
        primaryKey: `${componentsFile}:RemoteProfile`,
        fallbackKey: `${componentsFile}:RemoteSpinner`,
      }),
    ]);
    expect(app.unsupportedSuspenseBoundaries).toEqual([]);
    const quint = generateReactSuspenseBoundaryQuintFromProgram("remote_profile_boundary", results, appFile);
    expect(quint).toContain("component: RemoteProfile");
    expect(quint).toContain("component: RemoteSpinner");
    const checked = await checkFiles([componentsFile, barrelFile, appFile]);
    expect(checked.diagnostics.filter((diagnostic) => "component" in diagnostic)).toEqual([]);
  });
});
