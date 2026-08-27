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
    const issueNumbers = [2, 4, 5, 6, 7, 8, 9, 10, 13, 16, 18, 20, 23, 24];

    for (const issueNumber of issueNumbers) {
      expect(todo).toContain(`[#${issueNumber}]`);
      expect(`${matrix}\n${roadmap}`).toContain(`/issues/${issueNumber}`);
    }
  });

  it("keeps the active issue index in roadmap execution order", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo.split("Closed issue history", 1)[0] ?? todo;
    const rows = [...activeIndex.matchAll(/^\| (Active|Next|Blocked|Queued) \| (\d) \| \[#(\d+)\]/gm)].map(
      ([, status, phase, issue]) => [status, Number(phase), Number(issue)],
    );

    expect(rows).toEqual([
      ["Active", 1, 9],
      ["Next", 1, 20],
      ["Blocked", 1, 18],
      ["Queued", 2, 23],
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
    expect(rows.filter(([status]) => status === "Active")).toHaveLength(1);
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
    expect(rows.map(([order, issue]) => [order, issue])).toEqual([
      [1, 9],
      [2, 20],
      [3, 18],
    ]);
    for (const [, , exitCondition] of rows) {
      expect(exitCondition).not.toBe("");
    }
  });

  it("keeps closed issue history outside the active issue table", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo.split("Closed issue history", 1)[0] ?? todo;

    expect(activeIndex).not.toContain("issues/1)");
    expect(activeIndex).not.toContain("issues/14)");
    expect(activeIndex).not.toContain("issues/17)");
    expect(activeIndex).not.toContain("issues/21)");
    expect(todo).toContain("closed [#1]");
    expect(todo).toContain("closed [#14]");
    expect(todo).toContain("closed [#17]");
    expect(todo).toContain("closed [#21]");
  });
});
