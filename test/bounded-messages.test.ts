import { expect, test } from "bun:test";
import { BoundedMessagesFrame, isMessagesResponsePrefix, MESSAGE_PREFIX_LIMIT } from "../src/bounded-messages.ts";
import { WebError } from "../src/protocol.ts";

const id = "web-12";
const start = `{"id":"${id}","type":"response","command":"get_messages","success":true,"data":{"messages":[`;
const end = "]}}";
const encode = new TextEncoder();
const miB = 1024 * 1024;

function receipt(line: string, surface: "web" | "terminal" = "web"): unknown {
  const frame = new BoundedMessagesFrame(id, surface);
  frame.write(line);
  return frame.finish().data;
}

function expectError(run: () => unknown, code: string) {
  try {
    run();
    throw new Error("expected a frame error");
  } catch (error) {
    expect(error).toBeInstanceOf(WebError);
    expect(error).toHaveProperty("code", code);
  }
}

test("probes the bounded leading response identity in either order without finding nested lookalikes", () => {
  for (const prefix of [
    start, ` \r\t{ "type" : "response", "id":"${id}",`, '{"t\\u0079pe":"response","id":"web-1\\u0032",',
  ]) expect(isMessagesResponsePrefix(prefix, id)).toBe(true);
  for (const prefix of [
    start.replace(id, "web-123"), start.slice(0, start.indexOf('"response"') + 6),
    `{"event":${start}`, `{"id":"${id}","type":"message_end","data":${start}`,
    " ".repeat(MESSAGE_PREFIX_LIMIT) + start,
  ]) expect(isMessagesResponsePrefix(prefix, id)).toBe(false);
});

test("retains JSON.parse values through one-byte UTF-8 and one-code-unit text splits", () => {
  const line = ` \t{"type":"response","id":"${id}","data":{"messages":[` +
    String.raw`{"timestamp":-0,"usage":{"fraction":-12.7e-9,"integer":9007199254740993,"overflow":1e999,"__proto__":{"native":true}},"content":[{"type":"text","text":"${"中😀"}\n\"\\\ud800\u0000\uD83D\uDe42"}],"role":"assistant"}]}` +
    ',"command":"get_messages","success":true}\r';
  const byteFrame = new BoundedMessagesFrame(id, "web");
  for (const [offset, byte] of encode.encode(line).entries()) {
    try { byteFrame.write(Uint8Array.of(byte)); }
    catch (error) { throw new Error(`rejected valid synthetic UTF-8 at offset ${offset}`, { cause: error }); }
  }
  const textFrame = new BoundedMessagesFrame(id, "web");
  for (let i = 0; i < line.length; i++) textFrame.write(line[i] ?? "");
  const [expected]: unknown[] = [JSON.parse(line.replace('"messages":[', '"historyTruncated":false,"messages":['))];
  for (const frame of [byteFrame, textFrame]) {
    expect<unknown>(frame.finish()).toEqual(expected);
  }
  expect(expected).toHaveProperty("data.messages.0.usage.overflow", Infinity);
});

test("accepts empty history and preserves a genuine Native refusal, not its data or private diagnostic", () => {
  expect(receipt(start + end)).toEqual({ messages: [], historyTruncated: false });
  const frame = new BoundedMessagesFrame(id, "terminal");
  frame.write(`{"id":"${id}","type":"response","command":"get_messages","success":false,` +
    '"errorCode":"session_not_attached","error":"synthetic private diagnostic","data":{"messages":[{"role":"user","content":"discard"}]}}');
  expect(frame.finish()).toEqual({ id, type: "response", command: "get_messages", success: false, errorCode: "session_not_attached" });
});

test.each([
  ["foreign id", start.replace(id, "web-99") + end],
  ["foreign command", start.replace("get_messages", "get_state") + end],
  ["truncated document", start + "]"],
  ["truncated value", start + '{"role":"user","content":"partial'],
  ["second document", start + end + "{}"],
  ["no actual messages", `{"id":"${id}","type":"response","command":"get_messages","success":true,"data":{"other":{"messages":[]}}}`],
  ["non-array messages", start.replace("[", "{}") + "}}"],
  ["duplicate decoded id", start + `]},"\\u0069d":"${id}"}`],
  ["duplicate messages", start + '],"\\u006dessages":[]}}'],
  ["duplicate data", start + ']},"data":{"messages":[]}}'],
  ["duplicate success", start + ']},"success":true}'],
  ["unordered nested spoof", `{"other":${start + end}}`],
  ["invalid discarded string", start + String.raw`{"role":"hidden","content":"bad\q"}` + end],
  ["invalid discarded number", start + '{"role":"hidden","content":-03}' + end],
  ["unclosed exponent", start + '{"role":"hidden","content":1e+}' + end],
  ["trailing array comma", start + '{},' + end],
  ["trailing object comma", start + '{"role":"hidden",}' + end],
  ["trailing non-JSON whitespace", start + end + "\u00a0"],
])("does not publish a %s response", (_name, line) => {
  expectError(() => receipt(line), "messages_frame_malformed");
});

test("ignores nested lookalikes without treating them as duplicate direct fields", () => {
  const line = start + '{"role":"user","content":"visible"}' +
    '],"other":{"messages":[],"id":"foreign"}},"other":{"id":"foreign","type":"response","data":{"messages":[]}}}';
  expect(receipt(line)).toEqual({ messages: [{ role: "user", content: "visible" }], historyTruncated: false });
});

test("rejects invalid physical UTF-8 rather than replacing it with publishable text", () => {
  expectError(() => {
    const frame = new BoundedMessagesFrame(id, "web");
    frame.write(encode.encode(start + '{"role":"user","content":"'));
    frame.write(Uint8Array.of(0xe2, 0x28, 0xa1));
    frame.write(encode.encode('"}' + end));
    frame.finish();
  }, "messages_frame_malformed");
});

