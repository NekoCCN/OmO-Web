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
let lists = 0;
const runId = "dag_22222222-2222-4222-8222-222222222222";

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
    case "get_tree": {
      if (cmd.sessionId !== route) { reply({}, "unknown_session"); break; }
      if (mode === "todo-release") console.log(JSON.stringify({ type: "session_released", sessionId: route }));
      const tasks = mode === "todo-zero" ? [{ content: "Done", status: "completed" }]
        : [{ content: "Review changes", status: "in_progress" }, { content: secret, status: "pending" }];
      const entry = { id: secret, parentId: null, type: "custom", customType: "senpi.todo-state",
        data: { schema: "v2", phases: [{ name: secret, tasks: mode === "todo-budget" ? Array(501).fill(tasks[0]) : tasks }] } };
      reply(mode === "empty" ? { tree: [], leafId: null } :
        { tree: [{ entry, children: [] }], leafId: mode === "todo-invalid" ? "unknown" : secret });
      break;
    }
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
          description: secret, task_summary: secret, error_message: secret, final_response: secret,
          ...(mode?.startsWith("select-") ? { name: "Review changes", agent_type: "explore",
            category: `${secret} /home/private`, execution_mode: "in-process" } : {}) };
        reply(mode === "configured-unavailable" ? { kind: "unavailable", reason: secret }
          : { parent_session_id: mode === "foreign-task" ? secret : durable,
            tasks: mode === "invalid" ? [{ ...row, status: secret }]
              : mode === "oversize" ? Array(257).fill(row) : mode === "empty" ? [] : [row] });
      } else if (cmd.name === "omo.dag.list" && data.limit === 256 && Object.keys(data).length === 1) {
        if (mode === "dag-unavailable") { reply({ ok: false, error: { code: "history_unavailable", message: secret } }); break; }
        lists++;
        const selectable = mode?.startsWith("select-");
        reply({ ok: true, value: { limit: 256, runs: mode === "empty" || (mode === "select-delisted" && lists > 1) ? [] : [{
          runId: selectable ? runId : secret, name: selectable ? "Verify build" : secret,
          parentSessionId: mode === "foreign-dag" ? secret : durable,
          status: "running", createdAt: time, updatedAt: time,
          counts: { total: mode === "invalid-dag" ? -1 : 3, ...(selectable ? { running: 1, completed: 2 } : {}) },
          nodes: [{ prompt: secret }], lastSeq: 42,
        }] } });
      } else if (cmd.name === "omo.dag.snapshot" && data.runId === runId && Object.keys(data).length === 1) {
        if (mode === "select-release") console.log(JSON.stringify({ type: "session_released", sessionId: route }));
        const a = "private-build-id", b = "private-test-id", c = "private-report-id";
        const nodes = [
          { id: a, state: "completed", attempt: 1, dependsOn: [], label: "Verify build",
            route: { kind: "agent", agent: "explore", model: `${secret} /home/private` } },
          { id: b, state: "completed", attempt: 2, dependsOn: [], label: `Run tests ${secret}`,
            route: { kind: "category", category: `quick ${secret}` } },
          { id: c, state: "running", attempt: 1, dependsOn: [b], label: "/home/private",
            route: { kind: "category", category: "quick" } },
        ].map(node => ({ ...node, prompt: secret, output: secret, error: secret }));
        reply({ ok: true, value: { schemaVersion: 1, runId,
          parentSessionId: mode === "select-foreign" ? secret : durable, status: "running", counts: { total: 3 },
          nodes: mode === "select-overbudget" ? Array(65).fill(nodes[0]) : nodes,
          edges: [{ from: mode === "select-malformed" ? c : a, to: c }],
          waves: [{ index: 0, nodeIds: [a, b] }, { index: 1, nodeIds: [c] }],
          diagnostics: mode === "select-bytes" ? "x".repeat(1024 * 1024) : secret,
        } });
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
