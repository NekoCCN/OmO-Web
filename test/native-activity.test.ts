import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeActivity } from "../src/native-activity.ts";
import { renderNativeActivity } from "../src/web/native-activity.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function agentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omo-native-activity-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeDag(directory: string, name: string, payload: unknown): Promise<void> {
  await mkdir(join(directory, "herdr-dag"), { recursive: true });
  await writeFile(join(directory, "herdr-dag", name), JSON.stringify(payload));
}

function projection(sessionId: string) {
  return {
    version: 1,
    sessionId,
    connected: true,
    language: "zh-CN",
    updatedAt: 1795460000000,
    runs: [{
      id: "run-1",
      name: "工作台增量",
      status: "running",
      createdAt: 1795459900000,
      updatedAt: 1795460000000,
      nodes: [
        { id: "n1", label: "读取计划", state: "done", attempt: 1, taskId: "t1" },
        { id: "n2", label: "实现读取器", state: "running", attempt: 2, taskId: "t2" },
        { id: "n3", label: "实现渲染器", state: "pending", attempt: 0 },
      ],
      edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
    }],
    tasks: [
      { id: "t1", description: "读取计划文档", agent: "worker-a", model: "test-model", status: "done",
        startedAt: 1795459900000, completedAt: 1795459950000, turns: 3, toolCalls: 12 },
      { id: "t2", description: "实现读取器", agent: "worker-b", model: { provider: "local", name: "Fixture model", baseUrl: "https://credential.invalid" },
        status: "running", startedAt: 1795459950000, turns: 1, toolCalls: 4 },
    ],
    prompt: "secret prompt text",
    transcript: [{ role: "user", content: "secret transcript" }],
  };
}

class FakeElement {
  readonly tag: string;
  className = "";
  text = "";
  children: FakeElement[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") this.text += node;
      else this.children.push(node);
    }
  }

  get textContent(): string {
    return this.text + this.children.map(child => child.textContent).join("");
  }

  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }

  get childElementCount(): number {
    return this.children.length;
  }
}

function installDom(): void {
  Object.assign(globalThis, { document: { createElement: (tag: string) => new FakeElement(tag) } });
}

function renderedText(data: unknown): string {
  installDom();
  const root = renderNativeActivity(data as Record<string, unknown>);
  if (!(root instanceof FakeElement)) throw new TypeError("Renderer returned a foreign element");
  return root.textContent;
}

describe("native activity projection", () => {
  test("reports unavailable for a Web-only session without an export", async () => {
    const directory = await agentDir();
    const view = await new NativeActivity(directory).read("session-without-export");
    expect(view).toEqual({ status: "unavailable", reason: "missing-projection" });
    const text = renderedText(view);
    expect(text).toContain("不可用");
    expect(text).not.toContain("没有任务");
    expect(text).not.toMatch(/任务.*0|0.*任务/);
  });

  test("reports unavailable without an agent directory", async () => {
    expect(await new NativeActivity(undefined).read("any-session")).toEqual({ status: "unavailable", reason: "no-agent-dir" });
    expect(renderedText({ status: "unavailable", reason: "no-agent-dir" })).toContain("不可用");
  });

  test("isolates projections owned by other sessions", async () => {
    const directory = await agentDir();
    await writeDag(directory, "aaaaaaaaaaaaaaaaaaaaaaaa.json", projection("session-alpha"));
    await writeDag(directory, "bbbbbbbbbbbbbbbbbbbbbbbb.json", projection("session-beta"));
    const view = await new NativeActivity(directory).read("session-alpha");
    if (view.status !== "ok") throw new TypeError("Expected an ok view");
    expect(view.sessionId).toBe("session-alpha");
    expect(JSON.stringify(view)).not.toContain("session-beta");
  });

  test("reads a valid graph and preserves snapshot state", async () => {
    const directory = await agentDir();
    await writeDag(directory, "cccccccccccccccccccccccc.json", projection("session-alpha"));
    const view = await new NativeActivity(directory).read("session-alpha");
    if (view.status !== "ok") throw new TypeError("Expected an ok view");
    expect(view.connected).toBe(true);
    expect(view.updatedAt).toBe(1795460000000);
    expect(view.runs.map(run => run.name)).toEqual(["工作台增量"]);
    const run = view.runs[0];
    if (!run) throw new TypeError("Expected one run");
    expect(run.nodes.map(node => [node.label, node.state, node.attempt])).toEqual([
      ["读取计划", "done", 1],
      ["实现读取器", "running", 2],
      ["实现渲染器", "pending", 0],
    ]);
    expect(run.edges.map(edge => [edge.fromLabel, edge.toLabel])).toEqual([
      ["读取计划", "实现读取器"],
      ["实现读取器", "实现渲染器"],
    ]);
    expect(run.nodes[2]?.upstream).toEqual(["实现读取器"]);
    expect(view.tasks.map(task => [task.id, task.description, task.agent, task.model, task.status, task.turns, task.toolCalls]))
      .toEqual([
        ["t1", "读取计划文档", "worker-a", "test-model", "done", 3, 12],
        ["t2", "实现读取器", "worker-b", "local · Fixture model", "running", 1, 4],
      ]);
  });

  test("fails closed on unknown versions and sidecar files", async () => {
    const directory = await agentDir();
    await writeDag(directory, "dddddddddddddddddddddddd.json", { ...projection("session-alpha"), version: 2 });
    await writeDag(directory, "dddddddddddddddddddddddd.view.json", projection("session-alpha"));
    await writeDag(directory, "dddddddddddddddddddddddd.pane.json", projection("session-alpha"));
    await writeDag(directory, "not-a-dag.json", projection("session-alpha"));
    const view = await new NativeActivity(directory).read("session-alpha");
    expect(view).toEqual({ status: "unavailable", reason: "missing-projection" });
  });

  test("never exposes private fields or filesystem paths", async () => {
    const directory = await agentDir();
    const payload = projection("session-alpha");
    payload.runs[0].nodes[0] = { ...payload.runs[0].nodes[0], error: "raw stack trace", prompt: "node prompt" } as never;
    await writeDag(directory, "eeeeeeeeeeeeeeeeeeeeeeee.json", payload);
    const view = await new NativeActivity(directory).read("session-alpha");
    const wire = JSON.stringify(view);
    for (const secret of ["secret prompt text", "secret transcript", "raw stack trace", "node prompt", "credential.invalid", directory]) {
      expect(wire).not.toContain(secret);
    }
  });

  test("renders dependency edges, attempts, and child metadata without raw errors", async () => {
    const directory = await agentDir();
    await writeDag(directory, "ffffffffffffffffffffffff.json", projection("session-alpha"));
    const view = await new NativeActivity(directory).read("session-alpha");
    const text = renderedText(view);
    for (const visible of ["读取计划", "实现渲染器", "读取计划 → 实现读取器", "尝试 2 次", "上游：实现读取器",
      "t2", "worker-b", "local · Fixture model", "快照时间", "非实时"]) {
      expect(text).toContain(visible);
    }
    for (const hidden of ["secret prompt text", "secret transcript", "credential.invalid"]) {
      expect(text).not.toContain(hidden);
    }
  });
});
