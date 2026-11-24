import { createInterface } from "node:readline";

const sessions = new Map<string, { messages: unknown[]; name?: string }>();
let sequence = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const model = { id: "fixture", provider: "local", name: "Fixture model", baseUrl: "https://credential.invalid" };
for await (const line of lines) {
  const request = JSON.parse(line);
  const route = String(request.sessionId);
  const session = sessions.get(route);
  let data: unknown;
  switch (request.type) {
    case "get_protocol_info":
      data = { protocolVersion: 1, mode: "multi", serverVersion: "fixture", capabilities: ["multi_session", "session_model_scope"] };
      break;
    case "set_client_info":
      break;
    case "open_session": {
      const sessionId = `rpc-${++sequence}`;
      sessions.set(sessionId, { messages: [] });
      data = { sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    }
    case "close_session":
      sessions.delete(route);
      break;
    case "set_session_name":
      if (session) session.name = request.name;
      break;
    case "get_state":
      data = { model, sessionName: session?.name, isStreaming: false, thinkingLevel: "off", permissionPreset: "ask" };
      break;
    case "get_available_models":
      data = { models: [model] };
      break;
    case "get_available_thinking_levels":
      data = { levels: ["off", "low", "high"] };
      break;
    case "get_commands":
      data = { commands: [{ name: "fixture", description: "Local fixture command" }] };
      break;
    case "get_session_stats":
      data = { totalMessages: session?.messages.length ?? 0, cost: 0 };
      break;
    case "get_pending_inputs":
      data = { inputs: [], outcomes: [] };
      break;
    case "get_tree":
      data = { tree: [], leafId: null };
      break;
    case "set_session_archived":
    case "set_session_settled":
      break;
    case "get_messages":
      data = { messages: session?.messages ?? [] };
      break;
    case "prompt": {
      data = { disposition: "started", turnId: "turn-1" };
      const hidden = { role: "custom", content: "hidden test context", display: false, timestamp: 9 };
      const user = { role: "user", content: [{ type: "text", text: request.message }], timestamp: 8 };
      const message = { role: "assistant", content: [{ type: "text", text: `Echo: ${request.message}` }], timestamp: 10 };
      session?.messages.push(user, hidden, message);
      send({ type: "agent_start", sessionId: route });
      send({ type: "message_end", sessionId: route, message: user });
      send({ type: "message_end", sessionId: route, message: hidden });
      send({ type: "message_update", sessionId: route, message });
      send({ type: "message_end", sessionId: route, message });
      send({ type: "agent_settled", sessionId: route });
      break;
    }
    default:
      send({ id: request.id, type: "response", command: request.type, success: false, error: "unsupported fixture method" });
      continue;
  }
  send({ id: request.id, type: "response", command: request.type, success: true, data });
}
