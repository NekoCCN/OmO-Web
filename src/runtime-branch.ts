export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoTaskView = { readonly content: string; readonly status: TodoStatus };
export type TodoPhaseView = { readonly name: string; readonly tasks: readonly TodoTaskView[] };
export type BranchTodoView =
  | { readonly status: "ok"; readonly phases: readonly TodoPhaseView[] }
  | { readonly status: "none" };
export type BranchGateView = {
  readonly status: "failed" | "skipped";
  readonly consecutiveFailures: number;
  readonly candidateCount: number;
  readonly at?: number;
};
export type BranchUnavailableView = { readonly count: number; readonly at?: number };
export type BranchMemoryView =
  | { readonly status: "none" }
  | {
      readonly status: "ok";
      readonly recalledCount?: number;
      readonly recentRecalledAt?: number;
      readonly gate?: BranchGateView;
      readonly unavailable?: BranchUnavailableView;
    };
export type RuntimeBranchView =
  | { readonly status: "invalid"; readonly reason: "missing-tree" | "invalid-leaf" | "unknown-leaf" | "duplicate-id" | "broken-ancestry" | "tree-budget" }
  | { readonly status: "ok"; readonly leafId: string | null; readonly todo: BranchTodoView; readonly memory: BranchMemoryView; readonly incomplete?: true };

const TODO_STATE_TYPE = "senpi.todo-state";
const TODO_TOOL_NAMES: readonly string[] = ["todo", "todowrite"];
const NUDGED_TYPE = "omo-kibitzer:nudged";
const GATE_TYPE = "omo-kibitzer:gate";
const UNAVAILABLE_TYPE = "omo-kibitzer:unavailable";
const DEFAULT_PHASE_NAME = "Tasks";

const MAX_ID_LENGTH = 200;
const MAX_PHASES = 100;
const MAX_TASKS_PER_PHASE = 500;
const MAX_PHASE_NAME = 200;
const MAX_CONTENT = 2000;
const MAX_ENTRIES = 20000;
const MAX_CHILDREN_PER_NODE = 1000;
const MAX_DEPTH = 1024;
const MAX_CHAIN = 1024;
const MAX_TOTAL_TASKS = 1000;
const MAX_TOTAL_CHARS = 100000;
const MAX_NUDGES_PER_RECORD = 1024;
const MAX_COUNT = 1000000;
const MAX_TIME = 9e15;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ANSI_PATTERN = new RegExp("\x1b\\[[0-9;]*[A-Za-z]", "g");
const CONTROL_PATTERN = new RegExp("[\u0000-\u001f-]+", "g");

type Fields = Record<string, unknown>;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseTime(value: unknown): number | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIME ? Math.floor(ms) : undefined;
}

function parseCount(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_COUNT
    ? value
    : undefined;
}

function parseTodoStatus(value: unknown): TodoStatus | undefined {
  if (value === "cancelled") return "abandoned";
  return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned"
    ? value
    : undefined;
}

function parseTodoItem(value: unknown, lenient: boolean): TodoTaskView | undefined {
  const item = record(value);
  const content = cleanText(item.content, MAX_CONTENT);
  if (content === undefined) return undefined;
  const status = parseTodoStatus(item.status) ?? (lenient ? "pending" : undefined);
  return status === undefined ? undefined : { content, status };
}

type TodoPayload = { readonly phases: TodoPhaseView[]; readonly truncated: boolean };

function parseTodoPhase(value: unknown): { readonly phase: TodoPhaseView; readonly truncated: boolean } | undefined {
  const phase = record(value);
  const name = cleanText(phase.name, MAX_PHASE_NAME);
  if (name === undefined || !Array.isArray(phase.tasks)) return undefined;
  const parsed: TodoTaskView[] = [];
  for (const task of phase.tasks.slice(0, MAX_TASKS_PER_PHASE)) {
    const item = parseTodoItem(task, false);
    if (!item) return undefined;
    parsed.push(item);
  }
  return { phase: { name, tasks: parsed }, truncated: phase.tasks.length > MAX_TASKS_PER_PHASE };
}

