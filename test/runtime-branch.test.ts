import { describe, expect, test } from "bun:test";
import { projectRuntimeBranch } from "../src/runtime-branch.ts";

// Fixture builders mirror the RAW native get_tree shape:
// { tree: [{ entry, children }], leafId }. Entry envelopes carry
// type/id/parentId/timestamp; custom entries carry customType + data;
// message entries carry message { role, toolName, details }.

function customEntry(
  id: string,
  parentId: string | null,
  customType: string,
  data: unknown,
  timestamp: unknown = "2026-11-25T00:00:00.000Z",
) {
  return { type: "custom", id, parentId, timestamp, customType, data };
}

function toolResultEntry(
  id: string,
  parentId: string | null,
  toolName: string,
  details: unknown,
  timestamp: unknown = "2026-11-25T00:00:00.000Z",
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "toolResult", toolName, details },
  };
}

function node(entry: Record<string, unknown>, children: unknown[] = []) {
  return { entry, children };
}

function tree(leafId: unknown, roots: unknown[]) {
  return { tree: roots, leafId };
}

function serialized(view: unknown): string {
  return JSON.stringify(view);
}

const TODO_V2_A = {
  schema: "v2",
  phases: [{ name: "Build", tasks: [{ content: "alpha task", status: "pending" }] }],
};
const TODO_V2_B = {
  schema: "v2",
  phases: [{ name: "Review", tasks: [{ content: "beta task", status: "in_progress" }] }],
};

function forkedTree(leafId: string) {
  return tree(leafId, [
    node(customEntry("root", null, "other.type", {}, "2026-11-25T00:00:01.000Z"), [
      node(
        customEntry("a", "root", "senpi.todo-state", TODO_V2_A, "2026-11-25T00:00:02.000Z"),
        [
          node(
            customEntry(
              "b",
              "a",
              "omo-kibitzer:nudged",
              { version: 1, nudges: [{ path: "/secret/alpha.md", hint: "alpha recall hint" }] },
              "2026-11-25T00:00:03.000Z",
            ),
          ),
        ],
      ),
      node(
        customEntry("c", "root", "senpi.todo-state", TODO_V2_B, "2026-11-25T00:00:02.000Z"),
        [
          node(
            customEntry(
              "d",
              "c",
              "omo-kibitzer:nudged",
              { version: 1, nudges: [{ path: "/secret/beta.md", hint: "beta recall hint" }] },
              "2026-11-25T00:00:03.000Z",
            ),
          ),
        ],
      ),
    ]),
  ]);
}

