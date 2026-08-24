import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { reportDiagnostic } from "../src/diagnostics.js";
import { analyzeReactSemantics } from "../src/react-semantics.js";

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
});
