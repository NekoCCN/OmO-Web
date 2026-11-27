import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { WebError } from "../src/protocol.ts";
import type { WireObject } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./engine-stdio-frame-fixture.ts", import.meta.url));

describe("private stdio frame limits", () => {
  let engine: Engine;
  let events: WireObject[];
  let online: boolean[];

  beforeEach(async () => {
    events = [];
    online = [];
    engine = new Engine([process.execPath, "--no-env-file", fixture], tmpdir(),
      event => events.push(event), status => online.push(status.online), undefined, { privateHost: true });
    await engine.probe();
  });
  afterEach(async () => { await engine.stop(); });

  test("rejects just the oversized Native reply and drains through its newline", async () => {
    const tree = engine.requestExisting("get_tree").catch((error: unknown) => error);
    const state = engine.requestExisting("get_state").catch((error: unknown) => error);
    // The fixture holds the newline until the oversized request fails.
    const failure = await tree;
    expect(failure).toBeInstanceOf(WebError);
    expect(failure).toMatchObject({ status: 502, code: "engine_frame_too_large" });
    if (failure instanceof WebError) expect(failure.message).toContain("本次");

    await engine.requestExisting("finish_tree");
    expect(await state).toEqual({ state: "unchanged" });
    expect(await engine.requestExisting("finish_event")).toEqual({ next: true });
    expect(events).toEqual([{ type: "fixture_event", label: "树" }]);
    expect(online).toEqual([true]);
  });

  test("drains a late oversized reply for an issued but timed-out id", async () => {
    // No reply can start until this await has observed the timeout and sends the gate.
    await expect(engine.requestExisting("hold_late", {}, 20)).rejects.toMatchObject({ code: "engine_timeout" });
    expect(await engine.requestExisting("release_late")).toEqual({ afterLateReply: true });
    expect(online).toEqual([true]);
  });

  test("accepts exactly 48 Mi UTF-16 units, including trailing CR", async () => {
    expect(await engine.requestExisting("at_cap")).toEqual({ exact: true });
    expect(online).toEqual([true]);
  });

  test.each([
    ["window", undefined], ["limit", "messages_read_limit"],
    ["malformed", "messages_frame_malformed"], ["foreign", "messages_frame_malformed"],
    ["wrong-route", "messages_frame_malformed"], ["invalid-utf8", "messages_frame_malformed"],
  ])("isolates %s transcript frames and keeps the second route writable once", async (mode, code) => {
    const history = engine.requestExisting("get_messages", { sessionId: "first", mode }).catch((error: unknown) => error);
    const other = engine.requestExisting("read_other_session", { sessionId: "second" });
    if (code) expect(await history).toMatchObject({ code });
    else expect(await history).toEqual({
      historyTruncated: true, messages: [{ role: "user", content: "最近 💡", timestamp: 52 }],
    });
    expect(await other).toEqual({ state: "second unchanged", writes: 0 });
    expect(await engine.requestExisting("prompt", { sessionId: "second", message: "synthetic write" }))
      .toEqual({ writes: 1, sessionId: "second" });
    expect(events).toEqual([{ type: "fixture_event", label: "drained" }]);
    expect(online).toEqual([true]);
  });

  test("does not stream a history-shaped reply for another operation or an already timed-out history read", async () => {
    const staged: WireObject[] = [];
    const stage = (row: WireObject) => { staged.push(row); };
    await expect(engine.requestExisting("ordinary_with_history_shape", {}, undefined, stage))
      .rejects.toMatchObject({ code: "engine_frame_too_large" });
    await expect(engine.requestExisting("get_messages", { sessionId: "first", mode: "late" }, 20, stage))
      .rejects.toMatchObject({ code: "engine_timeout" });
    expect(await engine.requestExisting("read_other_session", { sessionId: "second" }))
      .toEqual({ state: "second unchanged", writes: 0 });
    expect(events).toEqual([{ type: "fixture_event", label: "drained" }]);
    expect(online).toEqual([true]);
    expect(staged).toEqual([]);
  });

  test("captures early visible rows in three 54 MiB replies before the fixture sends the rest", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let signalEarly = () => {};
      const early = new Promise<void>(resolve => { signalEarly = resolve; });
      const staged: unknown[] = [];
      const history = engine.requestExisting("get_messages", { sessionId: "first", mode: "capture" }, 2500, row => {
        staged.push([row.timestamp, typeof row.content === "string" ?
          (row.content.length < 100 ? row.content : row.content.length) : undefined]);
        signalEarly();
      });
      await Promise.race([early, history]);
      expect(staged).toEqual([[-1, "early 💡"]]);
      const following = engine.requestExisting("finish_capture");
      const data = await history;
      // Provisional rows become usable only after the successful receipt.
      expect(staged).toEqual([[-1, "early 💡"], ...Array.from({ length: 39 }, (_, i) => [i, 1_310_720]), [52, "最近 💡"]]);
      expect(data).toMatchObject({ historyOmitted: true, historyTruncated: true });
      expect(data.messages).toHaveLength(4);
      expect(data.messages).not.toContainEqual({ role: "user", content: "early 💡", timestamp: -1 });
      expect(await following).toEqual({ afterCapture: true });
    }
    expect(online).toEqual([true]);
  }, 15_000);

  test.each([
    ["capture-eviction", Array.from({ length: 245 }, (_, i) => i), 240],
    ["capture-old-order", ["legacy"], 1],
    ["capture-compat", [], 1],
  ])("returns the existing recent window for %s without claiming omission", async (mode, captured, count) => {
    const staged: unknown[] = [];
    const history = engine.requestExisting("get_messages", { sessionId: "first", mode }, undefined, row => {
      staged.push(row.timestamp ?? row.content);
    });
    const following = engine.requestExisting("read_other_session", { sessionId: "second" });
    const data = await history;
    expect(await following).toEqual({ state: "second unchanged", writes: 0 });
    expect(staged).toEqual(captured);
    expect(data.messages).toHaveLength(count);
    expect(data).not.toHaveProperty("historyOmitted");
    expect(data.historyTruncated).toBe(mode === "capture-eviction");
  });

  test.each([
    ["capture-wrong-route", "messages_frame_malformed"],
    ["capture-duplicate", "messages_frame_malformed"],
    ["capture-refusal", "engine_refused"],
  ])("does not commit staged rows when the rest of %s rejects the receipt", async (mode, code) => {
    const staged: WireObject[] = [];
    let stagedBeforeRejection = 0;
    const committed: WireObject[] = [];
    const receipt = engine.requestExisting("get_messages", { sessionId: "first", mode }, undefined, row => { staged.push(row); })
      .then(() => { committed.push(...staged); }, (error: unknown) => {
        stagedBeforeRejection = staged.length;
        staged.length = 0;
        throw error;
      });
    const following = engine.requestExisting("read_other_session", { sessionId: "second" });
    await expect(receipt).rejects.toMatchObject({ code });
    expect(stagedBeforeRejection).toBe(1);
    expect(committed).toEqual([]);
    expect(await following).toEqual({ state: "second unchanged", writes: 0 });
  });

  test("stops invoking a capture callback once a partially read request times out", async () => {
    const staged: WireObject[] = [];
    const receipt = engine.requestExisting("get_messages", { sessionId: "first", mode: "capture-late" }, 300,
      row => { staged.push(row); });
    await expect(receipt).rejects.toMatchObject({ code: "engine_timeout" });
    expect(staged).toEqual([{ role: "user", content: "early 💡", timestamp: -1 }]);
    staged.length = 0;
    expect(await engine.requestExisting("finish_capture")).toEqual({ afterCapture: true });
    expect(staged).toEqual([]);
    expect(online).toEqual([true]);
  });

  test("rejects a throwing sink without committing or losing the following reply", async () => {
    const history = engine.requestExisting("get_messages", { sessionId: "first", mode: "capture-old-order" }, undefined, () => {
      throw new Error("synthetic sink failure");
    });
    const following = engine.requestExisting("read_other_session", { sessionId: "second" });
    await expect(history).rejects.toMatchObject({ code: "history_capture_failed" });
    expect(await following).toEqual({ state: "second unchanged", writes: 0 });
    expect(online).toEqual([true]);
  });

  test.each(["nested_id", "unissued_id", "malformed"])("fails closed for %s", async type => {
    await expect(engine.requestExisting(type)).rejects.toMatchObject({ status: 503, code: "engine_unavailable" });
    expect(online).toEqual([true, false]);
    expect(events).toEqual([]);
  });
});
