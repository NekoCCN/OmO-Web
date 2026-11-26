import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
if (!log) throw new Error("Missing fixture log");
const sessions = new Map<string, { name: string; reads: number }>();
const hidden = "https://user:secret@private.invalid/private/path";
let sequence = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, type, sessionId, name } = JSON.parse(line);
  appendFileSync(log, `${JSON.stringify({ type, sessionId })}\n`);
  const send = (frame: object) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const reply = (data: object) => send({ id, type: "response", command: type, success: true, data });
  const refuse = (errorCode: string) => send({ id, type: "response", command: type, success: false, errorCode, error: hidden });
  const session = sessions.get(sessionId);

  if (type === "get_protocol_info") {
    reply({ protocolVersion: 1, mode: "multi", serverVersion: "fixture", capabilities: ["multi_session"] });
  } else if (type === "set_client_info") {
    reply({});
  } else if (type === "open_session") {
    const route = `private-route-${++sequence}`;
    sessions.set(route, { name: "", reads: 0 });
    reply({ sessionId: route, permissionPreset: "ask", permissionPresetStatus: "applied" });
  } else if (!session) {
    refuse("session_not_found");
  } else if (type === "set_session_name") {
    session.name = name;
    reply({});
  } else if (type === "get_commands") {
    if (session.name === "command-failure") refuse("internal_error");
    else if (session.name === "malformed") reply({ commands: null });
    else if (session.name === "empty") reply({ commands: [] });
    else reply({ commands: [
      { name: "fix-tests", source: "prompt", description: hidden, sourceInfo: { path: hidden } },
      { name: "skill:pdf-tools", source: "skill" },
      { name: "echo", source: "extension" },
      { name: "path/command", source: "extension" },
      { name: "forged", source: hidden },
    ] });
  } else if (type === "get_loaded_surfaces") {
    if (session.name === "legacy") refuse("unknown_command");
    else if (session.name === "malformed") reply({ mcpServers: [] });
    else if (session.name === "empty") reply({ extensions: [], mcpServers: [] });
    else if (session.name === "park-during-read") {
      send({ type: "session_parked", sessionId });
      reply({ extensions: [{ name: "stale", enabled: true }], mcpServers: [] });
    } else if (session.name === "bounded") {
      reply({ extensions: Array.from({ length: 130 }, (_, index) => ({ name: `extension-${index}`, enabled: true })),
        mcpServers: [{ name: "known", status: "unknown-future-state", toolCount: 0 },
          { name: "bad-count", status: "idle", toolCount: -1 }] });
    } else {
      if (session.reads++ === 0) {
        reply({
          extensions: [
            { name: "passive-fixture", enabled: true, path: hidden, sourceInfo: { path: hidden, source: hidden, origin: "top-level" } },
            { name: "packaged", enabled: false, sourceInfo: { origin: "package" } },
            { name: "origin-unknown", enabled: true, sourceInfo: { origin: hidden } },
            { name: "bad\n", enabled: true },
            { name: hidden, enabled: true },
          ],
          mcpServers: [
            { name: "local-fixture", status: "connecting", toolCount: 0, lastError: hidden, endpoint: hidden, authStatus: hidden },
            { name: "local.fixture", status: "connected", toolCount: 3 },
            { name: hidden, status: "connected", toolCount: 99 },
          ],
        });
      } else {
        reply({ extensions: [], mcpServers: [{ name: "local-fixture", status: "connected", toolCount: 3 }] });
      }
    }
  } else {
    refuse("unexpected_request");
  }
}
