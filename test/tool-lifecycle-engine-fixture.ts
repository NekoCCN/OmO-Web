import { createInterface } from "node:readline";

/**
 * Tool-lifecycle stdio fixture for the tool-lifecycle HTTP tests.
 * Emits a scripted approval-gated tool run: tool_execution_start,
 * extension_ui_request (select approval), then waits for
 * extension_ui_response before emitting tool_execution_end, agent_end,
 * agent_settled, agent_idle and pending_input_update. Anything else is a
 * plain echo turn. Pending dialogs are authoritative in get_state, so the
 * Web bridge can reconcile them from snapshots.
 */
const sessions = new Map<string, {
  name?: string;
  messages: unknown[];
  pendingDialogs: Record<string, unknown>[];
  streaming: boolean;
  settled: string | null;
}>();
let sequence = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const ok = (id: unknown, data: unknown, command: string) =>
  send({ id, type: "response", command, success: true, data });
const model = { id: "fixture", provider: "local", name: "Fixture model" };
const phrase = "terminal-evidence";
const partialLayoutMessages = [
  { role: "user", timestamp: 1, content: "Check tools with delayed styles." },
  { role: "assistant", timestamp: 2, stopReason: "toolUse", content: [
    { type: "toolCall", id: "long-output", name: "bash", arguments: { command: `printf ${"x".repeat(700)}` } },
    { type: "toolCall", id: "partial-read", name: "read", arguments: { path: `/workspace/${"a".repeat(180)}.txt` } },
    { type: "toolCall", id: "malformed", name: "synthetic_plugin", arguments: ["raw-input"] },
    { type: "toolCall", id: "missing", name: "bash" },
  ] },
  { role: "toolResult", timestamp: 3, toolCallId: "long-output", toolName: "bash", isError: false,
    content: `${phrase}\n${"w".repeat(760)}\n${"Log line.\n".repeat(85)}output-end` },
  { role: "toolResult", timestamp: 4, toolCallId: "partial-read", toolName: "read", content: "partial-evidence" },
  { role: "toolResult", timestamp: 5, toolCallId: "malformed", toolName: "synthetic_plugin", isError: false,
    content: { text: "not-a-display-part" } },
] as const;

const stateOf = (route: string) => {
  const session = sessions.get(route);
  return {
    model,
    sessionName: session?.name ?? "Tool lifecycle",
    isStreaming: session?.streaming ?? false,
    thinkingLevel: "off",
    permissionPreset: "ask",
    pendingDialogs: session?.pendingDialogs ?? [],
    pendingQuestions: [],
  };
};

for await (const line of lines) {
  const request = JSON.parse(line);
  const route = String(request.sessionId);
  const session = sessions.get(route);
  let data: unknown;
  switch (request.type) {
    case "get_protocol_info":
      data = { protocolVersion: 1, mode: "multi", serverVersion: "tool-lifecycle-fixture",
        capabilities: ["multi_session", "session_model_scope", "question"] };
      break;
    case "set_client_info":
      break;
    case "open_session": {
      const sessionId = `rpc-${++sequence}`;
      sessions.set(sessionId, { messages: [], pendingDialogs: [], streaming: false, settled: null });
      data = { sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    }
    case "close_session":
      sessions.delete(route);
      break;
    case "set_session_name":
      if (session && typeof request.name === "string") session.name = request.name;
      break;
    case "get_state":
      data = stateOf(route);
      break;
    case "get_available_models":
      data = { models: [model] };
      break;
    case "get_available_thinking_levels":
      data = { levels: ["off", "low", "high"] };
      break;
    case "get_commands":
      data = { commands: [] };
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
      data = { messages: session?.name === "Partial layout"
        ? [...partialLayoutMessages, ...session.messages] : session?.messages ?? [] };
      break;
    case "abort":
      if (session) {
        session.streaming = false;
        session.pendingDialogs = [];
        send({ type: "agent_settled", sessionId: route });
        send({ type: "agent_idle", sessionId: route });
      }
      break;
    case "extension_ui_response": {
      if (session) {
        const pending = session.pendingDialogs.find(dialog => dialog.id === request.uiRequestId);
        session.pendingDialogs = session.pendingDialogs.filter(dialog => dialog.id !== request.uiRequestId);
        if (pending) {
          const toolCallId = String(pending.toolCallId ?? "call-approval-1");
          send({ type: "tool_execution_end", sessionId: route, toolCallId,
            toolName: "write", isError: false,
            result: { content: [{ type: "text", text: "Synthetic write output." }] } });
          session.messages.push(
            { role: "toolResult", toolCallId, toolName: "write", isError: false,
              content: [{ type: "text", text: "Synthetic write output." }], timestamp: 12 },
            { role: "assistant", content: [{ type: "text", text: "Synthetic approval settled." }], timestamp: 13 },
          );
          session.streaming = false;
          send({ type: "agent_end", sessionId: route });
          send({ type: "message_end", sessionId: route,
            message: { role: "assistant", content: [{ type: "text", text: "Synthetic approval settled." }], timestamp: 13 } });
          send({ type: "agent_settled", sessionId: route });
          send({ type: "agent_idle", sessionId: route });
          send({ type: "pending_input_update", sessionId: route, lifetimeId: "tool-lifecycle",
            cursor: 1, changes: [] });
        }
      }
      data = { answered: true };
      break;
    }
    case "prompt": {
      if (session && String(request.message).includes("tool-lifecycle-approval")) {
        session.streaming = true;
        const toolCallId = "call-approval-1";
        const dialog = { id: "approval-1", method: "select", title: "Synthetic write approval",
          message: "Allow the synthetic write?", options: ["Allow once", "Deny"], toolCallId };
        session.pendingDialogs = [dialog];
        session.messages.push(
          { role: "user", content: [{ type: "text", text: request.message }], timestamp: 10 },
          { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "write",
            arguments: { path: "blocked.txt" } }], timestamp: 11 },
        );
        send({ type: "agent_start", sessionId: route });
        send({ type: "message_end", sessionId: route,
          message: { role: "user", content: [{ type: "text", text: request.message }], timestamp: 10 } });
        send({ type: "tool_execution_start", sessionId: route, toolCallId, toolName: "write",
          args: { path: "blocked.txt" } });
        send({ type: "extension_ui_request", sessionId: route, ...dialog });
        data = { disposition: "started", turnId: "turn-approval" };
        break;
      }
      if (session) {
        session.messages.push(
          { role: "user", content: [{ type: "text", text: request.message }], timestamp: 8 },
          { role: "assistant", content: [{ type: "text", text: `Echo: ${request.message}` }], timestamp: 9 },
        );
        send({ type: "agent_start", sessionId: route });
        send({ type: "message_end", sessionId: route,
          message: { role: "assistant", content: [{ type: "text", text: `Echo: ${request.message}` }], timestamp: 9 } });
        send({ type: "agent_settled", sessionId: route });
        send({ type: "agent_idle", sessionId: route });
      }
      data = { disposition: "started", turnId: "turn-1" };
      break;
    }
    default:
      send({ id: request.id, type: "response", command: request.type, success: false, error: "unsupported fixture method" });
      continue;
  }
  send({ id: request.id, type: "response", command: request.type, success: true, data });
}
