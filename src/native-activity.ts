import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

// Native OmO 5.1.81 CLI writes an already-projected v1 status file per durable
// session under `<agentDir>/herdr-dag/<24hex>.json`. The file name is opaque:
// it is not derived from the session id, so readers must scan candidates and
// match the embedded `sessionId` exactly. Sidecar files (`*.view.json`,
// `*.pane.json`) are never status projections and are always skipped.
const FILE_PATTERN = /^[0-9a-f]{24}\.json$/;
const MAX_FILES = 256;
const MAX_BYTES = 512 * 1024;
const MAX_ID_LENGTH = 200;
const identifier = z.string().min(1).max(MAX_ID_LENGTH);
const timestamp = z.union([z.number().min(0), z.iso.datetime().transform(value => Date.parse(value))]);
const count = z.number().int().min(0).max(1_000_000);
const caption = z.string().min(1).max(2000);

// z.object strips unknown keys instead of rejecting them, which keeps prompt,
// transcript, raw error and path fields out of the view by construction.
const nativeNode = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  state: z.string().min(1).max(60),
  attempt: z.number().int().min(0).max(1_000_000),
  taskId: z.string().min(1).max(200).optional(),
});

const nativeEdge = z.object({
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
});

const nativeRun = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  status: z.string().min(1).max(60),
  createdAt: timestamp,
  updatedAt: timestamp,
  nodes: z.array(nativeNode).max(500),
  edges: z.array(nativeEdge).max(2000),
});

const modelRef = z.union([
  z.string().min(1).max(500),
  z.object({
    provider: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(300).optional(),
    id: z.string().min(1).max(300).optional(),
  }),
]);

const nativeTask = z.object({
  id: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  agent: z.string().min(1).max(200),
  model: modelRef.optional(),
  status: z.string().min(1).max(60),
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  turns: count.optional(),
  toolCalls: count.optional(),
  parentTaskId: identifier.optional(),
});

const projectionFile = z.object({
  version: z.literal(1),
  sessionId: identifier,
  connected: z.boolean(),
  language: z.string().min(1).max(60),
  updatedAt: timestamp,
  runs: z.array(nativeRun).max(100),
  tasks: z.array(nativeTask).max(500),
});

const checkpoint = z.object({
  schemaVersion: z.literal(1),
  parentSessionId: identifier,
  runId: identifier,
  name: caption.optional(),
  runKey: caption.optional(),
  status: z.string().min(1).max(60),
  createdAt: timestamp,
  updatedAt: timestamp,
  definition: z.object({
    nodes: z.array(z.object({ id: identifier, label: caption.optional() })).max(500),
  }).optional(),
  nodes: z.array(nativeNode.omit({ label: true }).extend({ label: caption.optional() })).max(500),
  edges: z.array(nativeEdge).max(2000),
});
const stats = z.object({ turns: count.optional(), tool_calls: count.optional() });
const taskRecord = z.object({
  task_id: identifier,
  parent_session_id: identifier,
  child_session_id: identifier.optional(),
  description: caption.optional(),
  task_summary: caption.optional(),
  name: caption.optional(),
  category: identifier.optional(),
  agent_type: identifier.optional(),
  model: modelRef.optional(),
  resolved_model: z.object({ display: caption.optional() }).optional(),
  status: z.string().min(1).max(60),
  created_at: timestamp,
  updated_at: timestamp,
  started_at: timestamp.optional(),
  terminal_at: timestamp.optional(),
  live_progress: stats.extend({ started_at: timestamp.optional() }).optional(),
  run_stats: stats.optional(),
});
type Projection = Omit<z.infer<typeof projectionFile>, "connected" | "language"> & {
  readonly connected?: boolean;
  readonly language?: string;
};

export type NativeActivityEdgeView = {
  readonly from: string;
  readonly to: string;
  readonly fromLabel: string;
  readonly toLabel: string;
};

export type NativeActivityNodeView = {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly attempt: number;
  readonly taskId?: string;
  readonly upstream: readonly string[];
};

export type NativeActivityRunView = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nodes: readonly NativeActivityNodeView[];
  readonly edges: readonly NativeActivityEdgeView[];
};

export type NativeActivityTaskView = {
  readonly id: string;
  readonly description: string;
  readonly agent: string;
  readonly model: string;
  readonly status: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly parentTaskId?: string;
};

export type NativeActivityUnavailable = {
  readonly status: "unavailable";
  readonly reason: "no-agent-dir" | "invalid-id" | "missing-projection";
};

export type NativeActivityOk = {
  readonly status: "ok";
  readonly sessionId: string;
  readonly connected?: boolean;
  readonly language?: string;
  readonly updatedAt: number;
  readonly runs: readonly NativeActivityRunView[];
  readonly tasks: readonly NativeActivityTaskView[];
};

export type NativeActivityView = NativeActivityUnavailable | NativeActivityOk;

function modelText(value: Projection["tasks"][number]["model"]): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  return [value.provider, value.name ?? value.id].filter((part): part is string => Boolean(part)).join(" · ");
}

