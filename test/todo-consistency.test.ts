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
});
