import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Engine } from "./engine.ts";
import { boundedRows, count, dagReply, identity, projectDagRow, projectDagSnapshot,
  RUNTIME_LIST_LIMIT, taskDisplayFields, timestamp } from "./native-runtime-projection.ts";
import { WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { projectRuntimeBranch } from "./runtime-branch.ts";

const TIMEOUT = 6000;
const taskStatus = z.enum(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"]);
const taskRow = z.object({ status: taskStatus, created_at: timestamp, updated_at: timestamp, ...taskDisplayFields });
const taskReply = z.object({
  parent_session_id: identity, tasks: boundedRows(taskRow), truncated_tasks: count.optional(),
});
const memoryReply = z.object({
  schemaVersion: z.literal(1),
  journal: z.object({ sessionId: identity, totalSteps: count, reflectedSteps: count }),
});
const binding = z.object({
  sessionId: identity, cwd: z.string().min(1), sessionFile: z.string().min(1), archived: z.boolean().optional(),
});

export type NativeRuntimeBinding = Readonly<z.infer<typeof binding>> & {
  readonly route: string;
  readonly dagKey: (runId: string) => string;
};

/** Use the initial native state only when it agrees with the journal Web opened. */
export function bindNativeRuntime(raw: unknown, expected: {
  readonly route: string;
  readonly cwd: string;
  readonly sessionFile: unknown;
  readonly durableId?: string;
}): NativeRuntimeBinding | undefined {
  const state = binding.safeParse(raw);
  if (!state.success || state.data.archived === true || !expected.route || state.data.sessionId === expected.route ||
    state.data.cwd !== expected.cwd || state.data.sessionFile !== expected.sessionFile ||
    (expected.durableId !== undefined && state.data.sessionId !== expected.durableId)) return undefined;
  const secret = randomBytes(32);
  return { ...state.data, route: expected.route, dagKey: runId => createHmac("sha256", secret).update(runId).digest("hex") };
}

type UnavailableReason = "inactive" | "binding_unverified" | "unsupported" | "native_unavailable" | "engine_unavailable";
export type RuntimeInactiveReason = Extract<UnavailableReason, "inactive" | "binding_unverified" | "unsupported">;
type Failure =
  | { readonly status: "unavailable"; readonly reason: UnavailableReason }
  | { readonly status: "ownership_changed" }
  | { readonly status: "malformed" };
type Empty = { readonly status: "empty" };
type TaskRow = Readonly<ReturnType<typeof projectTaskRow>>;
type DagRow = Readonly<ReturnType<typeof projectDagRow>>;
export type NativeRuntimeSummary = {
  readonly tasks: Failure | Empty | { readonly status: "ok"; readonly rows: readonly TaskRow[]; readonly omittedCount: number };
  readonly dag: Failure | Empty | { readonly status: "ok"; readonly rows: readonly DagRow[]; readonly limitReached: boolean };
  readonly memory: Failure | { readonly status: "ok"; readonly totalSteps: number; readonly reflectedSteps: number };
};

const unavailable = (reason: UnavailableReason): Failure => ({ status: "unavailable", reason });
const ownershipChanged = { status: "ownership_changed" } as const;
const malformed = { status: "malformed" } as const;
const empty = { status: "empty" } as const;
const all = (failure: Failure): NativeRuntimeSummary => ({ tasks: failure, dag: failure, memory: failure });

export function unavailableNativeRuntime(reason: RuntimeInactiveReason): NativeRuntimeSummary {
  return all(unavailable(reason));
}

function fault(error: unknown, extension?: string): Failure {
  if (!(error instanceof WebError)) throw error;
  if (["unknown_session", "session_not_attached", "missing_session_id"].includes(error.code)) return ownershipChanged;
  if (extension !== undefined && error.message === `Unknown extension RPC request: ${extension}`) return unavailable("unsupported");
  if (["engine_unavailable", "engine_timeout", "bridge_busy"].includes(error.code)) return unavailable("engine_unavailable");
  return unavailable("native_unavailable");
}

function projectTaskRow(row: z.infer<typeof taskRow>) {
  return { status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.agent_type === undefined ? {} : { agent: row.agent_type }),
    ...(row.category === undefined ? {} : { category: row.category }),
    ...(row.execution_mode === undefined ? {} : { executionMode: row.execution_mode }) };
}

function projectTasks(raw: WireObject, durableId: string): NativeRuntimeSummary["tasks"] {
  switch (raw.kind) {
    case "unavailable": return unavailable("native_unavailable");
    case "not_found": return ownershipChanged;
    case undefined: break;
    default: return malformed;
  }
  const parsed = taskReply.safeParse(raw);
  if (!parsed.success) return malformed;
  const { parent_session_id, tasks, truncated_tasks = 0 } = parsed.data;
  if (parent_session_id !== durableId) return ownershipChanged;
  if (truncated_tasks > 0 && tasks.length !== RUNTIME_LIST_LIMIT) return malformed;
  if (tasks.length === 0) return empty;
  return { status: "ok", omittedCount: truncated_tasks, rows: tasks.map(projectTaskRow) };
}

function readDagRows(raw: WireObject, durableId: string) {
  if (raw.ok === false) {
    const error = z.object({ code: z.string() }).safeParse(raw.error);
    if (!error.success) return malformed;
    switch (error.data.code) {
      case "run_not_found":
      case "run_not_owned": return ownershipChanged;
      case "history_unavailable": return unavailable("native_unavailable");
      default: return malformed;
    }
  }
  const parsed = dagReply.safeParse(raw);
  if (!parsed.success) return malformed;
  const { runs } = parsed.data.value;
  if (runs.some(row => row.parentSessionId !== durableId)) return ownershipChanged;
  const ids = runs.flatMap(row => row.runId === undefined ? [] : [row.runId]);
  if (new Set(ids).size !== ids.length) return malformed;
  return { runs };
}

function projectMemory(raw: WireObject, durableId: string): NativeRuntimeSummary["memory"] {
  if (raw.kind === "unavailable") return unavailable("native_unavailable");
  if (raw.kind !== undefined) return malformed;
  if (typeof raw.schemaVersion === "number" && Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion !== 1) {
    return unavailable("unsupported");
  }
  const parsed = memoryReply.safeParse(raw);
  if (!parsed.success) return malformed;
  const { journal } = parsed.data;
  if (journal.sessionId !== durableId) return ownershipChanged;
  return { status: "ok", totalSteps: journal.totalSteps, reflectedSteps: journal.reflectedSteps };
}

export type RuntimeReadScope = {
  readonly engine: Engine;
  readonly target: NativeRuntimeBinding;
  readonly isCurrent: () => boolean;
  readonly verifyWorkspace: () => Promise<unknown>;
};

async function sameBinding({ engine, target, isCurrent, verifyWorkspace }: RuntimeReadScope): Promise<Failure | undefined> {
  if (!isCurrent()) return ownershipChanged;
  await verifyWorkspace();
  if (!isCurrent()) return ownershipChanged;
  let raw: WireObject;
  try {
    raw = await engine.requestExisting("get_state", { sessionId: target.route }, TIMEOUT);
  } catch (error) {
    return isCurrent() ? fault(error) : ownershipChanged;
  }
  if (!isCurrent()) return ownershipChanged;
  const current = binding.safeParse(raw);
  if (!current.success) return malformed;
  if (current.data.archived === true || current.data.sessionId !== target.sessionId ||
    current.data.cwd !== target.cwd || current.data.sessionFile !== target.sessionFile) return ownershipChanged;
  await verifyWorkspace();
  return isCurrent() ? undefined : ownershipChanged;
}

async function withinBinding<T>(scope: RuntimeReadScope, read: () => Promise<T>): Promise<T | Failure> {
  const start = await sameBinding(scope);
  if (start || !scope.isCurrent()) return start ?? ownershipChanged;
  const data = await read();
  const end = await sameBinding(scope);
  return end ?? (scope.isCurrent() ? data : ownershipChanged);
}

export async function readNativeRuntime(scope: RuntimeReadScope): Promise<NativeRuntimeSummary> {
  const { target } = scope;
  const result = await withinBinding(scope, async () => {
    const [tasks, list, memory] = await Promise.all([
      readExtension(scope, { name: "omo.task.list", data: { parent_session_id: target.sessionId } },
        raw => projectTasks(raw, target.sessionId)),
      readDagList(scope),
      readExtension(scope, { name: "omo.memory.status", data: {} }, raw => projectMemory(raw, target.sessionId)),
    ]);
    const dag: NativeRuntimeSummary["dag"] = "status" in list ? list : list.runs.length === 0 ? empty : {
      status: "ok", limitReached: list.runs.length === RUNTIME_LIST_LIMIT,
      rows: list.runs.map(row => projectDagRow(row, target.dagKey)),
    };
    return { tasks, dag, memory };
  });
  return "status" in result ? all(result) : result;
}

type ExtensionRead = { readonly name: "omo.task.list" | "omo.dag.list" | "omo.memory.status" | "omo.dag.snapshot";
  readonly data: WireObject };

async function readExtension<T>(scope: RuntimeReadScope, request: ExtensionRead,
  project: (raw: WireObject) => T): Promise<T | Failure> {
  let raw: WireObject;
  try {
    raw = await scope.engine.requestExisting("extension_request", { sessionId: scope.target.route, ...request }, TIMEOUT);
  } catch (error) {
    return fault(error, request.name);
  }
  return project(raw);
}

const readDagList = (scope: RuntimeReadScope) => readExtension(
  scope, { name: "omo.dag.list", data: { limit: RUNTIME_LIST_LIMIT } }, raw => readDagRows(raw, scope.target.sessionId));
const notFound = { status: "not_found" } as const;

export async function readNativeDag(scope: RuntimeReadScope | RuntimeInactiveReason, key: string) {
  if (typeof scope === "string") return unavailable(scope);
  return withinBinding(scope, async () => {
    const list = await readDagList(scope);
    if ("status" in list) return list;
    const runId = list.runs.find(row => row.runId !== undefined && scope.target.dagKey(row.runId) === key)?.runId;
    if (runId === undefined) return notFound;
    const guard = await sameBinding(scope);
    if (guard || !scope.isCurrent()) return guard ?? ownershipChanged;
    return readExtension(scope, { name: "omo.dag.snapshot", data: { runId } }, raw => {
      if (raw.ok === false) {
        const error = z.object({ code: z.string() }).safeParse(raw.error);
        if (!error.success) return malformed;
        switch (error.data.code) {
          case "run_not_found":
          case "run_not_owned": return notFound;
          case "history_unavailable": return unavailable("native_unavailable");
          default: return malformed;
        }
      }
      return projectDagSnapshot(raw, { runId, owner: scope.target.sessionId });
    });
  });
}

type WorkbenchStatus = Empty | { readonly status: "unavailable";
  readonly reason: UnavailableReason | "ownership_changed" | "malformed" | "incomplete" } |
  { readonly status: "ok"; readonly currentTodo?: string; readonly pendingTodo: number };

export async function readWorkbenchStatus(scope: RuntimeReadScope | RuntimeInactiveReason): Promise<WorkbenchStatus> {
  if (typeof scope === "string") return { status: "unavailable", reason: scope };
  const result = await withinBinding(scope, async () => {
    let tree: WireObject;
    try {
      tree = await scope.engine.requestExisting("get_tree", { sessionId: scope.target.route }, TIMEOUT);
    } catch (error) {
      return fault(error);
    }
    const view = projectRuntimeBranch(tree);
    if (view.status === "invalid") return malformed;
    if (view.incomplete) return { status: "unavailable", reason: "incomplete" } as const;
    if (view.todo.status === "none") return empty;
    const tasks = view.todo.phases.flatMap(phase => phase.tasks);
    const current = tasks.find(task => task.status === "in_progress");
    return { status: "ok", pendingTodo: tasks.filter(task => task.status === "pending").length,
      ...(current === undefined ? {} : { currentTodo: current.content }) } as const;
  });
  return result.status === "malformed" || result.status === "ownership_changed"
    ? { status: "unavailable", reason: result.status } : result;
}