describe("runtime branch projection", () => {
  test("switching the active leaf selects that branch todo only", () => {
    const left = projectRuntimeBranch(forkedTree("b"));
    const right = projectRuntimeBranch(forkedTree("d"));
    if (left.status !== "ok" || right.status !== "ok") throw new Error("expected ok");
    expect(left.leafId).toBe("b");
    expect(left.todo).toEqual({
      status: "ok",
      phases: [{ name: "Build", tasks: [{ content: "alpha task", status: "pending" }] }],
    });
    expect(right.todo).toEqual({
      status: "ok",
      phases: [{ name: "Review", tasks: [{ content: "beta task", status: "in_progress" }] }],
    });
    // The sibling branch content must not leak into either projection.
    expect(serialized(left)).not.toContain("beta task");
    expect(serialized(right)).not.toContain("alpha task");
  });

  test("sibling memory records never leak across branches", () => {
    const left = projectRuntimeBranch(forkedTree("b"));
    if (left.status !== "ok") throw new Error("expected ok");
    expect(left.memory).toEqual({ status: "ok", recalledCount: 1, recentRecalledAt: Date.parse("2026-11-25T00:00:03.000Z") });
    const dump = serialized(left);
    expect(dump).not.toContain("beta recall hint");
    expect(dump).not.toContain("/secret/beta.md");
  });

  test("latest valid todo wins; a malformed entry does not clobber it", () => {
    const raw = tree("m3", [
      node(toolResultEntry("m1", null, "todo", TODO_V2_A, "2026-11-25T00:00:01.000Z"), [
        node(
          customEntry(
            "m2",
            "m1",
            "senpi.todo-state",
            { schema: "v2", phases: [{ name: "Broken", tasks: [{ content: "x", status: "zzz" }] }] },
            "2026-11-25T00:00:02.000Z",
          ),
          [node(toolResultEntry("m3", "m2", "todowrite", TODO_V2_B, "2026-11-25T00:00:03.000Z"))],
        ),
      ]),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    // m2 is malformed (unknown v2 status) so the latest VALID record is m3.
    expect(view.todo).toEqual({
      status: "ok",
      phases: [{ name: "Review", tasks: [{ content: "beta task", status: "in_progress" }] }],
    });
  });

  test("a trailing malformed entry keeps the earlier valid state", () => {
    const raw = tree("m2", [
      node(toolResultEntry("m1", null, "todo", TODO_V2_A, "2026-11-25T00:00:01.000Z"), [
        node(customEntry("m2", "m1", "senpi.todo-state", { schema: "v2", phases: "nope" })),
      ]),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.todo).toEqual({
      status: "ok",
      phases: [{ name: "Build", tasks: [{ content: "alpha task", status: "pending" }] }],
    });
  });

  test("legacy flat todos wrap into the default phase with status migration", () => {
    const raw = tree("t1", [
      node(
        toolResultEntry("t1", null, "todowrite", {
          todos: [
            { content: "old one", status: "cancelled" },
            { content: "blocked one", status: "blocked" },
            { content: "plain one" },
          ],
        }),
      ),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.todo).toEqual({
      status: "ok",
      phases: [{
        name: "Tasks",
        tasks: [
          { content: "old one", status: "abandoned" },
          { content: "blocked one", status: "pending" },
          { content: "plain one", status: "pending" },
        ],
      }],
    });
  });

  test("valid empty list, missing records, and invalid trees stay distinct", () => {
    const empty = projectRuntimeBranch(
      tree("e1", [node(customEntry("e1", null, "senpi.todo-state", { schema: "v2", phases: [] }))]),
    );
    if (empty.status !== "ok") throw new Error("expected ok");
    expect(empty.todo).toEqual({ status: "ok", phases: [] });

    const missing = projectRuntimeBranch(
      tree("n1", [node(customEntry("n1", null, "other.type", { version: 1 }))]),
    );
    if (missing.status !== "ok") throw new Error("expected ok");
    // Missing is not a real zero: explicit none, never ok-with-empty.
    expect(missing.todo).toEqual({ status: "none" });
    expect(missing.memory).toEqual({ status: "none" });

    expect(projectRuntimeBranch(null)).toEqual({ status: "invalid", reason: "missing-tree" });
    expect(projectRuntimeBranch({ tree: [], leafId: 42 })).toEqual({ status: "invalid", reason: "invalid-leaf" });
    expect(projectRuntimeBranch({ tree: [], leafId: "ghost" })).toEqual({ status: "invalid", reason: "unknown-leaf" });
    expect(projectRuntimeBranch({ tree: "nope", leafId: "ghost" })).toEqual({ status: "invalid", reason: "missing-tree" });
  });

  test("memory exposes only whitelisted scalars, never raw payload text", () => {
    const hint = "ultra secret recall hint text";
    const path = "/home/user/.omo/memory/secret-identity.md";
    const reason = "model exploded on provider p with run r";
    const raw = tree("k3", [
      node(
        customEntry("k1", null, "omo-kibitzer:nudged", {
          version: 1,
          via: "some-provider",
          nudges: [
            { path, hint },
            { path: "/second/secret.md", hint: "second secret hint" },
          ],
        }, "2026-11-25T00:00:05.000Z"),
        [
          node(
            customEntry("k2", "k1", "omo-kibitzer:gate", {
              version: 1,
              status: "failed",
              consecutiveFailures: 3,
              candidateCount: 7,
              cause: "child_failed",
              reason,
              model: "secret-model",
              category: "secret-category",
              runId: "secret-run",
            }, "2026-11-25T00:00:06.000Z"),
            [
              node(
                customEntry("k3", "k2", "omo-kibitzer:unavailable", {
                  version: 1,
                  category: "secret-category",
                  cause: "category_unavailable",
                  missingProviders: ["secret-provider"],
                  identity: "secret-identity",
                }, "2026-11-25T00:00:07.000Z"),
              ),
            ],
          ),
        ],
      ),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.memory).toEqual({
      status: "ok",
      recalledCount: 2,
      recentRecalledAt: Date.parse("2026-11-25T00:00:05.000Z"),
      gate: {
        status: "failed",
        consecutiveFailures: 3,
        candidateCount: 7,
        at: Date.parse("2026-11-25T00:00:06.000Z"),
      },
      unavailable: { count: 1, at: Date.parse("2026-11-25T00:00:07.000Z") },
    });
    const dump = serialized(view);
    for (const secret of [hint, path, reason, "secret-model", "secret-category", "secret-run", "secret-provider", "secret-identity", "second secret hint", "/second/secret.md", "some-provider"]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain("path");
    expect(dump).not.toContain("hint");
  });

  test("memory version and status gates reject non-v1 and dropped records", () => {
    const raw = tree("g3", [
      node(
        customEntry("g1", null, "omo-kibitzer:nudged", {
          version: 2,
          nudges: [{ path: "/x.md", hint: "y" }],
        }),
        [
          node(
            customEntry("g2", "g1", "omo-kibitzer:gate", {
              version: 1,
              status: "dropped",
              consecutiveFailures: 5,
              candidateCount: 5,
            }),
            [
              node(
                customEntry("g3", "g2", "omo-kibitzer:unavailable", { version: 1, cause: "nope" }),
              ),
            ],
          ),
        ],
      ),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.memory).toEqual({ status: "none" });
  });

  test("ask, details, and foreign tool results never surface in the todo view", () => {
    const raw = tree("q2", [
      node(
        customEntry("q1", null, "senpi.todo-state", {
          schema: "v2",
          phases: [{ name: "Work", tasks: [{ content: "real task", status: "pending" }] }],
          ask: { entryId: "e", text: "Ask: user secret request", capturedAt: 1 },
          rawPayload: { credentials: "hunter2" },
        }),
        [
          node(toolResultEntry("q2", "q1", "other-tool", { schema: "v2", phases: [{ name: "Fake", tasks: [{ content: "fake", status: "pending" }] }] })),
        ],
      ),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.todo).toEqual({
      status: "ok",
      phases: [{ name: "Work", tasks: [{ content: "real task", status: "pending" }] }],
    });
    const dump = serialized(view);
    expect(dump).not.toContain("user secret request");
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("fake");
  });

  test("oversized input is bounded, never passed through", () => {
    const big = "x".repeat(5000);
    const phases = Array.from({ length: 150 }, (_, i) => ({
      name: `phase-${i}`,
      tasks: [{ content: `${big}-${i}`, status: "pending" }],
    }));
    const raw = tree("z1", [node(customEntry("z1", null, "senpi.todo-state", { schema: "v2", phases }))]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok" || view.todo.status !== "ok") throw new Error("expected ok todo");
    expect(view.todo.phases.length).toBeLessThanOrEqual(100);
    for (const phase of view.todo.phases) {
      expect(phase.name.length).toBeLessThanOrEqual(200);
      for (const task of phase.tasks) expect(task.content.length).toBeLessThanOrEqual(2000);
    }
  });

  test("native empty tree with null leaf is valid empty, not invalid", () => {
    const view = projectRuntimeBranch({ tree: [], leafId: null });
    if (view.status !== "ok") throw new Error("expected ok, got " + JSON.stringify(view));
    expect(view.leafId).toBe(null);
    expect(view.todo).toEqual({ status: "none" });
    expect(view.memory).toEqual({ status: "none" });
  });

  test("adversarial: duplicate ids across branches fail closed", () => {
    const raw = tree("leaf", [
      node(customEntry("root", null, "other.type", {}, "2026-11-25T00:00:01.000Z"), [
        node(customEntry("dup", "root", "senpi.todo-state", TODO_V2_A, "2026-11-25T00:00:02.000Z"), [
          node(customEntry("sibling-leaf", "dup", "other.type", {}, "2026-11-25T00:00:03.000Z")),
        ]),
        node(customEntry("dup", "root", "senpi.todo-state", TODO_V2_B, "2026-11-25T00:00:02.000Z"), [
          node(customEntry("leaf", "dup", "other.type", {}, "2026-11-25T00:00:03.000Z")),
        ]),
      ]),
    ]);
    const view = projectRuntimeBranch(raw);
    // First-wins would silently resolve "dup" to the sibling branch and leak its todo.
    expect(view.status).toBe("invalid");
    const dump = serialized(view);
    expect(dump).not.toContain("alpha task");
    expect(dump).not.toContain("beta task");
  });

  test("adversarial: parent pointer crossing into the sibling branch fails closed", () => {
    // Leaf is structurally nested under "a" (alpha branch) but its parentId
    // points at "c" (beta branch): following parentId alone would mix sibling data.
    const raw = tree("leaf", [
      node(customEntry("root", null, "other.type", {}, "2026-11-25T00:00:01.000Z"), [
        node(customEntry("a", "root", "senpi.todo-state", TODO_V2_A, "2026-11-25T00:00:02.000Z"), [
          node(customEntry("leaf", "c", "other.type", {}, "2026-11-25T00:00:03.000Z")),
        ]),
        node(customEntry("c", "root", "senpi.todo-state", TODO_V2_B, "2026-11-25T00:00:02.000Z")),
      ]),
    ]);
    const view = projectRuntimeBranch(raw);
    expect(view.status).toBe("invalid");
    const dump = serialized(view);
    expect(dump).not.toContain("alpha task");
    expect(dump).not.toContain("beta task");
  });

  test("total task and text budgets cap output and mark it incomplete", () => {
    const content = "y".repeat(200);
    const phases = Array.from({ length: 30 }, (_, i) => ({
      name: `phase-${i}`,
      tasks: Array.from({ length: 200 }, (_, j) => ({ content: `${content}-${i}-${j}`, status: "pending" })),
    }));
    const raw = tree("z1", [node(customEntry("z1", null, "senpi.todo-state", { schema: "v2", phases }))]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok" || view.todo.status !== "ok") throw new Error("expected ok todo");
    let totalTasks = 0;
    let totalChars = 0;
    for (const phase of view.todo.phases) {
      totalTasks += phase.tasks.length;
      for (const task of phase.tasks) totalChars += task.content.length;
    }
    expect(totalTasks).toBeLessThanOrEqual(1000);
    expect(totalChars).toBeLessThanOrEqual(100000);
    expect(view.incomplete).toBe(true);
  });

  test("broadened custom todo kinds are ignored; only exact senpi.todo-state counts", () => {
    const raw = tree("w2", [
      node(customEntry("w1", null, "todo-list", TODO_V2_A, "2026-11-25T00:00:01.000Z"), [
        node(customEntry("w2", "w1", "todowrite-v2", TODO_V2_B, "2026-11-25T00:00:02.000Z")),
      ]),
    ]);
    const view = projectRuntimeBranch(raw);
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.todo).toEqual({ status: "none" });
  });

  test("structural truncation fails closed as tree-budget without leaking branch data", () => {
    // 1001 children of one root: the first child is the active leaf "choice" with
    // a Todo, the 1001st (skipped by the 1000-children cap) reuses id "choice".
    // Indexing only the first 1000 would resolve "choice" to the visible branch
    // and leak ambiguous data as ok+incomplete; fail closed instead.
    const hiddenTodo = {
      schema: "v2",
      phases: [{ name: "Review", tasks: [{ content: "beta task", status: "pending" }] }],
    };
    const children: unknown[] = [
      node(customEntry("choice", "root", "senpi.todo-state", TODO_V2_A, "2026-11-25T00:00:02.000Z")),
    ];
    for (let i = 1; i < 1000; i += 1) {
      children.push(node(customEntry(`filler-${i}`, "root", "other.type", {}, "2026-11-25T00:00:02.000Z")));
    }
    children.push(
      node(customEntry("choice", "root", "senpi.todo-state", hiddenTodo, "2026-11-25T00:00:02.000Z")),
    );
    expect(children.length).toBe(1001);
    const raw = tree("choice", [
      node(customEntry("root", null, "other.type", {}, "2026-11-25T00:00:01.000Z"), children),
    ]);
    const view = projectRuntimeBranch(raw);
    expect(view).toEqual({ status: "invalid", reason: "tree-budget" });
    const dump = serialized(view);
    expect(dump).not.toContain("alpha task");
    expect(dump).not.toContain("beta task");
  });
});