function toView(file: Projection): NativeActivityOk {
  const runs = file.runs.map((run): NativeActivityRunView => {
    const labels = new Map(run.nodes.map(node => [node.id, node.label]));
    const labelOf = (id: string): string => labels.get(id) ?? id;
    const upstream = new Map<string, string[]>();
    const edges = run.edges.map((edge): NativeActivityEdgeView => {
      const fromLabel = labelOf(edge.from);
      const toLabel = labelOf(edge.to);
      const known = upstream.get(edge.to) ?? [];
      if (!known.includes(fromLabel)) upstream.set(edge.to, [...known, fromLabel]);
      return { from: edge.from, to: edge.to, fromLabel, toLabel };
    });
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      nodes: run.nodes.map((node): NativeActivityNodeView => ({
        id: node.id,
        label: node.label,
        state: node.state,
        attempt: node.attempt,
        ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
        upstream: upstream.get(node.id) ?? [],
      })),
      edges,
    };
  });
  return {
    status: "ok",
    sessionId: file.sessionId,
    connected: file.connected,
    language: file.language,
    updatedAt: file.updatedAt,
    runs,
    tasks: file.tasks.map((task): NativeActivityTaskView => ({
      id: task.id,
      description: task.description,
      agent: task.agent,
      model: modelText(task.model),
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      turns: task.turns,
      toolCalls: task.toolCalls,
      parentTaskId: task.parentTaskId,
    })),
  };
}

async function* readRecords(directory: string, pattern: RegExp): AsyncGenerator<unknown> {
  try {
    if (await realpath(directory) !== directory) return;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && pattern.test(entry.name));
    const candidates = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.size >= 2 && info.size <= MAX_BYTES) candidates.push({ path, modified: info.mtimeMs });
    }
    candidates.sort((left, right) => right.modified - left.modified);
    for (const { path } of candidates.slice(0, MAX_FILES)) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
      if (!handle) continue;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 2 || info.size > MAX_BYTES) continue;
        const content = Buffer.allocUnsafe(info.size);
        const { bytesRead } = await handle.read(content, 0, content.length, 0);
        if (bytesRead === content.length) yield JSON.parse(content.toString("utf8"));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}

async function workspaceProjection(agentDir: string, cwd: string, sessionId: string): Promise<Projection | undefined> {
  if (await realpath(cwd).catch(() => undefined) !== cwd) return;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const key = `${basename(cwd).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"}-${hash}`;
  const store = join(agentDir, "projects", key, "senpi-task");
  const runs: Projection["runs"] = [];
  let updatedAt = 0;
  for await (const raw of readRecords(join(store, "dag", "runs"), /^dag_[A-Za-z0-9_-]+\.json$/)) {
    const parsed = checkpoint.safeParse(raw);
    if (!parsed.success || parsed.data.parentSessionId !== sessionId || runs.length >= 100) continue;
    const row = parsed.data;
    const labels = new Map(row.definition?.nodes.map(node => [node.id, node.label]));
    const nodes = row.nodes.map(node => ({ ...node, label: node.label || labels.get(node.id) || node.id }));
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length || row.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) continue;
    runs.push({ id: row.runId, name: row.name || row.runKey || row.runId, status: row.status,
      createdAt: row.createdAt, updatedAt: row.updatedAt, nodes, edges: row.edges });
    updatedAt = Math.max(updatedAt, row.updatedAt);
  }
  const byOwner = new Map<string, z.infer<typeof taskRecord>[]>();
  for await (const raw of readRecords(join(store, "tasks"), /^st_[A-Za-z0-9_-]+\.json$/)) {
    const parsed = taskRecord.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const owned = byOwner.get(row.parent_session_id);
    if (owned) owned.push(row);
    else byOwner.set(row.parent_session_id, [row]);
  }
  const tasks: Projection["tasks"] = [];
  const owners: { readonly id: string; readonly parent?: string }[] = [{ id: sessionId }];
  const seen = new Set<string>();
  const seenTasks = new Set<string>();
  for (const owner of owners) {
    if (seen.has(owner.id)) continue;
    seen.add(owner.id);
    for (const row of byOwner.get(owner.id) ?? []) {
      if (seenTasks.has(row.task_id)) continue;
      seenTasks.add(row.task_id);
      if (row.child_session_id) owners.push({ id: row.child_session_id, parent: row.task_id });
      tasks.push({ id: row.task_id, parentTaskId: owner.parent, status: row.status,
        description: row.task_summary || row.description || row.name || row.task_id,
        agent: row.agent_type || row.category || "", model: row.resolved_model?.display || row.model,
        startedAt: row.started_at ?? row.live_progress?.started_at ?? row.created_at, completedAt: row.terminal_at,
        turns: row.live_progress?.turns ?? row.run_stats?.turns, toolCalls: row.live_progress?.tool_calls ?? row.run_stats?.tool_calls });
      updatedAt = Math.max(updatedAt, row.updated_at);
    }
  }
  return runs.length || tasks.length ? { version: 1, sessionId, updatedAt, runs, tasks } : undefined;
}

export class NativeActivity {
  readonly #agentDir: string | undefined;

  constructor(agentDir: string | undefined) {
    const trimmed = agentDir?.trim();
    this.#agentDir = trimmed ? resolve(trimmed) : undefined;
  }

  /** `cwd` must come from the server's authorized session, never from a request parameter. */
  async read(durableSessionId: string, cwd?: string): Promise<NativeActivityView> {
    if (!this.#agentDir) return { status: "unavailable", reason: "no-agent-dir" };
    if (!identifier.safeParse(durableSessionId).success) {
      return { status: "unavailable", reason: "invalid-id" };
    }
    const agentDir = await realpath(this.#agentDir).catch(() => undefined);
    if (agentDir) {
      const native = cwd ? await workspaceProjection(agentDir, cwd, durableSessionId) : undefined;
      if (native) return toView(native);
      for await (const raw of readRecords(join(agentDir, "herdr-dag"), FILE_PATTERN)) {
        const parsed = projectionFile.safeParse(raw);
        if (parsed.success && parsed.data.sessionId === durableSessionId) return toView(parsed.data);
      }
    }
    return { status: "unavailable", reason: "missing-projection" };
  }
}
