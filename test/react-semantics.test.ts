import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { reportDiagnostic } from "../src/diagnostics.js";
import { analyzeReactSemantics, analyzeReactSemanticsInProgram } from "../src/react-semantics.js";

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
        effects: [
          { phase: "layout-effect", transitions: ["setup"], setupEffects: ["Console"], possibleCleanupEffects: ["Console"] },
          { phase: "passive-effect", transitions: ["setup"], setupEffects: ["Console"], possibleCleanupEffects: ["Console"] },
        ],
      },
      strictModeDevelopment: {
        renderInvocations: 2,
        effects: [
          { phase: "layout-effect", transitions: ["setup", "cleanup", "setup"], setupEffects: ["Console"], possibleCleanupEffects: ["Console"] },
          { phase: "passive-effect", transitions: ["setup", "cleanup", "setup"], setupEffects: ["Console"], possibleCleanupEffects: ["Console"] },
        ],
      },
    });
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
        expect.objectContaining({ phase: "cleanup", effects: ["Release<TelemetrySubscription>"] }),
      ]),
    }));

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
