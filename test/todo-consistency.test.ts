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
    expect(todo).toContain("proof-gated optimizer transformations: [#13]");
    expect(roadmap).toContain("issues/13");
  });

  it("keeps every open-work issue visible in the user-facing feature matrix", () => {
    const todo = readFileSync("TODO.md", "utf8");
    const matrix = readFileSync("docs/feature-matrix.md", "utf8");
    const issueNumbers = [2, 3, 4, 5, 6, 7, 8, 9, 10, 13];

    for (const issueNumber of issueNumbers) {
      expect(todo).toContain(`[#${issueNumber}]`);
      expect(matrix).toContain(`/issues/${issueNumber}`);
    }
  });
});
