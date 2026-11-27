import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const route = "fixture-native-route";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const large = '中"\\\u0000\n'.repeat(11_000);
const oversized = large.repeat(5);
const approval = { type: "extension_ui_request", method: "confirm", id: "fixture-decision", message: large };
const atLimit = { type: "message_update", message: { role: "assistant", content: "" }, sessionId: "x".repeat(36) };
const padding = 96 * 1024 - Buffer.byteLength(`event: omo\ndata: ${JSON.stringify(atLimit)}\n\n`);
const exact = "中".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3);
let cwd = "";
let pending = false;

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let data: object = {};
  switch (request.type) {
    case "get_protocol_info":
      data = { protocolVersion: 1, mode: "multi", serverVersion: "fixture", capabilities: ["multi_session"] };
      break;
    case "open_session":
      cwd = request.cwd;
      data = { sessionId: route, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    case "get_state":
      data = { isStreaming: false, ...(pending ? { pendingDialogs: [approval] } : {}) };
      break;
    case "get_messages":
      data = { messages: [] };
      break;
    case "get_available_models":
      data = { models: [{ id: "fixture", name: oversized, provider: "local" }] };
      break;
    case "get_last_assistant_text":
      data = { text: pending ? oversized : "普通 copy 🐋" };
      break;
    case "prompt": {
      appendFileSync(join(cwd, "operations"), "prompt\n");
      if (request.message === "large receipt") {
        data = { disposition: "started", turnId: oversized, clientMessageId: request.clientMessageId };
        break;
      }
      pending = true;
      data = { disposition: "started", turnId: "turn-1", clientMessageId: request.clientMessageId };
      const emit = (event: object) => send({ ...event, sessionId: route });
      emit({ type: "agent_start" });
      emit({ ...atLimit, message: { role: "assistant", content: exact } });
      emit({ ...atLimit, message: { role: "assistant", content: exact + "x" } });
      send({ ...approval, sessionId: "not-the-live-route" });
      emit({ type: "unrecognized_native_event", garbage: oversized });
      emit({ type: "tool_execution_update", toolCallId: "tool-1", args: { value: large } });
      emit(approval);
      emit({ type: "extension_ui_resolved", id: "other-decision", outcome: large });
      emit({ type: "queue_update", steering: [large] });
      emit({ type: "message_end", message: { role: "assistant", content: "small 中" } });
      emit({ type: "agent_settled" });
      break;
    }
    case "extension_ui_response":
      appendFileSync(join(cwd, "operations"), "decision\n");
      pending = false;
      break;
  }
  send({ id: request.id, type: "response", command: request.type, success: true, data });
}
