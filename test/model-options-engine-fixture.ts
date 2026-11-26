import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
const models = [
  { provider: "fixture", id: "alpha", name: "Alpha", levels: ["off", "low", "high"], initial: "low" },
  { provider: "fixture", id: "beta", name: "Beta", levels: ["off", "medium"], initial: "medium" },
] as const;
const sessions = new Map<string, {
  id: string; cwd: string; file: string; name: string; model: typeof models[number]; level: string; changed: boolean; moved?: boolean;
}>();
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(log, `${line}\n`);
  const session = sessions.get(request.sessionId);
  const target = models.find(item => item.provider === request.provider && item.id === request.modelId);
  let data: unknown = {};
  let errorCode = "";
  switch (request.type) {
    case "get_protocol_info":
      data = { protocolVersion: 1, mode: "multi", serverVersion: "model-fixture", capabilities: ["multi_session", "session_model_scope"] };
      break;
    case "open_session": {
      const sessionId = `rpc-${sessions.size + 1}`;
      const opened = { id: crypto.randomUUID(), cwd: request.cwd, file: request.sessionPath, name: "", model: models[0],
        level: models[0].initial, changed: false };
      sessions.set(sessionId, opened);
      data = { sessionId, state: { sessionId: opened.id, cwd: opened.cwd, sessionFile: opened.file },
        permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    }
    case "set_session_name": if (session) session.name = request.name; break;
    case "close_session": sessions.delete(request.sessionId); break;
    case "get_state":
      if (!session) { errorCode = "unknown_session"; break; }
      data = { sessionId: session.moved ? "changed-durable" : session.id, cwd: session.cwd, sessionFile: session.file, model: session.model,
        thinkingLevel: session.level, isStreaming: session.name === "busy", archived: session.name === "archived",
        pendingModelSwitch: session.name === "pending" ? { provider: "fixture", modelId: "beta" } : null };
      break;
    case "get_available_models":
      data = { models: models.map(({ provider, id, name }) => ({ provider, id, name, supportedThinkingLevels: ["off"],
        baseUrl: "private-fixture-url" })) };
      break;
    case "get_model_thinking_level":
      if (!session || session.name === "old") { errorCode = "unknown_command"; break; }
      if (!target) { errorCode = "model_not_found"; break; }
      if (session.name === "moving") session.moved = true;
      data = { level: session.model === target ? session.level : target.initial,
        source: session.name === "future" ? "private-future-source" : session.changed && session.model === target ? "session" : "default",
        availableLevels: target.levels, extra: "private-fixture-url" };
      break;
    case "get_available_thinking_levels":
      if (session?.name === "moving-write") session.moved = true;
      data = { levels: session?.model.levels ?? [] };
      break;
    case "set_model":
      if (session && target && request.scope === "session") {
        session.model = target; session.level = target.initial; session.changed = false;
      } else errorCode = "bad_write";
      break;
    case "set_thinking_level":
      if (session && request.scope === "turn" && session.model.levels.some(level => level === request.level)) {
        session.level = request.level; session.changed = true;
      } else errorCode = "bad_write";
      break;
    case "get_commands": data = { commands: [] }; break;
    case "get_messages": data = { messages: [] }; break;
    case "get_tree": data = { tree: [] }; break;
    case "get_pending_inputs": data = { inputs: [] }; break;
    case "get_session_stats": data = { userMessages: 0, assistantMessages: 0, toolCalls: 0 }; break;
    case "set_client_info": break;
    default: errorCode = "unknown_command";
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type,
    success: !errorCode, ...(errorCode ? { errorCode, error: "private-fixture-error" } : { data }) })}\n`);
}