function parsePhases(value: unknown): TodoPayload | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: TodoPhaseView[] = [];
  let truncated = value.length > MAX_PHASES;
  for (const phase of value.slice(0, MAX_PHASES)) {
    const item = parseTodoPhase(phase);
    if (!item) return undefined;
    if (item.truncated) truncated = true;
    parsed.push(item.phase);
  }
  return { phases: parsed, truncated };
}

function parseLegacyTodos(value: unknown): TodoPayload | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: TodoTaskView[] = [];
  for (const todo of value.slice(0, MAX_TASKS_PER_PHASE)) {
    const item = parseTodoItem(todo, true);
    if (!item) return undefined;
    tasks.push(item);
  }
  return { phases: [{ name: DEFAULT_PHASE_NAME, tasks }], truncated: value.length > MAX_TASKS_PER_PHASE };
}

function readTodoPayload(data: unknown): TodoPayload | undefined {
  const payload = record(data);
  if (payload.schema === "v2" || Array.isArray(payload.phases)) return parsePhases(payload.phases);
  if (Array.isArray(payload.todos)) return parseLegacyTodos(payload.todos);
  return undefined;
}

function readCustomTodo(entry: Fields): TodoPayload | undefined {
  // Exact native kind only: the broader todo-list / todowrite* family was never verified.
  if (entry.type !== "custom" || entry.customType !== TODO_STATE_TYPE) return undefined;
  return readTodoPayload(entry.data);
}

function readToolTodo(entry: Fields): TodoPayload | undefined {
  if (entry.type !== "message") return undefined;
  const message = record(entry.message);
  if (message.role !== "toolResult" || !TODO_TOOL_NAMES.includes(message.toolName as string)) return undefined;
  return readTodoPayload(message.details);
}

function isNudgedRecord(data: Fields): boolean {
  const nudges = array(data.nudges);
  if (data.version !== 1 || nudges.length === 0 || nudges.length > MAX_NUDGES_PER_RECORD) return false;
  return nudges.every(nudge => {
    const item = record(nudge);
    return cleanText(item.path, MAX_CONTENT) !== undefined && cleanText(item.hint, MAX_CONTENT) !== undefined;
  });
}

function readGate(data: Fields): Omit<BranchGateView, "at"> | undefined {
  if (data.version !== 1 || (data.status !== "failed" && data.status !== "skipped")) return undefined;
  const consecutiveFailures = parseCount(data.consecutiveFailures, 1);
  const candidateCount = parseCount(data.candidateCount, 0);
  if (consecutiveFailures === undefined || candidateCount === undefined) return undefined;
  return { status: data.status, consecutiveFailures, candidateCount };
}

function readUnavailable(data: Fields): boolean {
  return data.version === 1 && (data.cause === "category_unavailable" || data.cause === "beyond_category");
}

type IndexedEntry = { readonly entry: Fields; readonly structuralParent: string | null };

function indexEntries(nodes: readonly unknown[]): {
  readonly byId: Map<string, IndexedEntry>;
  readonly duplicates: Set<string>;
  readonly incomplete: boolean;
} {
  const byId = new Map<string, IndexedEntry>();
  const duplicates = new Set<string>();
  let incomplete = false;
  const stack: Array<{ node: unknown; structuralParent: string | null; depth: number }> = [];
  // Bound the root push too: an unbounded top-level array could grow the stack
  // without limit, and any skipped root could hide a duplicate id. Fail closed
  // downstream via incomplete -> tree-budget.
  if (nodes.length > MAX_ENTRIES) incomplete = true;
  const takeRoots = Math.min(nodes.length, MAX_ENTRIES);
  for (let i = takeRoots - 1; i >= 0; i -= 1) {
    stack.push({ node: nodes[i], structuralParent: null, depth: 0 });
  }
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_ENTRIES) {
      incomplete = true;
      break;
    }
    const frame = stack.pop();
    if (!frame) break;
    visited += 1;
    const node = record(frame.node);
    const entry = record(node.entry);
    // Native envelope only: entries index by entry.id; node-level id fallbacks are ignored.
    const id = entry.id;
    const structuralParent = isValidId(id) ? (id as string) : "";
    if (isValidId(id)) {
      if (byId.has(id)) duplicates.add(id);
      else byId.set(id, { entry, structuralParent: frame.structuralParent });
    }
    if (frame.depth >= MAX_DEPTH) {
      incomplete = true;
      continue;
    }
    const children = array(node.children);
    if (children.length > MAX_CHILDREN_PER_NODE) incomplete = true;
    const take = Math.min(children.length, MAX_CHILDREN_PER_NODE);
    for (let i = take - 1; i >= 0; i -= 1) {
      if (stack.length >= MAX_ENTRIES) {
        incomplete = true;
        break;
      }
      stack.push({ node: children[i], structuralParent, depth: frame.depth + 1 });
    }
  }
  return { byId, duplicates, incomplete };
}

