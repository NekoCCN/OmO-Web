import { createInterface } from "node:readline";

/**
 * Approval-lane stdio fixture: per-session ask/auto/full-access with
 * acknowledged effective state, plus one structured question and one secret
 * question in every get_state. Secret entries are the native shape; the Web
 * projection (protocol.state -> dialog) must filter them before display.
 * set_permission_preset without a session route is refused, proving the Web
 * never performs a global preset change.
 */
const noAuto = process.env.APPROVAL_FIXTURE_NO_AUTO === "1";
const presets = new Map<string, string>();
let sequence = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const ok = (id: unknown, data: unknown, command: string) =>
  send({ id, type: "response", command, success: true, data });
const refused = (id: unknown, command: string, errorCode: string, error: string) =>
  send({ id, type: "response", command, success: false, error, errorCode });

const structured = {
  id: "q-structured", method: "question", title: "结构化问题", message: "请选择一项",
  questions: [{ id: "qq1", header: "选项", question: "选一个", options: [{ label: "A" }, { label: "B" }] }],
};
const secret = {
  id: "q-secret", method: "question", title: "私密问题", secret: true,
  questions: [{ id: "qq9", header: "私密", options: [{ label: "S" }] }],
};

for await (const line of lines) {
  const request = JSON.parse(line);
  const route = String(request.sessionId ?? "");
  switch (request.type) {
    case "get_protocol_info":
      ok(request.id, { protocolVersion: 1, mode: "multi", serverVersion: "approval-fixture",
        capabilities: noAuto ? ["multi_session", "session_model_scope"]
          : ["multi_session", "session_model_scope", "permission_preset_auto"] }, request.type);
      break;
    case "set_client_info":
      ok(request.id, {}, request.type);
      break;
    case "open_session": {
      if (request.permissionPreset !== "ask") {
        refused(request.id, request.type, "permission_mode_unconfirmed", "fixture requires ask on open");
        break;
      }
      const sessionId = `rpc-${++sequence}`;
      presets.set(sessionId, "ask");
      ok(request.id, { sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" }, request.type);
      break;
    }
    case "set_permission_preset": {
      if (!route || !presets.has(route)) {
        refused(request.id, request.type, "unknown_session", "fixture requires a session route (no global preset)");
        break;
      }
      const preset = String(request.permissionPreset ?? "");
      if (!["ask", "auto", "full-access"].includes(preset)) {
        refused(request.id, request.type, "invalid_launch_profile", `unknown permissionPreset "${preset}"`);
        break;
      }
      presets.set(route, preset);
      ok(request.id, { permissionPreset: preset, permissionPresetSource: "client", permissionPresetStatus: "applied" }, request.type);
      break;
    }
    case "get_state": {
      const preset = presets.get(route) ?? "ask";
      ok(request.id, { sessionId: route, isStreaming: false, permissionPreset: preset,
        effectivePermissionPreset: preset, permissionPresetStatus: "applied",
        pendingQuestions: [structured, secret], pendingDialogs: [] }, request.type);
      break;
    }
    case "extension_ui_response":
    case "set_session_name":
    case "set_session_archived":
    case "set_session_settled":
      ok(request.id, {}, request.type);
      break;
    case "get_messages":
      ok(request.id, { messages: [] }, request.type);
      break;
    case "get_available_models":
      ok(request.id, { models: [] }, request.type);
      break;
    case "get_available_thinking_levels":
      ok(request.id, { levels: ["off"] }, request.type);
      break;
    case "get_commands":
      ok(request.id, { commands: [] }, request.type);
      break;
    case "get_session_stats":
      ok(request.id, { totalMessages: 0, cost: 0 }, request.type);
      break;
    case "get_pending_inputs":
      ok(request.id, { inputs: [], outcomes: [] }, request.type);
      break;
    case "get_tree":
      ok(request.id, { tree: [], leafId: null }, request.type);
      break;
    case "close_session":
      presets.delete(route);
      ok(request.id, {}, request.type);
      break;
    default:
      refused(request.id, request.type, "unsupported", "unsupported fixture method");
      break;
  }
}
