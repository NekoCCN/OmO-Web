import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sessions = new Map<string, { messages: unknown[]; cwd: string; sessionFile: string; name?: string;
  reads: number; stateReads: number }>();
let sequence = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const model = { id: "fixture", provider: "local", name: "Fixture model", baseUrl: "https://credential.invalid" };
const pad = "x".repeat(64 * 1024);
const pagedText = '中💡"\\\u0000\n'.repeat(75_000) + "\uD800尾";
const writeChunk = (part: string) => new Promise<void>((resolve, reject) =>
  process.stdout.write(part, error => error ? reject(error) : resolve()));
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
      sessions.set(sessionId, { messages: [], cwd: request.cwd, sessionFile: request.sessionPath, reads: 0, stateReads: 0 });
      data = { sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    }
    case "close_session":
      sessions.delete(route);
      break;
    case "set_session_name":
      if (session) session.name = request.name;
      break;
    case "get_state": {
      if (session) session.stateReads++;
      const guarded = session?.name === "Paged fixture release" || session?.name === "Paged fixture source-change" ||
        session?.name === "Paged fixture engine-disconnect";
      const afterPageRead = guarded && session.stateReads === 5;
      if (afterPageRead && session.name === "Paged fixture release") send({ type: "session_released", sessionId: route });
      if (afterPageRead && session.name === "Paged fixture engine-disconnect") process.exit(0);
      data = { model, sessionName: session?.name, isStreaming: false, thinkingLevel: "off", permissionPreset: "ask",
        ...(guarded ? { cwd: session.cwd, sessionId: `durable-${route}`,
          sessionFile: afterPageRead && session.name === "Paged fixture source-change" ? "different-source" : session.sessionFile } : {}),
        ...(session?.name === "Ceiling fixture" ? {
          pendingDialogs: [{ id: "synthetic-confirm", method: "confirm", message: "Synthetic confirmation" }],
        } : session?.name === "Mandatory state fixture" ? {
          pendingDialogs: [{ id: "synthetic-confirm", method: "confirm", message: "\u0000".repeat(50_000) }],
        } : session?.name?.startsWith("Paged fixture") ? {
          pendingDialogs: [{ id: "synthetic-confirm", method: "confirm", message: "Synthetic confirmation" }],
          pendingQuestions: [{ id: "synthetic-question", method: "question",
            questions: [{ id: "q", question: "Fixture question?" }] }],
        } : {}) };
      break;
    }
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
    case "compact":
      send({ type: "compaction_end", sessionId: route, success: true });
      break;
    case "get_messages":
      if (session?.name?.startsWith("Paged fixture")) {
        appendFileSync(join(session.cwd, "history-reads"), "get_messages\n");
        session.reads++;
        const rows = Array.from({ length: 271 }, (_, timestamp) => ({
          role: "user", timestamp, content: `old-${timestamp}`,
        }));
        data = { messages: [...rows,
          { role: "assistant", timestamp: 271, content: [{ type: "text", text: pagedText }] },
          { role: "user", timestamp: 272, content: [
            { type: "text", text: "image caption" },
            { type: "image", data: "YQ==", mimeType: "image/png", privateField: "not-web-schema" },
          ] },
          { role: "user", timestamp: 273, content: "\u0000".repeat(28_000) },
          { role: "user", timestamp: 274, content: "\u0000".repeat(28_000) },
        ] };
        if (session.name === "Paged fixture corrupt" && session.reads === 1) {
          const partial = JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data });
          await writeChunk(`${partial.slice(0, -1)},"success":false}\n`);
          continue;
        }
        if (session.name === "Paged fixture held") {
          const partial = JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data });
          await writeChunk(partial.slice(0, -1));
          appendFileSync(join(session.cwd, "history-staged"), "staged\n");
          for (let i = 0; i < 400 && !existsSync(join(session.cwd, "release-messages")); i++) await Bun.sleep(5);
          await writeChunk("}\n");
          continue;
        }
        break;
      }
      if (session?.name === "Close during snapshot" || session?.name === "Replace during snapshot" ||
          session?.name === "Compact during snapshot") {
        const type = session.name === "Close during snapshot" ? "session_closed"
          : session.name === "Replace during snapshot" ? "session_replaced" : "compaction_end";
        session.name = "After binding change";
        send({ type, sessionId: route, success: true });
        data = { messages: [{ role: "user", content: "stale synthetic row", timestamp: 42 }] };
        break;
      }
      if (session?.name === "Ceiling fixture") {
        await writeChunk(`{"id":"${request.id}","type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":"`);
        for (let n = 0; n < 64 * 16; n++) await writeChunk(pad);
        await writeChunk('"}]}}\n');
        continue;
      }
      if (session?.name === "Refusal fixture") {
        send({ id: request.id, type: "response", command: request.type, success: false, errorCode: "messages_read_limit" });
        continue;
      }
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