function branchChain(
  byId: Map<string, IndexedEntry>,
  duplicates: Set<string>,
  leafId: string,
): { readonly chain: Fields[] } | { readonly invalid: "duplicate-id" | "broken-ancestry" } {
  // Fail closed: every link on the selected ancestry must exist exactly once and its
  // parentId pointer must agree with the structural nesting. A dangling pointer, an
  // invalid parent, a cycle, or a pointer crossing into a sibling branch all imply a
  // structural mismatch, so the view is invalid instead of mixing sibling data.
  const chain: Fields[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current !== null) {
    if (chain.length >= MAX_CHAIN) return { invalid: "broken-ancestry" };
    if (seen.has(current)) return { invalid: "broken-ancestry" };
    const indexed = byId.get(current);
    if (!indexed) return { invalid: "broken-ancestry" };
    if (duplicates.has(current)) return { invalid: "duplicate-id" };
    seen.add(current);
    chain.push(indexed.entry);
    const parentId: unknown = indexed.entry.parentId;
    if (parentId === null) {
      if (indexed.structuralParent !== null) return { invalid: "broken-ancestry" };
      current = null;
    } else if (typeof parentId === "string" && isValidId(parentId)) {
      if (parentId !== indexed.structuralParent) return { invalid: "broken-ancestry" };
      current = parentId;
    } else {
      return { invalid: "broken-ancestry" };
    }
  }
  return { chain: chain.reverse() };
}

function capTodo(phases: TodoPhaseView[]): { phases: TodoPhaseView[]; truncated: boolean } {
  // Global output budget: 100 phases x 500 tasks x 2000 chars could reach ~100 MB.
  // Cap total tasks and total text; the caller marks the view incomplete when capped.
  const kept: TodoPhaseView[] = [];
  let tasks = 0;
  let chars = 0;
  for (const phase of phases) {
    if (tasks >= MAX_TOTAL_TASKS || chars >= MAX_TOTAL_CHARS) return { phases: kept, truncated: true };
    const keptTasks: TodoTaskView[] = [];
    for (const task of phase.tasks) {
      if (tasks >= MAX_TOTAL_TASKS || chars + task.content.length > MAX_TOTAL_CHARS) break;
      keptTasks.push(task);
      tasks += 1;
      chars += task.content.length;
    }
    kept.push({ name: phase.name, tasks: keptTasks });
    if (keptTasks.length < phase.tasks.length) return { phases: kept, truncated: true };
  }
  return { phases: kept, truncated: false };
}

