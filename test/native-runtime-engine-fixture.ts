import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { record } from "../src/protocol.ts";

const mode = process.argv[2];
const log = process.argv[3];
const route = "rpc-private-route";
const durable = "native-private-durable";
const time = "2026-11-25T12:34:56.000Z";
const secret = "PRIVATE-DO-NOT-RETURN";
let state: Record<string, unknown> = {};
let reads = 0;

for await (const line of createInterface({ input: process.stdin })) {
  const cmd = record(JSON.parse(line));
  if (log) appendFileSync(log, `${JSON.stringify(cmd)}\n`);
  const reply = (data: unknown, errorCode?: string, error = secret) => {
    console.log(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type,
      sessionId: cmd.sessionId, success: errorCode === undefined, data,
      ...(errorCode === undefined ? {} : { errorCode, error }) }));
  };
  switch (cmd.type) {
    case "get_protocol_info":
      reply({ mode: "multi", protocolVersion: 1, serverVersion: mode?.startsWith("legacy") ? "2026.10.01" : "2026.11.23" });
      break;
    case "set_client_info":
    case "set_session_name":
    case "set_session_archived":
    case "close_session":
      reply({});
      break;
    case "open_session":
      state = { sessionId: mode === "legacy-route" ? route : durable, sessionFile: cmd.sessionPath,
        cwd: cmd.cwd, sessionName: cmd.name };
      reply({ sessionId: route, state, permissionPreset: "ask", permissionPresetStatus: "applied" });
      break;
    case "get_state":
      if (cmd.sessionId !== route) { reply({}, "unknown_session"); break; }
      reads++;
      if (mode === "stale-route") { reply({}, "unknown_session"); break; }
      reply((mode === "identity-change" && reads === 2) || mode === "before-change"
        ? { ...state, sessionId: "other-private-durable" }
        : mode === "path-change" && reads === 2 ? { ...state, sessionFile: `/${secret}.jsonl` } : state);
      break;
    case "extension_request": {
      const data = record(cmd.data);
      if (cmd.sessionId !== route) { reply({}, "unknown_session"); break; }
      if (mode === "legacy-no-plugin") {
        reply({}, "engine_refused", `Unknown extension RPC request: ${cmd.name}`);
        break;
      }
      if (cmd.name === "omo.task.list" && data.parent_session_id === durable && Object.keys(data).length === 1) {
        if (mode === "route-change") console.log(JSON.stringify({ type: "session_released", sessionId: route }));
        const row = { task_id: secret, status: "error", created_at: time, updated_at: time,
          description: secret, task_summary: secret, error_message: secret, final_response: secret };
        reply(mode === "configured-unavailable" ? { kind: "unavailable", reason: secret }
          : { parent_session_id: mode === "foreign-task" ? secret : durable,
            tasks: mode === "invalid" ? [{ ...row, status: secret }]
              : mode === "oversize" ? Array(257).fill(row) : mode === "empty" ? [] : [row] });
      } else if (cmd.name === "omo.dag.list" && data.limit === 256 && Object.keys(data).length === 1) {
        if (mode === "dag-unavailable") { reply({ ok: false, error: { code: "history_unavailable", message: secret } }); break; }
        reply({ ok: true, value: { limit: 256, runs: mode === "empty" ? [] : [{
          runId: secret, name: secret, parentSessionId: mode === "foreign-dag" ? secret : durable,
          status: "running", createdAt: time, updatedAt: time, counts: { total: mode === "invalid-dag" ? -1 : 3 },
          nodes: [{ prompt: secret }], lastSeq: 42,
        }] } });
      } else if (cmd.name === "omo.memory.status" && Object.keys(data).length === 0) {
        if (mode === "memory-unavailable") { reply({ kind: "unavailable", reason: secret }); break; }
        reply({ schemaVersion: mode === "future-memory" ? 2 : 1, identity: secret, repo: { path: secret },
          journal: { sessionId: mode === "foreign-memory" ? secret : durable, totalSteps: 8,
            reflectedSteps: mode === "invalid-memory" ? secret : 5 },
          reflection: { lastOutcome: secret, backlogSteps: 3 }, sync: { url: secret }, nextCursor: secret });
      } else {
        reply({}, "fixture_unexpected_rpc");
      }
      break;
    }
    default:
      reply({}, "fixture_unexpected_rpc");
  }
}
