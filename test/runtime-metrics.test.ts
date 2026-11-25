import { describe, expect, test } from "bun:test";
import { projectCacheRates, projectContextUsage, projectSessionMemory } from "../src/runtime-metrics.ts";

describe("projectContextUsage", () => {
  test("reports tokens, window and percent when present", () => {
    expect(projectContextUsage({ tokens: 1200, contextWindow: 200000, percent: 0.6 })).toEqual({
      status: "ok",
      tokens: 1200,
      window: 200000,
      percent: 0.6,
    });
  });

  test("missing signals stay unavailable instead of zero", () => {
    expect(projectContextUsage({})).toEqual({ status: "unavailable", reason: "no-data" });
    expect(projectContextUsage(undefined)).toEqual({ status: "unavailable", reason: "no-data" });
  });
});

describe("projectCacheRates", () => {
  test("prefers native latest and names the cumulative ratio", () => {
    const view = projectCacheRates({ latestCacheHitRate: 64, input: 100, cacheWrite: 100, cacheRead: 300 });
    expect(view.status).toBe("ok");
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.latest).toBeCloseTo(0.64);
    expect(view.cumulative).toBeCloseTo(300 / 500);
  });

  test("zero denominator is unavailable, not zero percent", () => {
    const view = projectCacheRates({ input: 0, cacheWrite: 0, cacheRead: 0 });
    expect(view).toEqual({ status: "unavailable", reason: "no-data" });
  });

  test("unreported totals stay unavailable", () => {
    expect(projectCacheRates({})).toEqual({ status: "unavailable", reason: "no-data" });
  });

  test("zero without cache evidence is unknown; a known cache miss is zero", () => {
    expect(projectCacheRates({ latestCacheHitRate: 0, input: 20, cacheRead: 0, cacheWrite: 0 }))
      .toEqual({ status: "unavailable", reason: "no-data" });
    expect(projectCacheRates({ latestCacheHitRate: 0, input: 20, cacheRead: 0, cacheWrite: 10 }))
      .toEqual({ status: "ok", latest: 0, cumulative: 0 });
  });
});

describe("projectSessionMemory", () => {
  const row = (memory: unknown) => ({
    sessions: [{ sessionId: "route-1", memory }],
  });

  test("reads exact per-route fields", () => {
    expect(projectSessionMemory(row({ main_heap_bytes: 10, kernel_heap_bytes: 5, kernel_count: 2 }), "route-1")).toEqual({
      status: "ok",
      mainHeapBytes: 10,
      kernelHeapBytes: 5,
      kernelCount: 2,
    });
  });

  test("unknown route and missing fields stay unavailable", () => {
    expect(projectSessionMemory(row({ main_heap_bytes: 1 }), "other")).toEqual({
      status: "unavailable",
      reason: "no-data",
    });
    expect(projectSessionMemory({ sessions: [{ sessionId: "route-1" }] }, "route-1")).toEqual({
      status: "unavailable",
      reason: "no-data",
    });
    expect(projectSessionMemory(undefined, "route-1")).toEqual({ status: "unavailable", reason: "no-data" });
  });

  test("a durable-ID alias isn't the requested runtime route", () => {
    const listing = { sessions: [
      { sessionId: "other-route", durableSessionId: "route-1", memory: { kernel_count: 4 } },
      { sessionId: "route-1", memory: { kernel_count: 0 } },
    ] };
    expect(projectSessionMemory(listing, "route-1")).toEqual({ status: "ok", kernelCount: 0 });
  });
});
