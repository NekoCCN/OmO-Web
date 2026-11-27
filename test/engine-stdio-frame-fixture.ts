import { createInterface } from "node:readline";

const limit = 48 * 1024 * 1024;
const padding = "x".repeat(64 * 1024);
const write = (chunk: string | Uint8Array) => new Promise<void>((resolve, reject) => {
  process.stdout.write(chunk, error => error ? reject(error) : resolve());
});
const reply = (id: string, data: unknown = {}) => JSON.stringify({ type: "response", id, success: true, data }) + "\n";

async function fill(prefix: string, length: number): Promise<void> {
  await write(prefix);
  let remaining = length - prefix.length;
  while (remaining > 0) {
    await write(padding.slice(0, remaining));
    remaining -= padding.length;
  }
}

let oversized: string | undefined;
let unrelated: string | undefined;
let history: { id: string; mode: string; route: string } | undefined;
let captureTail: string | undefined;
let writes = 0;
let utf8Tail = new Uint8Array();
for await (const line of createInterface({ input: process.stdin })) {
  const { id, type, sessionId, mode, ...extra } = JSON.parse(line);
  switch (type) {
    case "get_protocol_info":
      await write(reply(id, { mode: "multi", protocolVersion: 1, serverVersion: "stdio-frame-fixture" }));
      break;
    case "get_tree":
    case "hold_late":
      oversized = id;
      break;
    case "get_state":
      unrelated = id;
      await fill(` \t{ "id":${JSON.stringify(oversized)}, "type": "response", "command":"get_tree","success":true,"data":{"tree":"`, limit + 1);
      break;
    case "get_messages":
      if (Object.keys(extra).length) throw new Error("unexpected serialized history fields");
      history = { id, mode, route: sessionId };
      if (mode === "capture" || mode === "capture-late") {
        await write(`{"id":"${id}","type":"response","command":"get_messages","success":true,"data":{"messages":[` +
          '{"role":"user","content":"early 💡","timestamp":-1},');
        captureTail = '{"role":"user","content":"最近 💡","timestamp":52}]},"sessionId":"first"}';
      }
      break;
    case "finish_capture": {
      if (!history || !captureTail) throw new Error("unexpected capture gate");
      if (history.mode === "capture") {
        const contentBytes = 1_310_720;
        let written = Buffer.byteLength(`{"id":"${history.id}","type":"response","command":"get_messages","success":true,"data":{"messages":[` +
          '{"role":"user","content":"early 💡","timestamp":-1},');
        for (let i = 0; i < 39; i++) {
          const prefix = `{"role":"assistant","timestamp":${i},"content":"`;
          await fill(prefix, prefix.length + contentBytes);
          await write('"},');
          written += prefix.length + contentBytes + 3;
        }
        const tail = '"},' + captureTail;
        const giantStart = '{"role":"assistant","timestamp":99,"content":"';
        await fill(giantStart, 54 * 1024 * 1024 - written - Buffer.byteLength(tail));
        const bytes = Buffer.from(tail);
        const split = bytes.indexOf(0xf0) + 1;
        await write(bytes.subarray(0, split));
        await write(bytes.subarray(split));
      } else await write(captureTail);
      captureTail = undefined;
      await write(`\n${reply(id, { afterCapture: true })}`);
      break;
    }
    case "read_other_session": {
      if (!history || history.route !== "first" || sessionId !== "second") throw new Error("unexpected routes");
      const head = `{"type":"response","id":${JSON.stringify(history.id)},`;
      const start = `${head}"command":"get_messages","success":true,"data":{"messages":[`;
      const suffix = '{"role":"user","content":"最近 💡","timestamp":52}]},"sessionId":"first"}';
      const next = `\n${reply(id, { state: "second unchanged", writes })}{"type":"fixture_event","label":"drained"}\n`;
      if (history.mode === "capture-compat") {
        await write('{"data":{"messages":[{"role":"user","content":"legacy"}]},"command":"get_messages",' +
          `"type":"response","id":"${history.id}","success":true}` + next);
        break;
      }
      await write(head.slice(0, 12));
      if (history.mode === "capture-eviction") {
        const rows = Array.from({ length: 245 }, (_, timestamp) => ({ role: "assistant", content: "条 💡", timestamp }));
        const excluded = [null, { role: "custom", display: false, content: "hidden" }, { role: "unknown" }, { role: {} }];
        const hiddenGiant = '{"role":"custom","display":false,"content":"';
        await fill(start.slice(12) + hiddenGiant, start.length - 12 + hiddenGiant.length + 3 * 1024 * 1024);
        await write('"},' + JSON.stringify([...excluded, ...rows]).slice(1, -1) + ']}}' + next);
      } else if (history.mode === "capture-old-order") {
        await write(head.slice(12) + '"data":{"messages":[{"role":"user","content":"legacy"}]},' +
          '"success":true,"command":"get_messages"}' + next);
      } else if (history.mode === "capture-wrong-route" || history.mode === "capture-duplicate" || history.mode === "capture-refusal") {
        const closing = history.mode === "capture-wrong-route" ? ',"sessionId":"second"}'
          : history.mode === "capture-duplicate" ? `,"\\u0069d":"${history.id}"}` : ',"success":false}';
        const opening = history.mode === "capture-refusal" ? `${head}"command":"get_messages","data":{"messages":[` : start;
        await write(opening.slice(12) + '{"role":"user","content":"provisional"}]}' + closing + next);
      } else if (history.mode === "malformed") {
        await write(head.slice(12) + '"command":"get_messages","success":true,"data":{"messages":[]},"id":"foreign"}' + next);
      } else if (history.mode === "foreign") {
        await write(head.slice(12) + '"command":"get_state","success":true,"data":{"messages":[]}}' + next);
      } else if (history.mode === "wrong-route") {
        await write(head.slice(12) + '"command":"get_messages","success":true,"data":{"messages":[]},"sessionId":"second"}' + next);
      } else if (history.mode === "invalid-utf8") {
        await write(Buffer.concat([Buffer.from(start.slice(12) + '{"role":"user","content":"'), Buffer.from([0xff]),
          Buffer.from('"}]}}' + next)]));
      } else if (history.mode === "late") {
        await fill(start.slice(12) + '{"role":"user","content":"', 52 * 1024 * 1024);
        await write('"}]}}' + next);
      } else {
        const size = history.mode === "limit" ? 65 * 1024 * 1024 : 52 * 1024 * 1024;
        const prefix = start + '{"role":"assistant","content":"omitted-';
        // The ASCII prefix/padding + Unicode suffix form exactly `size` wire bytes.
        const tail = `"},${suffix}`;
        await fill(prefix.slice(12), size - 12 - Buffer.byteLength(tail));
        const bytes = Buffer.from(tail);
        const split = bytes.indexOf(0xf0) + 1;
        await write(bytes.subarray(0, split));
        await write(Buffer.concat([bytes.subarray(split), Buffer.from(next)]));
      }
      break;
    }
    case "ordinary_with_history_shape":
      await fill(`{"type":"response","id":${JSON.stringify(id)},"command":"get_messages","success":true,"data":{"messages":[{"role":"assistant","content":"`,
        limit + 1);
      await write('"}]}}\n');
      break;
    case "prompt":
      await write(reply(id, { writes: ++writes, sessionId }));
      break;
    case "finish_tree": {
      if (!oversized || !unrelated) throw new Error("fixture requests out of order");
      const following = reply(oversized, { duplicate: true }) + reply(unrelated, { state: "unchanged" }) + reply(id);
      const event = new TextEncoder().encode(' \t{"type":"fixture_event","label":"树"}\r\n');
      const split = event.indexOf(0xe6) + 1;
      utf8Tail = event.slice(split);
      await write('"},"sessionId":"fixture"}\n' + following);
      await write(event.slice(0, split));
      break;
    }
    case "finish_event":
      await write(utf8Tail);
      await write(reply(id, { next: true }));
      break;
    case "release_late":
      await fill(`{"type":"response","id":${JSON.stringify(oversized)},"success":true,"data":{"tree":"`, limit);
      await write(`xxx"}}\n${reply(id, { afterLateReply: true })}`);
      break;
    case "at_cap": {
      const suffix = '"},"data":{"exact":true}}\r';
      await fill(`{"type":"response","id":${JSON.stringify(id)},"success":true,"padding":{"s":"树💡`, limit - suffix.length);
      await write(suffix + "\n");
      break;
    }
    case "nested_id":
      await fill(`{"type":"fixture_event","data":{"type":"response","id":${JSON.stringify(id)},"text":"`, limit + 1);
      await write('"}}\n' + reply(id));
      break;
    case "unissued_id":
      await fill('{"type":"response","id":"web-999999","data":"', limit + 1);
      await write('"}\n' + reply(id));
      break;
    case "malformed":
      await write(' \t{"type":"response",,}\n' + reply(id));
      break;
    default:
      await write(reply(id));
  }
}