export function projectRuntimeBranch(tree: unknown): RuntimeBranchView {
  const root = record(tree);
  if (!Array.isArray(root.tree)) return { status: "invalid", reason: "missing-tree" };
  // Native { tree: [], leafId: null } is a valid empty selection, not an error.
  if (root.leafId === null) {
    if (root.tree.length === 0) {
      return { status: "ok", leafId: null, todo: { status: "none" }, memory: { status: "none" } };
    }
    return { status: "invalid", reason: "invalid-leaf" };
  }
  if (!isValidId(root.leafId)) {
    return { status: "invalid", reason: "invalid-leaf" };
  }
  const leafId: string = root.leafId;
  const indexed = indexEntries(root.tree);
  // Structural caps (children per node, depth, total entries, roots) mean the index
  // may have skipped a subtree that hides a duplicate id or the true ancestry.
  // Fail closed before touching any indexed field; Todo payload truncation stays
  // an incomplete ok view and is handled independently below.
  if (indexed.incomplete) return { status: "invalid", reason: "tree-budget" };
  if (!indexed.byId.has(leafId)) return { status: "invalid", reason: "unknown-leaf" };
  if (indexed.duplicates.has(leafId)) return { status: "invalid", reason: "duplicate-id" };
  const resolved = branchChain(indexed.byId, indexed.duplicates, leafId);
  if ("invalid" in resolved) return { status: "invalid", reason: resolved.invalid };

  let phases: TodoPhaseView[] | undefined;
  // Structural incomplete already returned as tree-budget above; this flag now
  // tracks only Todo payload truncation (sliced phases / global output budget),
  // which stays an incomplete ok view.
  let incomplete = false;
  let recalled = 0;
  let recentRecalledAt: number | undefined;
  let gate: BranchGateView | undefined;
  let unavailableCount = 0;
  let unavailableAt: number | undefined;

  for (const entry of resolved.chain) {
    const todo = readCustomTodo(entry) ?? readToolTodo(entry);
    if (todo) {
      phases = todo.phases;
      if (todo.truncated) incomplete = true;
    }
    if (entry.type !== "custom" || typeof entry.customType !== "string") continue;
    const data = record(entry.data);
    const at = parseTime(entry.timestamp);
    if (entry.customType === NUDGED_TYPE && isNudgedRecord(data)) {
      recalled = Math.min(MAX_COUNT, recalled + array(data.nudges).length);
      if (at !== undefined && (recentRecalledAt === undefined || at > recentRecalledAt)) recentRecalledAt = at;
    } else if (entry.customType === GATE_TYPE) {
      const parsed = readGate(data);
      if (parsed) gate = at === undefined ? parsed : { ...parsed, at };
    } else if (entry.customType === UNAVAILABLE_TYPE && readUnavailable(data)) {
      unavailableCount = Math.min(MAX_COUNT, unavailableCount + 1);
      if (at !== undefined && (unavailableAt === undefined || at > unavailableAt)) unavailableAt = at;
    }
  }

  if (phases) {
    const capped = capTodo(phases);
    phases = capped.phases;
    if (capped.truncated) incomplete = true;
  }

  const todo: BranchTodoView = phases ? { status: "ok", phases } : { status: "none" };
  const hasMemory = recalled > 0 || gate !== undefined || unavailableCount > 0;
  const memory: BranchMemoryView = !hasMemory
    ? { status: "none" }
    : {
        status: "ok",
        ...(recalled > 0
          ? { recalledCount: recalled, ...(recentRecalledAt === undefined ? {} : { recentRecalledAt }) }
          : {}),
        ...(gate ? { gate } : {}),
        ...(unavailableCount > 0
          ? { unavailable: { count: unavailableCount, ...(unavailableAt === undefined ? {} : { at: unavailableAt }) } }
          : {}),
      };
  return { status: "ok", leafId, todo, memory, ...(incomplete ? { incomplete: true as const } : {}) };
}

export function projectPagedRuntimeBranch(entries: readonly {
  readonly id: string; readonly parentId: string | null; readonly raw: Fields;
}[], leafId: string | null): RuntimeBranchView {
  type Node = { readonly entry: Fields; readonly children: Node[] };
  const nodes = new Map<string, Node>();
  for (const { id, raw } of entries) {
    if (nodes.has(id)) return { status: "invalid", reason: "duplicate-id" };
    nodes.set(id, { entry: raw, children: [] });
  }
  const roots: Node[] = [];
  // Use the effective Native parent pointers, never append order or label.targetId.
  // Build only after all pages were received, since a parent can live outside its page.
  for (const { id, parentId } of entries) {
    const children = parentId === null ? roots : nodes.get(parentId)?.children;
    const node = nodes.get(id);
    if (!children || !node) return { status: "invalid", reason: "broken-ancestry" };
    children.push(node);
  }
  const reachable = [...roots];
  for (const node of reachable) reachable.push(...node.children);
  if (reachable.length !== nodes.size) return { status: "invalid", reason: "broken-ancestry" };
  // A root selection can have older disconnected history; it has no active ancestry.
  return projectRuntimeBranch({ tree: leafId === null ? [] : roots, leafId });
}