test("streams the 54,288,960-byte / 47-message shape and retains only the latest byte-bounded window", () => {
  const frame = new BoundedMessagesFrame(id, "web");
  let bytes = 0;
  const send = (part: Uint8Array) => { bytes += part.length; frame.write(part); };
  const slab = encode.encode("a".repeat(4096));
  const oldRows = 44;
  const prefix = (i: number) => encode.encode(`{"timestamp":${i},"role":"user","content":"`);
  const latest = Array.from({ length: 3 }, (_, i) => ({ role: "assistant", content: `latest-${i}` }));
  const suffix = encode.encode(JSON.stringify(latest).slice(1, -1) + end);
  let remaining = 54_288_960 - start.length - suffix.length;
  for (let i = 0; i < oldRows; i++) remaining -= prefix(i).length + 3;
  send(encode.encode(start));
  for (let i = 0; i < oldRows; i++) {
    send(prefix(i));
    const payload = Math.floor(remaining / (oldRows - i));
    remaining -= payload;
    for (let offset = 0; offset < payload; offset += slab.length) send(slab.subarray(0, Math.min(slab.length, payload - offset)));
    send(encode.encode('"},'));
  }
  send(suffix);
  expect(bytes).toBe(54_288_960);
  const data = frame.finish().data;
  if (typeof data !== "object" || !data || !("messages" in data) || !Array.isArray(data.messages)) throw new Error("missing messages");
  expect(data).toHaveProperty("historyTruncated", true);
  expect(data.messages.map((m: { timestamp?: number; content: string }) => m.timestamp ?? m.content))
    .toEqual([40, 41, 42, 43, "latest-0", "latest-1", "latest-2"]);
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(5 * miB);
});

test("bounds the recent row count independently of small wire bytes", () => {
  const rows = Array.from({ length: 600 }, (_, timestamp) => ({ role: "user", content: "a", timestamp }));
  const line = start + JSON.stringify(rows).slice(1, -1) + end;
  expect(receipt(line)).toEqual({ messages: rows.slice(-240), historyTruncated: true });
  expect(receipt(line, "terminal")).toEqual({ messages: rows.slice(-100), historyTruncated: true });
});

test("skips a giant directly visible row even when role follows the payload, without leaking hidden context", () => {
  const frame = new BoundedMessagesFrame(id, "web");
  frame.write(start + '{"content":"');
  const slab = "é".repeat(8192);
  for (let i = 0; i < 400; i++) frame.write(slab);
  frame.write('","role":"assistant"},{"display":false,"role":"custom","content":"private"},' +
    '{"role":"assistant","content":"latest"}' + end);
  expect(frame.finish().data).toEqual({ messages: [{ role: "assistant", content: "latest" }], historyTruncated: true });
});

test("filters invisible CLI roles and empty non-text assistant rows before allocating the CLI window", () => {
  const publicDelivery = { role: "custom", display: true, customType: "session_control_delivery", content: "fallback",
    details: { delivery_id: "synthetic", source: "session_control", deliverAs: "steer", display_text: "delivery", sender: { kind: "command_line" } } };
  const oldest = { role: "user", content: "first" };
  const irrelevant = [
    { role: "toolResult", content: "tool" },
    { role: "bashExecution", output: "bash" },
    { role: "custom", display: false, customType: "session_control_delivery", content: "private" },
    { role: "custom", display: true, customType: "other", content: "web only" },
    { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] },
  ];
  const line = start + JSON.stringify([oldest, ...Array.from({ length: 115 }, () => irrelevant).flat(), publicDelivery]).slice(1, -1) + end;
  expect(receipt(line, "terminal")).toEqual({ messages: [oldest, publicDelivery], historyTruncated: false });
});

test("bounds CLI raw history bytes independently of its count and plain-text budgets", () => {
  const content = "x".repeat(180 * 1024);
  const rows = Array.from({ length: 6 }, (_, timestamp) => ({ role: "user", timestamp, content }));
  const frame = new BoundedMessagesFrame(id, "terminal");
  frame.write(start);
  for (const [i, row] of rows.entries()) frame.write((i === 0 ? "" : ",") + JSON.stringify(row));
  frame.write(end);
  expect(frame.finish().data).toEqual({ messages: rows.slice(-4), historyTruncated: true });
});

test("enforces 64 MiB of physical input independently of decoded output and syntax depth", () => {
  const frame = new BoundedMessagesFrame(id, "web");
  const document = encode.encode(start + end);
  frame.write(document);
  const slab = encode.encode(" ".repeat(8192));
  const tail = 64 * miB - document.length;
  for (let i = 0; i < tail; i += slab.length) frame.write(slab.subarray(0, Math.min(slab.length, tail - i)));
  expect(frame.finish().data).toEqual({ messages: [], historyTruncated: false });
  const overflow = new BoundedMessagesFrame(id, "web");
  overflow.write(document);
  for (let i = 0; i < tail; i += slab.length) overflow.write(slab.subarray(0, Math.min(slab.length, tail - i)));
  expectError(() => overflow.write(Uint8Array.of(32)), "messages_read_limit");
});

test("reports depth and token-work pressure differently from malformed frames", () => {
  expectError(() => receipt(start + "[".repeat(80) + "0" + "]".repeat(80) + end), "messages_read_limit");
  const slab = "0,".repeat(4096);
  expectError(() => {
    const frame = new BoundedMessagesFrame(id, "web");
    frame.write(start);
    for (let i = 0; i < 160; i++) frame.write(slab);
    frame.write("0" + end);
    frame.finish();
  }, "messages_read_limit");
});
