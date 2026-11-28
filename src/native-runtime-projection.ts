import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { WireObject } from "./protocol.ts";

export const identity = z.string().min(1).max(256).regex(/\S/u);
export const count = z.int().nonnegative();
export const timestamp = z.iso.datetime().transform(Date.parse).pipe(z.int());
export const RUNTIME_LIST_LIMIT = 256;
export const boundedRows = <T extends z.ZodType>(row: T, limit = RUNTIME_LIST_LIMIT) =>
  z.preprocess(value => Array.isArray(value) && value.length <= limit ? value : undefined, z.array(row));

const malformed = { status: "malformed" } as const;
const ownershipChanged = { status: "ownership_changed" } as const;
const notFound = { status: "not_found" } as const;
const displayText = (maxBytes: number) => z.string().max(maxBytes * 2)
  .transform(value => stripVTControlCharacters(value).replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").trim())
  .refine(value => value.length > 0 && Buffer.byteLength(value) <= maxBytes &&
    !/[<>]|(?:^|[\s"'`(=])(?:~?\/(?!\s|$)|[a-z]:[\\/]|\\\\)/iu.test(value))
  .optional().catch(undefined);
const title = displayText(128);
const description = displayText(320);
const model = z.string().max(128)
  .regex(/^(?![a-z]:\/)[a-z\d][a-z\d._:@+-]*(?:\/[a-z\d][a-z\d._:@+-]*)*$/iu);
const configuredModel = model.optional().catch(undefined);
const effectiveModel = z.object({
  provider: z.string().max(48).regex(/^[a-z\d][a-z\d._-]*$/iu),
  model_id: model,
  reasoning: z.string().max(32).regex(/^[a-z\d][a-z\d_-]*$/iu).optional().catch(undefined),
}).transform(({ provider, model_id, reasoning }) => ({ provider, modelId: model_id, reasoning })).optional().catch(undefined);
const optionalTime = timestamp.optional().catch(undefined);

// Routing metadata is restricted to known roles and the two Native modes.
const agent = z.enum(["explore", "librarian", "delivery-worker", "technical-writing", "quick-scan"]);
const category = z.enum(["quick", "deep-low", "deep-high", "writing", "visual-engineering",
  "unspecified-low", "unspecified-high", "architect", "artistry", "ultrabrain"]);
const executionMode = z.enum(["in-process", "process"]);
const taskId = z.string().regex(/^st_[0-9a-f]{8}$/u).brand<"NativeTaskId">().optional().catch(undefined);
type NativeTaskId = Exclude<z.infer<typeof taskId>, undefined>;
export type RuntimeTaskOwner = { readonly sessionId: string; readonly taskKey: (id: NativeTaskId) => string };
const taskStatus = z.enum(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"]);
const taskRow = z.object({
  task_id: taskId, status: taskStatus, created_at: timestamp, updated_at: timestamp,
  agent_type: agent.optional().catch(undefined),
  category: category.optional().catch(undefined),
  execution_mode: executionMode.optional().catch(undefined),
  task_summary: title, description, model: configuredModel, effective_model: effectiveModel,
  description_truncated: z.boolean().optional().catch(undefined),
});
const taskReply = z.object({
  parent_session_id: identity, tasks: boundedRows(taskRow), truncated_tasks: count.optional(),
});

export function projectTasks(raw: WireObject, owner: RuntimeTaskOwner) {
  switch (raw.kind) {
    case "unavailable": return { status: "unavailable", reason: "native_unavailable" } as const;
    case "not_found": return ownershipChanged;
    case undefined: break;
    default: return malformed;
  }
  const parsed = taskReply.safeParse(raw);
  if (!parsed.success) return malformed;
  const { parent_session_id, tasks, truncated_tasks = 0 } = parsed.data;
  if (parent_session_id !== owner.sessionId) return ownershipChanged;
  if (truncated_tasks > 0 && tasks.length !== RUNTIME_LIST_LIMIT) return malformed;
  if (tasks.length === 0) return { status: "empty" } as const;
  const keys = new Set<string>();
  const rows = [];
  for (const row of tasks) {
    const key = row.task_id === undefined ? undefined : owner.taskKey(row.task_id);
    if (key !== undefined) {
      if (keys.has(key)) return malformed;
      keys.add(key);
    }
    rows.push({ key, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      agent: row.agent_type, category: row.category, executionMode: row.execution_mode,
      title: row.task_summary, description: row.description_truncated === true ? undefined : row.description,
      configuredModel: row.model, effectiveModel: row.effective_model });
  }
  return { status: "ok", rows, omittedCount: truncated_tasks } as const;
}

const runId = z.templateLiteral(["dag_", z.uuidv4()]);
const dagStatus = z.enum(["pending", "running", "paused", "completed", "failed", "cancelled"]);
const statusesByScope = {
  current: [dagStatus.enum.pending, dagStatus.enum.running, dagStatus.enum.paused],
  history: [dagStatus.enum.completed, dagStatus.enum.failed, dagStatus.enum.cancelled],
} satisfies Record<string, readonly z.infer<typeof dagStatus>[]>;
export type DagScope = keyof typeof statusesByScope;
export const dagStatuses = (scope: DagScope): readonly z.infer<typeof dagStatus>[] => statusesByScope[scope];
const nodeState = z.enum(["pending", "blocked", "scheduled", "running", "paused", "completed", "failed", "cancelled", "skipped"]);
const optionalCount = count.optional().catch(undefined);
const dagRow = z.object({
  runId: runId.optional().catch(undefined),
  name: title,
  parentSessionId: identity, status: dagStatus, createdAt: timestamp, updatedAt: timestamp,
  counts: z.object({ total: count, pending: optionalCount, blocked: optionalCount, scheduled: optionalCount,
    running: optionalCount, paused: optionalCount, completed: optionalCount, failed: optionalCount,
    cancelled: optionalCount, skipped: optionalCount }),
});
export const dagReply = z.object({
  ok: z.literal(true), value: z.object({
    limit: z.literal(RUNTIME_LIST_LIMIT),
    runs: boundedRows(dagRow),
  }),
});

type DagListRow = z.infer<typeof dagReply>["value"]["runs"][number];
export function projectDagRow(row: DagListRow, keyForRun: (id: string) => string) {
  const { total, ...counts } = row.counts;
  const entries = Object.entries(counts).filter(([, value]) => value !== undefined && value <= total);
  return { status: row.status, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt, nodeCount: total,
    ...(entries.length === 0 ? {} : { counts: Object.fromEntries(entries) }),
    ...(row.runId === undefined ? {} : { key: keyForRun(row.runId) }) };
}

const MAX_NODES = 64;
const MAX_EDGES = MAX_NODES * (MAX_NODES - 1) / 2;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const routeMetadata = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agent: agent.optional().catch(undefined), model: configuredModel }),
  z.object({ kind: z.literal("category"), category: category.optional().catch(undefined) }),
]).transform(route => {
  switch (route.kind) {
    case "agent": return { agent: route.agent, configuredModel: route.model };
    case "category": return { category: route.category };
  }
}).optional().catch(undefined);
const executionTimes = { createdAt: optionalTime, startedAt: optionalTime, completedAt: optionalTime };
const snapshot = z.object({ ok: z.literal(true), value: z.object({
  schemaVersion: z.literal(1), runId, parentSessionId: identity, status: dagStatus,
  name: title, ...executionTimes,
  counts: z.object({ total: count }),
  nodes: boundedRows(z.object({ id: identity, state: nodeState, attempt: count,
    label: title, taskId, ...executionTimes, lastActivityAt: optionalTime,
    dependsOn: boundedRows(identity, MAX_NODES - 1), route: routeMetadata,
  }), MAX_NODES),
  edges: boundedRows(z.object({ from: identity, to: identity }), MAX_EDGES),
  waves: boundedRows(z.object({ index: count, nodeIds: boundedRows(identity, MAX_NODES) }), MAX_NODES),
}) });

export function projectDagSnapshot(raw: WireObject, expected: {
  readonly runId: string; readonly owner: string; readonly scope: DagScope;
  readonly taskKey: (id: NativeTaskId) => string | undefined;
}) {
  if (raw.ok === false) {
    const error = z.object({ code: z.string() }).safeParse(raw.error);
    if (!error.success) return malformed;
    switch (error.data.code) {
      case "run_not_found":
      case "run_not_owned": return notFound;
      case "history_unavailable": return { status: "unavailable", reason: "native_unavailable" } as const;
      default: return malformed;
    }
  }
  // The engine already enforces a transport-frame limit. Bound this whole value
  // before validating topology, including private fields discarded by the schemas.
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_SNAPSHOT_BYTES) return malformed;
  } catch (error) {
    if (error instanceof RangeError) return malformed;
    throw error;
  }
  const parsed = snapshot.safeParse(raw);
  if (!parsed.success) return malformed;
  const graph = parsed.data.value;
  if (graph.runId !== expected.runId || graph.parentSessionId !== expected.owner) return ownershipChanged;
  if (!dagStatuses(expected.scope).includes(graph.status)) return notFound;
  if (!graph.nodes.length || graph.nodes.length !== graph.counts.total || graph.waves.length > graph.nodes.length) return malformed;
  const nativeNodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nativeNodes.size !== graph.nodes.length) return malformed;

  const local = new Map<string, { readonly id: number; readonly wave: number; readonly upstream: Set<number> }>();
  const waves = [];
  for (const [index, wave] of graph.waves.entries()) {
    if (wave.index !== index || wave.nodeIds.length === 0) return malformed;
    const nodes = [];
    for (const nativeId of wave.nodeIds) {
      if (!nativeNodes.has(nativeId) || local.has(nativeId)) return malformed;
      nodes.push(local.size);
      local.set(nativeId, { id: local.size, wave: index, upstream: new Set() });
    }
    waves.push({ index, nodes });
  }
  if (local.size !== nativeNodes.size) return malformed;
  const addEdge = (from: string, to: string) => {
    const upstream = local.get(from);
    const downstream = local.get(to);
    if (!upstream || !downstream || upstream.wave >= downstream.wave) return false;
    downstream.upstream.add(upstream.id);
    return true;
  };
  for (const { from, to } of graph.edges) if (!addEdge(from, to)) return malformed;
  for (const node of graph.nodes) for (const from of node.dependsOn) if (!addEdge(from, node.id)) return malformed;

  const nodes = [];
  for (const [nativeId, position] of local) {
    const node = nativeNodes.get(nativeId);
    if (!node) return malformed;
    nodes.push({ id: position.id, state: node.state, attempt: node.attempt,
      upstream: [...position.upstream].sort((a, b) => a - b),
      label: node.label, createdAt: node.createdAt, startedAt: node.startedAt,
      completedAt: node.completedAt, lastActivityAt: node.lastActivityAt, ...node.route,
      taskKey: node.taskId === undefined ? undefined : expected.taskKey(node.taskId),
    });
  }
  return { status: "ok", runStatus: graph.status, name: graph.name, createdAt: graph.createdAt,
    startedAt: graph.startedAt, completedAt: graph.completedAt, waves, nodes } as const;
}
