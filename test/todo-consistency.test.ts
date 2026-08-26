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
    const issueNumbers = [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 16, 17, 18, 20];

    for (const issueNumber of issueNumbers) {
      expect(todo).toContain(`[#${issueNumber}]`);
      expect(`${matrix}\n${roadmap}`).toContain(`/issues/${issueNumber}`);
    }
  });

  it("keeps the active issue index in roadmap execution order", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo.split("Closed issue history", 1)[0] ?? todo;
    const rows = [...activeIndex.matchAll(/^\| (\d) \| \[#(\d+)\]/gm)].map(
      ([, phase, issue]) => [Number(phase), Number(issue)],
    );

    expect(rows).toEqual([
      [1, 17],
      [1, 3],
      [1, 9],
      [1, 20],
      [1, 18],
      [2, 2],
      [2, 5],
      [2, 4],
      [2, 6],
      [3, 8],
      [3, 10],
      [3, 7],
      [3, 16],
      [4, 13],
    ]);
  });

  it("keeps closed issue history outside the active issue table", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const activeIndex = todo.split("Closed issue history", 1)[0] ?? todo;

    expect(activeIndex).not.toContain("issues/1)");
    expect(activeIndex).not.toContain("issues/14)");
    expect(activeIndex).not.toContain("issues/21)");
    expect(todo).toContain("closed [#1]");
    expect(todo).toContain("closed [#14]");
    expect(todo).toContain("closed [#21]");
  });
});
