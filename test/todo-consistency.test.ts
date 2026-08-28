import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findStaleUncheckedParents, parseTodoTasks } from "../src/todo-consistency.js";

describe("TODO hierarchy consistency", () => {
  it("finds only unchecked parents whose complete descendants are stale", () => {
    const tasks = parseTodoTasks(`
- [ ] active
  - [x] done
  - [ ] open
- [ ] stale
  - [x] first
  - [x] second
    `);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.children.map((task) => task.text)).toEqual(["done", "open"]);
    expect(findStaleUncheckedParents(`
- [ ] active
  - [x] done
  - [ ] open
- [ ] stale
  - [x] first
  - [x] second
`).map((task) => task.text)).toEqual(["stale"]);
  });

  it("keeps the repository roadmap parent statuses synchronized", () => {
    const stale = findStaleUncheckedParents(readFileSync("TODO.md", "utf8"));
    expect(stale.map((task) => `${task.line}:${task.text}`)).toEqual([]);
  });

  it("keeps historical ledger headings distinct from live issue priorities", () => {
    const todo = readFileSync("TODO.md", "utf8");
    expect(todo).not.toMatch(/^## P\d/m);
    expect(todo).toContain("## Historical ledger section 0 — Specification foundations");
  });

  it("assigns every unfinished ledger entry to exactly one owning issue", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const unfinished = todo.split("\n").filter((line) => /^\s*- \[ \]/.test(line));

    expect(unfinished.length).toBeGreaterThan(0);
    for (const line of unfinished) {
      const owners = [...line.matchAll(/\[#(\d+)\]\(https:\/\/github\.com\/mizchi\/uneffect\/issues\/\1\)/g)];
      expect(owners, line).toHaveLength(1);
    }
  });

  it("keeps completed async-resource work out of the unfinished ledger", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const unfinished = todo.split("\n").filter((line) => /^\s*- \[ \]/.test(line));
    const issue9 = unfinished.filter((line) => line.includes("issues/9"));

    expect(issue9).toEqual([]);
    expect(todo).toMatch(/General\s+CFG values and escaping-alias fixed points remain outside #9 and are\s+owned by #25 and #24\./);
  });

  it("tracks deferred optimizer implementation in the issue roadmap", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const roadmap = readFileSync("docs/roadmap.md", "utf8");
    expect(todo).toContain("[#13](https://github.com/mizchi/uneffect/issues/13)");
    expect(roadmap).toContain("issues/13");
  });

  it("keeps every open issue visible in the active index and boundary docs", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const matrix = readFileSync("docs/feature-matrix.md", "utf8");
    const roadmap = readFileSync("docs/roadmap.md", "utf8");
    const issueNumbers = [2, 4, 5, 6, 7, 8, 10, 13, 16, 18, 24, 25];

    for (const issueNumber of issueNumbers) {
      expect(todo).toContain(`[#${issueNumber}]`);
      expect(`${matrix}\n${roadmap}`).toContain(`/issues/${issueNumber}`);
    }
  });

  it("lists every open issue under its owning roadmap phase", () => {
    const roadmap = readFileSync("docs/roadmap.md", "utf8");
    const phase = (number: number) =>
      roadmap
        .split(new RegExp(`## Phase ${number} [^\\n]*\\n`), 2)[1]
        ?.split(/^## /m, 1)[0] ?? "";

    expect(phase(1)).toContain("issues/9");
    expect(phase(1)).toContain("issues/20");
    expect(phase(1)).toContain("issues/18");
    for (const issue of [25, 37, 38, 39, 40, 41, 2, 5, 4, 6]) {
      expect(phase(2), `Phase 2 is missing issue #${issue}`).toContain(`issues/${issue}`);
    }
    for (const issue of [24, 8, 10, 7, 16]) {
      expect(phase(3), `Phase 3 is missing issue #${issue}`).toContain(`issues/${issue}`);
    }
    expect(phase(4)).toContain("issues/13");
  });

  it("keeps the active issue index in roadmap execution order", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo.split("Closed issue history", 1)[0] ?? todo;
    const rows = [...activeIndex.matchAll(/^\| (Active|Next|Blocked|Queued) \| (\d) \| \[#(\d+)\]/gm)].map(
      ([, status, phase, issue]) => [status, Number(phase), Number(issue)],
    );

    expect(rows).toEqual([
      ["Queued", 1, 18],
      ["Queued", 2, 25],
      ["Queued", 2, 2],
      ["Queued", 2, 5],
      ["Queued", 2, 4],
      ["Queued", 2, 6],
      ["Queued", 3, 24],
      ["Queued", 3, 8],
      ["Queued", 3, 10],
      ["Queued", 3, 7],
      ["Queued", 3, 16],
      ["Queued", 4, 13],
    ]);
    expect(rows.filter(([status]) => status === "Active")).toHaveLength(0);
  });

  it("keeps one ordered immediate queue with explicit handoff conditions", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const immediateQueue = todo
      .split("## Immediate execution queue", 2)[1]
      ?.split("## Active issue index", 1)[0];

    expect(immediateQueue).toBeDefined();
    const rows = [...(immediateQueue ?? "").matchAll(/^\| (\d+) \| \[#(\d+)\].*\| (.+) \|$/gm)].map(
      ([, order, issue, exitCondition]) => [Number(order), Number(issue), exitCondition.trim()],
    );
    expect(rows).toEqual([]);
    for (const [, , exitCondition] of rows) {
      expect(exitCondition).not.toBe("");
    }
  });

  it("keeps closed issue history outside the active issue table", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo
      .split("## Active issue index", 2)[1]
      ?.split(/Each active child Issue is widened/, 1)[0] ?? "";

    expect(activeIndex).not.toContain("issues/1)");
    expect(activeIndex).not.toContain("issues/14)");
    expect(activeIndex).not.toContain("issues/17)");
    expect(activeIndex).not.toContain("issues/21)");
    expect(activeIndex).not.toContain("issues/9)");
    expect(activeIndex).not.toContain("issues/26)");
    expect(activeIndex).not.toContain("issues/27)");
    expect(activeIndex).not.toContain("issues/28)");
    expect(activeIndex).not.toContain("issues/29)");
    expect(activeIndex).not.toContain("issues/30)");
    expect(activeIndex).not.toContain("issues/31)");
    expect(activeIndex).not.toContain("issues/32)");
    expect(activeIndex).not.toContain("issues/33)");
    expect(activeIndex).not.toContain("issues/34)");
    expect(activeIndex).not.toContain("issues/35)");
    expect(activeIndex).not.toContain("issues/36)");
    expect(activeIndex).not.toContain("issues/37)");
    expect(todo).toContain("closed [#1]");
    expect(todo).toContain("closed [#14]");
    expect(todo).toContain("closed [#17]");
    expect(todo).toContain("closed [#21]");
    expect(todo).toContain("closed [#9]");
    expect(todo).toContain("closed\n[#26]");
    expect(todo).toContain("closed\n[#27]");
    expect(todo).toContain("closed\n[#28]");
    expect(todo).toContain("closed [#29]");
    expect(todo).toContain("closed\n[#30]");
    expect(todo).toContain("closed [#31]");
    expect(todo).toContain("solver controls fail closed. (#32)");
    expect(todo).toContain("piecewise recurrence handoffs closed [#32]");
    expect(todo).toContain("and [#33]");
    expect(todo).toContain("recurrence unification closed [#34]");
    expect(todo).toContain("two-diamond recurrence composition closed [#35]");
    expect(todo).toContain("finite-switch recurrence fan-out closed [#36]");
    expect(todo).toContain("common ordered join IR closed with #37");
  });
});
