// Pure projection of native usage/memory signals into labeled UI views.
// Zero dependencies. Bounded and read-only: unknown or absent signals stay
// explicitly unavailable and are never fabricated into zeros.

export type ContextView =
  | { readonly status: "ok"; readonly tokens?: number; readonly window?: number; readonly percent?: number }
  | { readonly status: "unavailable"; readonly reason: "no-data" };

export type CacheView =
  | { readonly status: "ok"; readonly latest?: number; readonly cumulative?: number }
  | { readonly status: "unavailable"; readonly reason: "no-data" };

export type SessionMemoryView =
  | {
      readonly status: "ok";
      readonly mainHeapBytes?: number;
      readonly kernelHeapBytes?: number;
      readonly kernelCount?: number;
    }
  | { readonly status: "unavailable"; readonly reason: "no-data" };

type Fields = Record<string, unknown>;

const MAX_BYTES = 1e15;
const MAX_COUNT = 1_000_000;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = finite(value);
  return n === undefined || n < 0 ? undefined : n;
}

/** Native `contextUsage` ({ tokens, contextWindow/window, percent }): all fields optional. */
export function projectContextUsage(value: unknown): ContextView {
  const raw = record(value);
  const tokens = nonNegative(raw.tokens);
  const window = nonNegative(raw.contextWindow ?? raw.window ?? raw.context_window);
  const percent = nonNegative(raw.percent ?? raw.percentUsed ?? raw.usagePercent);
  if (tokens === undefined && window === undefined && percent === undefined) {
    return { status: "unavailable", reason: "no-data" };
  }
  return {
    status: "ok",
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined ? {} : { window }),
    ...(percent === undefined ? {} : { percent }),
  };
}

/**
 * Native `usageTotals.latestCacheHitRate` is a percentage, not a ratio.
 * the cumulative ratio is always named as such and computed as
 * cacheRead / (input + cacheWrite + cacheRead). A zero denominator or any
 * missing component leaves that side unavailable instead of a fake 0%.
 */
export function projectCacheRates(value: unknown): CacheView {
  const raw = record(value);
  const latestRaw = finite(raw.latestCacheHitRate);
  const input = nonNegative(raw.input);
  const cacheRead = nonNegative(raw.cacheRead);
  const cacheWrite = nonNegative(raw.cacheWrite);
  // OmO reports 0 even on providers without cache activity; a known
  // cache hit or write is needed to distinguish that from a measured miss.
  const hasCacheEvidence = (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0 || (latestRaw ?? 0) > 0;
  if (!hasCacheEvidence) return { status: "unavailable", reason: "no-data" };
  const latest = latestRaw === undefined || latestRaw < 0 || latestRaw > 100 ? undefined : latestRaw / 100;
  let cumulative: number | undefined;
  if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
    const denominator = input + cacheWrite + cacheRead;
    if (denominator > 0 && Number.isFinite(denominator)) cumulative = cacheRead / denominator;
  }
  if (latest === undefined && cumulative === undefined) return { status: "unavailable", reason: "no-data" };
  return {
    status: "ok",
    ...(latest === undefined ? {} : { latest }),
    ...(cumulative === undefined ? {} : { cumulative }),
  };
}

function pickMemoryFields(raw: Fields): { main?: number; kernel?: number; count?: number } {
  const nested = record(raw.memory);
  const mainRaw = nonNegative(nested.main_heap_bytes ?? raw.main_heap_bytes);
  const kernelRaw = nonNegative(nested.kernel_heap_bytes ?? raw.kernel_heap_bytes);
  const countRaw = raw.kernel_count ?? nested.kernel_count;
  const main = mainRaw === undefined || mainRaw > MAX_BYTES ? undefined : mainRaw;
  const kernel = kernelRaw === undefined || kernelRaw > MAX_BYTES ? undefined : kernelRaw;
  const count =
    typeof countRaw === "number" && Number.isInteger(countRaw) && countRaw >= 0 && countRaw <= MAX_COUNT
      ? countRaw
      : undefined;
  return { main, kernel, count };
}

/**
 * Exact per-route `list_sessions` memory fields. `main_heap_bytes` comes from
 * the OmO host main heap and may repeat across rows, so the UI must name it
 * host-wide; kernel values are session-scoped. Never falls back to Web
 * process memory.
 */
export function projectSessionMemory(listing: unknown, route: string): SessionMemoryView {
  if (typeof route !== "string" || !route) return { status: "unavailable", reason: "no-data" };
  const root = record(listing);
  const rows = Array.isArray(root.sessions) ? root.sessions : [];
  const match = rows.map(record).find(row => row.sessionId === route);
  if (!match) return { status: "unavailable", reason: "no-data" };
  const { main, kernel, count } = pickMemoryFields(match);
  if (main === undefined && kernel === undefined && count === undefined) {
    return { status: "unavailable", reason: "no-data" };
  }
  return {
    status: "ok",
    ...(main === undefined ? {} : { mainHeapBytes: main }),
    ...(kernel === undefined ? {} : { kernelHeapBytes: kernel }),
    ...(count === undefined ? {} : { kernelCount: count }),
  };
}
