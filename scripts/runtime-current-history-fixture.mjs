import { basename } from "node:path";
import { createInterface } from "node:readline";

const stamp = "2026-11-25T12:34:56.000Z";
const runId = "dag_22222222-2222-4222-8222-222222222222";
const pastId = "dag_33333333-3333-4333-8333-333333333333";
const execution = process.argv.includes("--execution");
const density = execution || process.argv.includes("--density");
const privateText = "PRIVATE_DAG_DENSITY_CANARY";
const started = "2026-11-25T12:35:00.000Z";
const completed = "2026-11-25T12:36:02.000Z";
const childIds = ["st_11111111", "st_22222222", "st_33333333", "st_44444444"];
const executionTasks = childIds.map((task_id, index) => ({
  task_id, status: index === 1 ? "running" : "completed", created_at: stamp, updated_at: completed,
  task_summary: index < 2 ? "Review shared outline" : index === 2 ? "Check archive" : "Unlinked standalone task",
  description: ["Compare headings against the source.", "Verify equations and note missing citations.",
    "Confirm the stored record is readable.", "This detail is available without opening the DAG."][index],
  agent_type: index === 2 ? undefined : "explore", category: index === 2 ? "quick" : undefined,
  execution_mode: index === 1 ? "process" : "in-process", model: `requested/model-${index}`,
  effective_model: index === 0 ? { provider: "observed", model_id: "confirmed-v2", reasoning: "high" }
    : index === 2 ? { provider: "another", model_id: "routed/v3" }
    : index === 3 ? { provider: "rejected provider", model_id: "unverified-v1" } : undefined,
  prompt: privateText, response: privateText,
}));
const mixedStates = ["completed", "failed", "running", "paused", "skipped", "blocked", "pending", "scheduled", "completed"];
const mixedNodes = mixedStates.map((state, index) => ({
  id: `${privateText}-node-${index}`, state, attempt: index === 5 ? 0 : index === 2 ? 2 : 1,
  dependsOn: index === 5 ? [0, 1, 2, 3, 4].map(upstream => `${privateText}-node-${upstream}`) : [],
  route: index === 2 ? { kind: "agent", agent: "explore", model: execution ? "configured/node-override" : undefined }
    : index === 5 ? { kind: "category", category: "quick" }
    : { kind: "agent", agent: privateText },
  prompt: privateText, error: privateText,
}));
const sessions = new Map();
const checklist = (id, parentId, ...tasks) => ({
  id, parentId, type: "custom", customType: "senpi.todo-state",
  data: { schema: "v2", phases: [{ name: "Checks", tasks: tasks.map(([content, status]) => ({ content, status })) }] },
});
const entries = [
  { id: "root", parentId: null, type: "message", message: { role: "user", content: "Branch start", timestamp: Date.parse(stamp) } },
  checklist("recorded", "root", ["Recorded-only item", "completed"]),
  checklist("current", "recorded", ["Current-only item", "in_progress"], ["Done in current", "completed"]),
  { id: "recall", parentId: "current", type: "custom", customType: "omo-kibitzer:gate",
    data: { version: 1, status: "skipped", consecutiveFailures: 1, candidateCount: 2 } },
  checklist("settled", "recall", ["Settled item", "completed"]),
  checklist("sibling", "root", ["Sibling-only item", "in_progress"]),
];

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const target = sessions.get(request.sessionId);
  const send = data => console.log(JSON.stringify(data));
  const respond = (data, errorCode, error) => send({ type: "response", id: request.id,
    command: request.type, sessionId: request.sessionId, success: !errorCode, data, errorCode, error });
  switch (request.type) {
    case "get_protocol_info": respond({ mode: "multi", protocolVersion: 1, serverVersion: "2026.11.23" }); break;
    case "open_session": {
      const route = `browser-route-${sessions.size + 1}`;
      const state = { sessionId: basename(request.sessionPath, ".jsonl"), sessionFile: request.sessionPath, cwd: request.cwd };
      sessions.set(route, { state, leaf: "recall", settled: false });
      respond({ sessionId: route, state, permissionPreset: "ask", permissionPresetStatus: "applied" });
      break;
    }
    case "get_state": respond(target.state); break;
    case "get_messages": respond({ messages: [] }); break;
    case "get_session_stats":
    case "set_client_info":
    case "close_session": respond({}); break;
    case "get_pending_inputs": respond({ inputs: [] }); break;
    case "get_available_models": respond({ models: [] }); break;
    case "get_available_thinking_levels": respond({ levels: [] }); break;
    case "get_commands": respond({ commands: [] }); break;
    case "get_loaded_surfaces": respond({ extensions: [], mcpServers: [] }); break;
    case "list_sessions": respond({ sessions: [] }); break;
    case "set_session_name":
      if (request.name === "Settled fixture") {
        target.leaf = "settled";
        target.settled = true;
        send({ type: "agent_settled", sessionId: request.sessionId });
      } else target.name = request.name;
      respond({});
      break;
    case "get_entries": {
      const records = target.name === "Older fixture" ? [] : entries.filter(entry => target.settled || entry.id !== "settled");
      respond({ entries: records.slice(-request.tail), leafId: records.length ? target.leaf : null, hasMore: false });
      break;
    }
    case "navigate_tree":
      if (request.expectedLeafId !== target.leaf) respond({}, "stale_leaf");
      else {
        target.leaf = request.targetId;
        respond({ cancelled: false, leafId: target.leaf });
      }
      break;
    case "extension_request": {
      const owner = target.state.sessionId;
      if (request.name === "omo.task.list") {
        const tasks = execution && target.name === "Current fixture" ? executionTasks : [{
          task_id: execution ? childIds[0] : "private-task", status: "completed", created_at: stamp, updated_at: stamp,
          task_summary: execution ? "Other session task" : undefined,
        }, ...(execution ? [{
          status: "completed", created_at: stamp, updated_at: stamp, task_summary: "Task without verified identity",
          description: "The report is readable, but its identity was not supplied.",
        }] : [])];
        respond({ parent_session_id: owner, tasks });
      } else if (request.name === "omo.memory.status") {
        respond({ schemaVersion: 1, journal: { sessionId: owner, totalSteps: 8, reflectedSteps: 5 } });
      } else if (target.name === "Older fixture") {
        respond({}, "engine_refused", `Unknown extension RPC request: ${request.name}`);
      } else if (request.name === "omo.dag.list") {
        const history = request.data.statuses.includes("completed");
        const makeRun = (id, status) => ({
          runId: id, parentSessionId: owner, status, createdAt: stamp, updatedAt: stamp,
          name: execution ? id === pastId ? "Archive review" : "Release readiness review" : undefined,
          counts: density ? { total: 9, completed: 2, running: 1, paused: 1, blocked: 1, failed: 1, pending: 1,
            scheduled: 1, cancelled: 0 } : { total: 1 },
        });
        const runs = history ? [makeRun(pastId, "completed"), ...(target.settled ? [makeRun(runId, "completed")] : [])]
          : target.settled ? [] : [makeRun(runId, "running")];
        respond({ ok: true, value: { limit: 256, runs } });
      } else if (request.name === "omo.dag.snapshot") {
        const { runId: id } = request.data;
        const status = id === pastId || target.settled ? "completed" : "running";
        const nodes = !execution ? mixedNodes : mixedNodes.map((node, index) => ({
          ...node, label: ["Review source headings", "Record failed check", "Verify document equations", "Await review",
            "Skip redundant check", "Assemble evidence", "Publish the checklist",
            "LongUnbrokenMetadataLabelThatMustWrapWithoutPushingTheInspectorPastTheViewport", "Check final notes"][index],
          taskId: target.name !== "Current fixture" ? undefined
            : id === pastId ? index === 0 ? childIds[2] : undefined
              : index === 0 ? childIds[0] : index === 2 ? childIds[1] : undefined,
          createdAt: stamp, startedAt: index < 4 ? started : undefined,
          completedAt: index === 0 ? completed : index === 3 ? stamp : undefined,
          lastActivityAt: index === 2 ? completed : undefined,
        }));
        respond({ ok: true, value: { schemaVersion: 1, runId: id, parentSessionId: owner, status,
          name: execution ? id === pastId ? "Archive review" : "Release readiness review" : undefined,
          createdAt: stamp, startedAt: started, completedAt: id === pastId ? completed : undefined,
          counts: { total: density ? mixedNodes.length : 1 },
          nodes: density ? nodes : [{ id: "fixture-node", state: status, attempt: 1, dependsOn: [],
            route: { kind: "category", category: "quick" } }],
          edges: [],
          waves: density
            ? [mixedNodes.slice(0, 5), mixedNodes.slice(5)].map((nodes, index) => ({ index, nodeIds: nodes.map(node => node.id) }))
            : [{ index: 0, nodeIds: ["fixture-node"] }],
        } });
      } else respond({}, "fixture_unexpected_rpc");
      break;
    }
    default: respond({}, "unknown_command");
  }
}
