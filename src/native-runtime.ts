import { z } from "zod";
import type { Engine } from "./engine.ts";
import { WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const LIMIT = 256;
const TIMEOUT = 6000;
const identity = z.string().min(1).max(256).regex(/\S/u);
const count = z.int().nonnegative();
const timestamp = z.iso.datetime().transform(Date.parse).pipe(z.int());
const taskStatus = z.enum(["pending", "running", "paused", "completed", "error", "cancelled", "interrupted", "lost"]);
const dagStatus = z.enum(["pending", "running", "paused", "completed", "failed", "cancelled"]);
const taskRow = z.object({ status: taskStatus, created_at: timestamp, updated_at: timestamp });
const dagRow = z.object({
  parentSessionId: identity, status: dagStatus, createdAt: timestamp, updatedAt: timestamp,
  counts: z.object({ total: count }),
});
const boundedRows = <T extends z.ZodType>(row: T) =>
  z.preprocess(value => Array.isArray(value) && value.length <= LIMIT ? value : undefined, z.array(row));
const taskReply = z.object({
  parent_session_id: identity, tasks: boundedRows(taskRow), truncated_tasks: count.optional(),
});
const dagReply = z.object({
  ok: z.literal(true), value: z.object({ limit: z.literal(LIMIT), runs: boundedRows(dagRow) }),
});
const memoryReply = z.object({
  schemaVersion: z.literal(1),
  journal: z.object({ sessionId: identity, totalSteps: count, reflectedSteps: count }),
});
const binding = z.object({ sessionId: identity, cwd: z.string().min(1), sessionFile: z.string().min(1) });

export type NativeRuntimeBinding = Readonly<z.infer<typeof binding>> & { readonly route: string };

/** Use the initial native state only when it agrees with the journal Web opened. */
export function bindNativeRuntime(raw: unknown, expected: {
  readonly route: string;
  readonly cwd: string;
  readonly sessionFile: unknown;
  readonly durableId?: string;
}): NativeRuntimeBinding | undefined {
  const state = binding.safeParse(raw);
  if (!state.success || !expected.route || state.data.sessionId === expected.route ||
    state.data.cwd !== expected.cwd || state.data.sessionFile !== expected.sessionFile ||
    (expected.durableId !== undefined && state.data.sessionId !== expected.durableId)) return undefined;
  return { ...state.data, route: expected.route };
}

type UnavailableReason = "inactive" | "binding_unverified" | "unsupported" | "native_unavailable" | "engine_unavailable";
type Failure =
  | { readonly status: "unavailable"; readonly reason: UnavailableReason }
  | { readonly status: "ownership_changed" }
  | { readonly status: "malformed" };
type Empty = { readonly status: "empty" };
type TaskRow = {
  readonly status: z.infer<typeof taskStatus>; readonly createdAt: number; readonly updatedAt: number;
};
type DagRow = {
  readonly status: z.infer<typeof dagStatus>; readonly createdAt: number; readonly updatedAt: number;
  readonly nodeCount: number;
};
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

export function unavailableNativeRuntime(reason: "inactive" | "binding_unverified" | "unsupported"): NativeRuntimeSummary {
  return all(unavailable(reason));
}

function fault(error: unknown, extension?: string): Failure {
  if (!(error instanceof WebError)) throw error;
  if (["unknown_session", "session_not_attached", "missing_session_id"].includes(error.code)) return ownershipChanged;
  if (extension !== undefined && error.message === `Unknown extension RPC request: ${extension}`) return unavailable("unsupported");
  if (["engine_unavailable", "engine_timeout", "bridge_busy"].includes(error.code)) return unavailable("engine_unavailable");
  return unavailable("native_unavailable");
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
  if (truncated_tasks > 0 && tasks.length !== LIMIT) return malformed;
  if (tasks.length === 0) return empty;
  return { status: "ok", omittedCount: truncated_tasks, rows: tasks.map(row => ({
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  })) };
}

function projectDag(raw: WireObject, durableId: string): NativeRuntimeSummary["dag"] {
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
  if (runs.length === 0) return empty;
  return { status: "ok", limitReached: runs.length === LIMIT, rows: runs.map(row => ({
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, nodeCount: row.counts.total,
  })) };
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

export async function readNativeRuntime(engine: Engine, target: NativeRuntimeBinding,
  isCurrent: () => boolean): Promise<NativeRuntimeSummary> {
  const sameBinding = async (): Promise<Failure | undefined> => {
    if (!isCurrent()) return ownershipChanged;
    try {
      const raw = await engine.requestExisting("get_state", { sessionId: target.route }, TIMEOUT);
      if (!isCurrent()) return ownershipChanged;
      const current = binding.safeParse(raw);
      if (!current.success) return malformed;
      if (current.data.sessionId !== target.sessionId || current.data.cwd !== target.cwd ||
        current.data.sessionFile !== target.sessionFile) return ownershipChanged;
      return undefined;
    } catch (error) {
      return isCurrent() ? fault(error) : ownershipChanged;
    }
  };
  const start = await sameBinding();
  if (start) return all(start);
  if (!isCurrent()) return all(ownershipChanged);

  const read = async <T>(name: "omo.task.list" | "omo.dag.list" | "omo.memory.status",
    data: WireObject, project: (raw: WireObject, durableId: string) => T): Promise<T | Failure> => {
    let raw: WireObject;
    try {
      raw = await engine.requestExisting("extension_request", { sessionId: target.route, name, data }, TIMEOUT);
    } catch (error) {
      return fault(error, name);
    }
    return project(raw, target.sessionId);
  };
  const [tasks, dag, memory] = await Promise.all([
    read("omo.task.list", { parent_session_id: target.sessionId }, projectTasks),
    read("omo.dag.list", { limit: LIMIT }, projectDag),
    read("omo.memory.status", {}, projectMemory),
  ]);
  const end = await sameBinding();
  return end ? all(end) : isCurrent() ? { tasks, dag, memory } : all(ownershipChanged);
}
