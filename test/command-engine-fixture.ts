import { createInterface } from "node:readline";

// Standalone shim for command-contract tests. Mirrors the shared app fixture's
// RPC framing but emulates native command behavior: a fixed get_commands
// registry, strict unknown-command rejection, and a hanging command for busy
// coverage. Do not reuse the shared app fixture here; this file owns its log.
type SessionState = { messages: unknown[]; name?: string };

const sessions = new Map<string, SessionState>();
const hanging = new Map<string, boolean>();
let sequence = 0;
let runs = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const model = { id: "fixture", provider: "local", name: "Fixture model", baseUrl: "https://credential.invalid" };

const registry = [
  { name: "echo", description: "Echo command", source: "extension",
    sourceInfo: { path: "/tmp/echo.ts", source: "local", scope: "project", origin: "top-level" } },
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "skill:pdf-tools", description: "PDF tools", source: "skill" },
  { name: "hang-start", description: "Hanging command for busy tests", source: "extension" },
  ...(process.argv.includes("--restricted-catalog")
    ? ["reasoning", "efforts", "todo", "tasks", "dag", "task-kill", "compact", "settings", "reload"].map(name => ({
    name, description: "Native command not routed from this workbench", source: "extension",
  })) : []),
  { name: "secret", description: "Must never surface", source: "internal",
    sourceInfo: { path: "/etc/secret", source: "local", scope: "user", origin: "top-level" } },
];

const COMMAND_TOKEN = /^\/([A-Za-z0-9_-]+|skill:[A-Za-z0-9-]+)$|^\$[A-Za-z0-9-]+$/;

function canonicalFor(first: string): string | undefined {
  for (const cmd of registry) {
    if (cmd.source === "skill") {
      const short = cmd.name.slice("skill:".length);
      if (first === `$${short}` || first === `/${cmd.name}`) return `$${short}`;
    } else if (cmd.source === "extension" || cmd.source === "prompt") {
      if (first === `/${cmd.name}`) return `/${cmd.name}`;
    }
  }
  return undefined;
}

for await (const line of lines) {
  const request = JSON.parse(line);
  const route = String(request.sessionId);
  const session = sessions.get(route);
  const reply = (data: unknown) =>
    send({ id: request.id, type: "response", command: request.type, success: true, data });
  const refuse = (error: string) =>
    send({ id: request.id, type: "response", command: request.type, success: false, error, errorCode: "unknown_command" });
  switch (request.type) {
    case "get_protocol_info":
      reply({ protocolVersion: 1, mode: "multi", serverVersion: "fixture", capabilities: ["multi_session", "session_model_scope"] });
      break;
    case "set_client_info":
      reply({});
      break;
    case "open_session": {
      const sessionId = `rpc-${++sequence}`;
      sessions.set(sessionId, { messages: [] });
      reply({ sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" });
      break;
    }
    case "close_session":
      sessions.delete(route);
      hanging.delete(route);
      reply({});
      break;
    case "set_session_name":
      if (session) session.name = request.name;
      reply({});
      break;
    case "get_state":
      reply({ model, sessionName: session?.name, isStreaming: hanging.get(route) === true,
        thinkingLevel: "off", permissionPreset: "ask", sessionId: `durable-${route}` });
      break;
    case "get_available_models":
      reply({ models: [model] });
      break;
    case "get_available_thinking_levels":
      reply({ levels: ["off", "low", "high"] });
      break;
    case "get_commands":
      reply({ commands: registry });
      break;
    case "get_session_stats":
      reply({ totalMessages: session?.messages.length ?? 0, cost: 0 });
      break;
    case "get_pending_inputs":
      reply({ inputs: [], outcomes: [] });
      break;
    case "get_tree":
      reply({ tree: [], leafId: null });
      break;
    case "set_session_archived":
    case "set_session_settled":
      reply({});
      break;
    case "get_messages":
      reply({ messages: session?.messages ?? [] });
      break;
    case "abort":
      hanging.set(route, false);
      send({ type: "agent_settled", sessionId: route });
      reply({});
      break;
    case "prompt": {
      const text = String(request.message ?? "");
      const keys = Object.keys(request)
        .filter(key => key !== "id" && key !== "type" && key !== "sessionId").sort();
      const first = text.trim().split(/\s+/)[0] ?? "";
      const turnId = `turn-${runs + 1}`;
      const echoId = typeof request.clientMessageId === "string" ? { clientMessageId: request.clientMessageId } : {};
      if (text === text.trimStart() && COMMAND_TOKEN.test(first)) {
        const canonical = canonicalFor(first);
        if (!canonical) {
          refuse(`unknown command: ${first}`);
          break;
        }
        const rest = text.trim().slice(first.length).trim();
        if (canonical === "/hang-start") {
          hanging.set(route, true);
          send({ type: "agent_start", sessionId: route });
          reply({ disposition: "started", turnId, ...echoId });
          break;
        }
        runs += 1;
        const composed = rest ? `${canonical} ${rest}` : canonical;
        const user = { role: "user", content: [{ type: "text", text }], timestamp: 8 };
        const message = { role: "assistant", content: [{ type: "text", text: `Ran #${runs}: ${composed}` }], timestamp: 10 };
        session?.messages.push(user, message);
        send({ type: "agent_start", sessionId: route });
        send({ type: "message_end", sessionId: route, message: user });
        send({ type: "message_end", sessionId: route, message });
        send({ type: "agent_settled", sessionId: route });
        reply({ disposition: "handled", turnId, ...echoId });
        break;
      }
      const user = { role: "user", content: [{ type: "text", text }], timestamp: 8 };
      const message = { role: "assistant",
        content: [{ type: "text", text: `Echo: ${text} [keys:${keys.join(",")}]` }], timestamp: 10 };
      session?.messages.push(user, message);
      send({ type: "agent_start", sessionId: route });
      send({ type: "message_end", sessionId: route, message: user });
      send({ type: "message_end", sessionId: route, message });
      send({ type: "agent_settled", sessionId: route });
      reply({ disposition: "started", turnId, ...echoId });
      break;
    }
    default:
      send({ id: request.id, type: "response", command: request.type, success: false, error: "unsupported fixture method" });
      break;
  }
}
