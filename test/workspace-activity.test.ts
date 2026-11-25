import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NativeActivity } from "../src/native-activity.ts";

test("reads native DAG and child records for the selected workspace and session without Herdr", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-native-workspace-activity-"));
  try {
    const cwd = join(root, "workspace");
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const profile = join(root, "profile");
    const store = join(profile, "projects", `${basename(cwd)}-${hash}`, "senpi-task");
    const runs = join(store, "dag", "runs");
    const tasks = join(store, "tasks");
    await Promise.all([mkdir(cwd), mkdir(runs, { recursive: true }), mkdir(tasks, { recursive: true })]);
    const at = "2026-11-25T08:00:00.000Z";
    const session = "selected-session";
    const write = (path: string, value: object) => writeFile(path, JSON.stringify(value));
    const task = (id: string, owner: string) => ({
      task_id: id, parent_session_id: owner, description: `Description of ${id}`,
      category: "deep-low", status: "running", created_at: at, updated_at: at,
      resolved_model: { display: "Fixture model", key: "provider-key-canary" },
      spawn_spec: { prompt: "private prompt canary" },
    });
    await Promise.all([
      write(join(runs, "dag_real.json"), {
        schemaVersion: 1, runId: "dag_real", name: "Release", status: "running",
        parentSessionId: session, createdAt: at, updatedAt: at,
        definition: { nodes: [{ id: "scan", label: "Scan source" }, { id: "review", label: "Review changes" }] },
        nodes: [
          { id: "scan", state: "completed", attempt: 1, taskId: "st_scan", prompt: "private prompt canary" },
          { id: "review", state: "running", attempt: 2, taskId: "st_review" },
        ],
        edges: [{ from: "scan", to: "review" }],
      }),
      write(join(tasks, "st_scan.json"), { ...task("st_scan", session), child_session_id: "scan-session" }),
      write(join(tasks, "st_nested.json"), task("st_nested", "scan-session")),
      write(join(tasks, "st_other.json"), task("st_other", "other-session")),
      write(join(root, "unsafe.json"), task("st_link", session)),
    ]);
    await symlink(join(root, "unsafe.json"), join(tasks, "st_link.json"));

    const view = await new NativeActivity(profile).read(session, cwd);
    expect(view.status).toBe("ok");
    if (view.status !== "ok") return;
    expect(view.updatedAt).toBe(Date.parse(at));
    expect(view.runs[0]?.nodes.map(node => [node.label, node.attempt, node.upstream])).toEqual([
      ["Scan source", 1, []], ["Review changes", 2, ["Scan source"]],
    ]);
    expect(view.tasks.map(item => item.id).sort()).toEqual(["st_nested", "st_scan"]);
    expect(view.tasks.find(item => item.id === "st_nested")?.parentTaskId).toBe("st_scan");
    expect(view.tasks[0]?.toolCalls).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/provider-key-canary|private prompt canary/);
    expect((await new NativeActivity(profile).read("unseen-session", cwd)).status).toBe("unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
