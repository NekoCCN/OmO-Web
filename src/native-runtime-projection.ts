import { z } from "zod";

export const identity = z.string().min(1).max(256).regex(/\S/u);
export const count = z.int().nonnegative();
export const timestamp = z.iso.datetime().transform(Date.parse).pipe(z.int());
export const RUNTIME_LIST_LIMIT = 256;
export const boundedRows = <T extends z.ZodType>(row: T, limit = RUNTIME_LIST_LIMIT) =>
  z.preprocess(value => Array.isArray(value) && value.length <= limit ? value : undefined, z.array(row));

// Native titles are free-form and never projected. Routing metadata is restricted
// to canonical built-in names and the two native execution modes.
const agent = z.enum(["explore", "librarian", "delivery-worker", "technical-writing", "quick-scan"]);
const category = z.enum(["quick", "deep-low", "deep-high", "writing", "visual-engineering",
  "unspecified-low", "unspecified-high", "architect", "artistry", "ultrabrain"]);
const executionMode = z.enum(["in-process", "process"]);
export const taskDisplayFields = {
  agent_type: agent.optional().catch(undefined),
  category: category.optional().catch(undefined),
  execution_mode: executionMode.optional().catch(undefined),
};

const runId = z.templateLiteral(["dag_", z.uuidv4()]);
const dagStatus = z.enum(["pending", "running", "paused", "completed", "failed", "cancelled"]);
const nodeState = z.enum(["pending", "blocked", "scheduled", "running", "paused", "completed", "failed", "cancelled", "skipped"]);
const optionalCount = count.optional().catch(undefined);
const dagRow = z.object({
  runId: runId.optional().catch(undefined),
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
  return { status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, nodeCount: total,
    ...(entries.length === 0 ? {} : { counts: Object.fromEntries(entries) }),
    ...(row.runId === undefined ? {} : { key: keyForRun(row.runId) }) };
}

const MAX_NODES = 64;
const MAX_EDGES = MAX_NODES * (MAX_NODES - 1) / 2;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const metadata = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agent: agent.optional().catch(undefined) }),
  z.object({ kind: z.literal("category"), category: category.optional().catch(undefined) }),
]).optional().catch(undefined);
const snapshot = z.object({ ok: z.literal(true), value: z.object({
  schemaVersion: z.literal(1), runId, parentSessionId: identity, status: dagStatus,
  counts: z.object({ total: count }),
  nodes: boundedRows(z.object({ id: identity, state: nodeState, attempt: count,
    dependsOn: boundedRows(identity, MAX_NODES - 1),
    route: metadata,
  }), MAX_NODES),
  edges: boundedRows(z.object({ from: identity, to: identity }), MAX_EDGES),
  waves: boundedRows(z.object({ index: count, nodeIds: boundedRows(identity, MAX_NODES) }), MAX_NODES),
}) });

const malformed = { status: "malformed" } as const;
const ownershipChanged = { status: "ownership_changed" } as const;

export function projectDagSnapshot(raw: unknown, expected: { readonly runId: string; readonly owner: string }) {
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
      ...(node.route?.kind === "agent" && node.route.agent !== undefined ? { agent: node.route.agent } : {}),
      ...(node.route?.kind === "category" && node.route.category !== undefined ? { category: node.route.category } : {}),
    });
  }
  return { status: "ok", runStatus: graph.status, waves, nodes } as const;
}
