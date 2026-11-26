import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { Sessions } from "../src/sessions.ts";
import type { WireObject } from "../src/protocol.ts";

class FixtureEngine extends Engine {
  #next = 0;

  override async probe() {}

  override async request(type: string) {
    if (type !== "open_session") throw new Error(`unexpected RPC: ${type}`);
    return { sessionId: `route-${++this.#next}`, permissionPreset: "ask", permissionPresetStatus: "applied" };
  }

  override async requestExisting(type: string) {
    return type === "get_state" ? { thinkingLevel: "high", thinkingLevelSource: "explicit", usageTotals: { output: 123_456 } } : {};
  }
}

test("speed projects only the latest completed, measurable stream on the same live binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-runtime-speed-"));
  const clock = spyOn(performance, "now");
  try {
    const events: WireObject[] = [];
    const sessions = new Sessions(root, [root], new FixtureEngine(["unused"], root, () => {}, () => {}), event => events.push(event));
    await sessions.load();
    const a = await sessions.create(root), b = await sessions.create(root);
    const message = { role: "assistant", timestamp: 123, content: [{ type: "text", text: "some output" }] };
    const frame = (sessionId: string, type: string, more: WireObject = {}) => sessions.event({ type, sessionId, message, ...more });
    const start = (route: string) => frame(route, "message_start", { streaming: true });
    const delta = (route: string, ms: number, compacted = false, type = "text_delta") => {
      clock.mockReturnValue(ms);
      frame(route, "message_update", { ...(compacted ? { message: null } : {}),
        assistantMessageEvent: { type, contentIndex: 0, delta: "x", partial: compacted ? null : message } });
    };
    const end = (route: string, stopReason = "stop", usage: WireObject = { output: 30 }, override: WireObject = {}) =>
      frame(route, "message_end", { message: { ...message, stopReason, usage, ...override } });
    const aRoute = "route-1", bRoute = "route-2";
    const speeds = () => events.filter(event => event.type === "generation_speed");
    const assertUnmeasured = async () => {
      expect(await sessions.snapshot(a.id)).not.toHaveProperty("generationSpeed");
      expect(speeds()).toHaveLength(0);
    };
    await assertUnmeasured();
    for (const mode of ["no-start", "nonstream-start", "one", "short", "non-delta", "empty-delta", "compacted", "compaction",
      "aborted", "error", "no-output", "hidden-reasoning", "hidden-block", "different-message"]) {
      if (mode === "nonstream-start") frame(aRoute, "message_start");
      else if (mode !== "no-start") start(aRoute);
      delta(aRoute, 1000);
      if (mode === "compaction") frame(aRoute, "compaction_start");
      if (mode === "empty-delta") {
        clock.mockReturnValue(1600);
        frame(aRoute, "message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: message } });
      } else if (mode !== "one") {
        delta(aRoute, mode === "short" ? 1499 : 1600, mode === "compacted", mode === "non-delta" ? "text_end" : "text_delta");
      }
      end(aRoute, ["aborted", "error"].includes(mode) ? mode : "stop",
        mode === "no-output" ? {} : mode === "hidden-reasoning" ? { output: 30, reasoning: 10 } : { output: 30 },
        mode === "different-message" ? { timestamp: 124 } : mode === "hidden-block" ?
          { content: [{ type: "thinking", thinking: "", redacted: true }, ...message.content] } : {});
      if (mode === "compaction") frame(aRoute, "compaction_end");
      await assertUnmeasured();
    }
    start(aRoute);
    delta(aRoute, 3000);
    delta(bRoute, 3300);
    delta(aRoute, 3600);
    end(bRoute);
    end(aRoute);
    const first = { tokensPerSecond: 50, measuredAt: expect.any(Number) };
    expect(speeds()).toEqual([{ type: "generation_speed", sessionId: a.id, generationSpeed: first }]);
    const snapshot = await sessions.snapshot(a.id);
    expect(snapshot).toHaveProperty("generationSpeed", first);
    expect(snapshot.state).not.toHaveProperty("generationSpeed");
    const details = await sessions.details(a.id);
    expect(details).toHaveProperty("generationSpeed", first);
    expect(details.state).toHaveProperty("thinkingLevel", "high");
    expect(details.state).toHaveProperty("thinkingLevelSource", "explicit");
    expect(details.state).not.toHaveProperty("generationSpeed");
    expect(await sessions.snapshot(b.id)).not.toHaveProperty("generationSpeed");
    start(aRoute);
    delta(aRoute, 4000);
    delta(aRoute, 4500);
    end(aRoute, "length", { output: 10 });
    start(aRoute);
    delta(aRoute, 5000);
    end(aRoute, "aborted");
    expect(speeds()).toHaveLength(2);
    expect(await sessions.snapshot(a.id)).toHaveProperty("generationSpeed", { ...first, tokensPerSecond: 20 });
    sessions.disconnected();
    await sessions.action(a.id, { action: "resume" });
    expect(await sessions.snapshot(a.id)).not.toHaveProperty("generationSpeed");
  } finally {
    clock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
