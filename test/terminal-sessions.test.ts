import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TerminalSessions } from "../src/terminal-sessions.ts";
import { terminalFixture, transcriptPadding, writeLargeTerminalTranscript, writeTerminalBytes } from "./terminal-socket-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { readonly fallback?: boolean } = {}) {
  const native = await terminalFixture(options);
  cleanups.push(() => native.close());
  const changes: string[] = [];
  let notify: ((id: string) => void) | undefined;
  const adapter = new TerminalSessions(native.agentDir, [native.cwd], id => {
    changes.push(id);
    notify?.(id);
  });
  cleanups.push(() => adapter.stop());
  const nextChange = () => {
    const event = Promise.withResolvers<string>();
    notify = event.resolve;
    return event.promise;
  };
  const discover = async () => {
    const { available, sessions } = await adapter.list();
    expect(available).toBe(true);
    expect(sessions).toHaveLength(1);
    const selected = sessions[0];
    if (selected === undefined) throw new Error("Missing owned terminal session");
    return selected;
  };
  return { ...native, adapter, changes, nextChange, discover };
}

test("discovers only the authorized canonical workspace and one corroborated native TUI row", async () => {
  const f = await setup();
  const session = await f.discover();
  expect(session).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: "Fixture TUI", cwd: f.cwd, running: false, attached: false });
  expect(session.id).not.toContain(f.state.durable);
  expect(await f.discover()).toEqual(session);
  expect(f.state.acceptedSecrets).toBe(2);
  expect(f.trace.every(request => ["get_protocol_info", "list_sessions", "get_state"].includes(String(request.type)))).toBe(true);

  const other = join(f.cwd, "child");
  await mkdir(other);
  f.state.cwd = other;
  expect((await f.adapter.list()).sessions).toEqual([]);
  f.state.cwd = join(dirname(f.cwd), "workspace-alias");
  await symlink(f.cwd, f.state.cwd);
  expect((await f.adapter.list()).sessions).toEqual([]);
  f.state.cwd = f.cwd;
  f.state.extraRow = true;
  expect((await f.adapter.list()).sessions).toEqual([]);
  f.state.extraRow = false;
  f.state.rowDurable = "stale-route";
  expect((await f.adapter.list()).sessions).toEqual([]);
  f.state.rowDurable = undefined;
  f.state.wrongInstance = true;
  expect((await f.adapter.list()).sessions).toEqual([]);
});

test("requires explicit fenced attachment and emits an opaque invalidation for each side's visible changes", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await expect(f.adapter.snapshot(id)).rejects.toMatchObject({ code: "terminal_not_attached" });
  await expect(f.adapter.input(id, { message: "no attachment", mode: "prompt", clientMessageId: "before" }))
    .rejects.toMatchObject({ code: "terminal_not_attached" });
  const attached = await f.adapter.attach(id);
  expect(attached.session.attached).toBe(true);
  expect(f.trace.filter(row => row.type === "attach_session")).toHaveLength(1);
  expect(f.trace.filter(row => row.type === "set_client_info").map(row => row.capabilities)).toEqual([[]]);

  const cliChanged = f.nextChange();
  f.emit("extension_ui_request", { title: "fixture-private" });
  f.state.messages.push(
    { role: "user", content: "CLI prompt" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "fixture-private" }, { type: "text", text: "\x1b[31mCLI answer\x1b[0m" },
      { type: "toolCall", name: "fixture-private" }, { type: "image", data: "fixture-private" },
    ], errorMessage: "fixture-private" },
    { role: "toolResult", content: "fixture-private" },
    { role: "custom", customType: "other", display: true, content: "fixture-private" },
    { role: "custom", customType: "session_control_delivery", display: false, content: "fixture-private" },
    { role: "custom", customType: "session_control_delivery", display: true, content: "fixture-private",
      details: { delivery_id: "fixture-delivery", source: "session_control", deliverAs: "steer",
        sender: { kind: "external", platform: "rpc" }, display_text: "visible remote excerpt" } },
  );
  f.emit("message_end", { message: f.state.messages[1] });
  expect(await cliChanged).toBe(id);
  const snap = await f.adapter.snapshot(id);
  expect(snap.state).toEqual({ running: false, turnId: null, compacting: false });
  expect(snap.messages).toEqual([
    { role: "user", content: "CLI prompt" },
    { role: "assistant", content: "CLI answer" },
    { role: "custom", customType: "session_control_delivery", content: "visible remote excerpt" },
  ]);
  expect(JSON.stringify(snap)).not.toContain("fixture-private");

  const webChanged = f.nextChange();
  expect(await f.adapter.input(id, { message: "Web prompt", mode: "prompt", clientMessageId: "web-1" }))
    .toEqual({ disposition: "started", clientMessageId: "web-1", duplicate: false });
  expect(await webChanged).toBe(id);
  const updated = await f.adapter.snapshot(id);
  expect(updated.state).toEqual({ running: true, turnId: "1", compacting: false });
  expect(updated.messages.at(-1)).toEqual({
    role: "custom", customType: "session_control_delivery", content: "Web prompt",
  });
  expect(f.changes.every(value => value === id)).toBe(true);
  expect(f.state.acceptedSecrets).toBe(2);
});

test("returns only a stable native leaf from a quiet attached terminal", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await expect(f.adapter.branchIdentity(id)).rejects.toMatchObject({ code: "terminal_not_attached" });
  await f.adapter.attach(id);
  expect(await f.adapter.branchIdentity(id)).toEqual({ cwd: f.cwd, nativeSessionId: f.state.durable, leafId: "active-leaf" });
  f.state.running = true;
  await expect(f.adapter.branchIdentity(id)).rejects.toMatchObject({ code: "terminal_busy" });
  f.state.running = false;
  f.state.leafId = null;
  await expect(f.adapter.branchIdentity(id)).rejects.toMatchObject({ code: "terminal_leaf_unavailable" });
  f.state.leafId = "first";
  f.state.unstableLeaf = true;
  await expect(f.adapter.branchIdentity(id)).rejects.toMatchObject({ code: "terminal_leaf_unavailable" });
});

test("shows only exact-session assistant text while streaming, then replaces it with the settled transcript", async () => {
  const f = await setup();
  f.state.running = true;
  f.state.turn = 1;
  const { id } = await f.discover();
  await f.adapter.attach(id);

  const delta = f.nextChange();
  f.emit("message_update", { message: { role: "assistant", timestamp: 42, content: [
    { type: "text", text: "partial answer" }, { type: "thinking", thinking: "fixture-private" },
  ] } });
  expect(await delta).toBe(id);
  expect((await f.adapter.snapshot(id)).messages).toEqual([
    { role: "assistant", content: "partial answer", timestamp: 42, streaming: true },
  ]);

  const settled = f.nextChange();
  const final = { role: "assistant", content: "partial answer finished", timestamp: 42 } as const;
  f.state.messages = [final];
  f.emit("message_end", { message: final });
  expect(await settled).toBe(id);
  expect((await f.adapter.snapshot(id)).messages).toEqual([final]);
});

test("maps turn tokens and keeps duplicate receipts stable while a prompt is busy", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  const prompt = { message: "first", mode: "prompt", clientMessageId: "first" } as const;
  await f.adapter.input(id, prompt);
  expect(await f.adapter.input(id, prompt)).toEqual({ disposition: "started", clientMessageId: "first", duplicate: true });
  await expect(f.adapter.input(id, { ...prompt, message: "different" })).rejects.toMatchObject({ code: "client_message_id_conflict" });
  await expect(f.adapter.input(id, { message: "steering", mode: "steer", clientMessageId: "steer-1", expectedTurnId: "1" }))
    .rejects.toMatchObject({ code: "turn_conflict" });
  await f.adapter.snapshot(id);
  expect(await f.adapter.input(id, { message: "steering", mode: "steer", clientMessageId: "steer-1", expectedTurnId: "1" }))
    .toEqual({ disposition: "queued", clientMessageId: "steer-1", duplicate: false });
  await f.adapter.input(id, { message: "next", mode: "follow_up", clientMessageId: "next" });
  expect(f.delivered.map(row => [row.type, row.expected_turn_id, row.whenIdle])).toEqual([
    ["prompt", 0, undefined], ["steer", 1, "queue"], ["follow_up", 1, "queue"],
  ]);
  expect(f.trace.filter(row => row.type === "prompt")).toHaveLength(1);
});

test("keeps an uncertain admission from being resent and never forwards native refusal text", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  const input = { message: "input", mode: "prompt", clientMessageId: "same" } as const;
  f.state.refusal = "held_draft";
  try {
    await f.adapter.input(id, input);
    throw new Error("Expected terminal refusal");
  } catch (error) {
    expect(error).toMatchObject({ code: "held_draft" });
    expect(String(error)).not.toContain("fixture-private");
  }
  f.state.refusal = "";
  f.state.noInputResponse = true;
  await expect(f.adapter.input(id, input)).rejects.toMatchObject({ code: "terminal_outcome_unknown" });
  await f.adapter.attach(id);
  await expect(f.adapter.input(id, input)).rejects.toMatchObject({ code: "terminal_outcome_unknown" });
  expect(f.trace.filter(row => row.type === "prompt")).toHaveLength(2);
  expect(f.delivered).toHaveLength(1);
});

test("interrupts only an observed still-current turn and releases only the Web attachment", async () => {
  const f = await setup();
  f.state.running = true;
  f.state.turn = 5;
  const { id } = await f.discover();
  await f.adapter.attach(id);
  await expect(f.adapter.interrupt(id, "4")).rejects.toMatchObject({ code: "turn_conflict" });
  expect(f.trace.filter(row => row.type === "interrupt")).toHaveLength(0);
  f.state.raceTurn = true;
  await expect(f.adapter.interrupt(id, "5")).rejects.toMatchObject({ code: "turn_conflict" });
  expect(f.state.interrupted).toBe(0);
  expect(f.state.running).toBe(true);
  f.state.raceTurn = false;
  await f.adapter.snapshot(id);
  expect(await f.adapter.interrupt(id, "6")).toEqual({ interrupted: true, turnId: "6" });
  expect(f.state.interrupted).toBe(1);
  expect(f.trace.filter(row => row.type === "interrupt").map(row => row.turnId)).toEqual(["5", "6"]);
  f.state.running = true;
  expect(await f.adapter.detach(id)).toEqual({ detached: true });
  expect(f.state.running).toBe(true);
  expect(f.trace.filter(row => row.type === "release_attachment")).toHaveLength(1);
  expect(f.trace.filter(row => ["abort", "close_session", "park_session", "claim_session"].includes(String(row.type)))).toEqual([]);
  expect((await f.discover()).attached).toBe(false);
});

test("retired native identities never receive writes through an already attached socket", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  f.state.durable = "replacement-durable";
  await expect(f.adapter.input(id, { message: "stale", mode: "prompt", clientMessageId: "stale" }))
    .rejects.toMatchObject({ code: "terminal_not_found" });
  expect(f.delivered).toEqual([]);
  expect((await f.discover()).id).not.toBe(id);
});

test("rotated registry and unsafe socket paths fail closed before sending more secret bytes", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  await rename(f.pointer, `${f.pointer}.old`);
  await writeFile(f.pointer, await Bun.file(`${f.pointer}.old`).text(), { mode: 0o600 });
  await expect(f.adapter.input(id, { message: "stale", mode: "prompt", clientMessageId: "rotate" }))
    .rejects.toMatchObject({ code: "terminal_not_found" });
  expect(f.delivered).toEqual([]);
  const accepted = f.state.acceptedSecrets;
  await chmod(f.socket, 0o660);
  expect((await f.adapter.list()).sessions).toEqual([]);
  await chmod(f.socket, 0o600);
  await rename(`${f.socket}.secret`, `${f.socket}.secret.actual`);
  await symlink(`${f.socket}.secret.actual`, `${f.socket}.secret`);
  expect((await f.adapter.list()).sessions).toEqual([]);
  expect(f.state.acceptedSecrets).toBe(accepted);
});

test("does not try a different auth mode or accept competing generation records", async () => {
  const f = await setup();
  const secret = `${f.socket}.secret`;
  await writeFile(secret, Buffer.alloc(32));
  expect(await f.adapter.list()).toEqual({ available: true, sessions: [] });
  expect(f.state.acceptedSecrets).toBe(0);
  expect(f.trace).toEqual([]);

  await writeFile(secret, f.secret);
  await mkdir(join(dirname(f.generation), "unexpected-generation"), { mode: 0o700 });
  expect((await f.adapter.list()).sessions).toEqual([]);
  expect(f.state.acceptedSecrets).toBe(0);
});

test("accepts only the private long-path fallback belonging to the configured profile", async () => {
  const f = await setup({ fallback: true });
  await f.discover();
  await chmod(dirname(dirname(f.socket)), 0o755);
  expect((await f.adapter.list()).sessions).toEqual([]);
  expect(f.state.acceptedSecrets).toBe(1);
});

test("bounds untrusted registry and wire reads and degrades when no profile is configured", async () => {
  expect(await new TerminalSessions(undefined, [], () => {}).list()).toEqual({ available: false, sessions: [] });
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  f.state.oversized = true;
  await expect(f.adapter.snapshot(id)).rejects.toMatchObject({ code: "terminal_read_limit" });
  await writeFile(f.manifest, " ".repeat(20_000) + JSON.stringify(f.registration));
  expect((await f.adapter.list()).sessions).toEqual([]);
  expect(f.state.acceptedSecrets).toBe(2);
});

test("attaches across a valid native-like transcript over the generic limit", async () => {
  const f = await setup();
  const { id } = await f.discover();
  f.state.messagesReply = writeLargeTerminalTranscript;
  const snapshot = await f.adapter.attach(id);
  expect(snapshot.session.attached).toBe(true);
  expect(snapshot.transcript).toEqual({ status: "truncated" });
  expect(snapshot.messages).toEqual([{ role: "assistant", content: "近况 🐋", timestamp: 42 }]);
  expect(f.trace.filter(row => row.type === "get_messages")).toHaveLength(1);
});

test("reports rows trimmed to make room for verified live text and never splits a surrogate pair", async () => {
  const f = await setup();
  const { id } = await f.discover();
  f.state.running = true;
  f.state.messages = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `row ${i}` }));
  const initial = await f.adapter.attach(id);
  expect(initial.transcript).toBeUndefined();
  expect(initial.messages).toHaveLength(100);
  const changed = f.nextChange();
  f.emit("message_update", { message: { role: "assistant", content: "live 🐋", timestamp: 1 } });
  await changed;
  const live = await f.adapter.snapshot(id);
  expect(live.transcript).toEqual({ status: "truncated" });
  expect(live.messages).toHaveLength(100);
  expect(live.messages[0]?.content).toBe("row 1");
  expect(live.messages.at(-1)).toMatchObject({ content: "live 🐋", streaming: true });

  f.state.running = false;
  f.state.messages = [{ role: "assistant", content: `${"x".repeat(15_999)}🐋` }];
  const settled = await f.adapter.snapshot(id);
  expect(settled.transcript).toEqual({ status: "truncated" });
  expect(settled.messages[0]?.content).toBe("x".repeat(15_999));
});

test("drains the known transcript past the parser byte ceiling and sends one explicit input on the same attachment", async () => {
  const f = await setup();
  const { id } = await f.discover();
  f.state.messagesReply = (peer, requestId) => writeLargeTerminalTranscript(peer, requestId, 1024);
  expect(await f.adapter.attach(id)).toMatchObject({
    session: { attached: true }, state: { running: false }, transcript: { status: "unavailable" }, messages: [],
  });
  const input = { message: "明示输入 🐋", mode: "prompt", clientMessageId: "after-read-cap" } as const;
  expect(await f.adapter.input(id, input)).toEqual({ disposition: "started", clientMessageId: input.clientMessageId, duplicate: false });
  expect(await f.adapter.input(id, input)).toEqual({ disposition: "started", clientMessageId: input.clientMessageId, duplicate: true });
  expect(f.delivered.map(row => row.message)).toEqual([input.message]);
  expect(f.trace.filter(row => ["get_messages", "attach_session", "prompt"].includes(String(row.type))).map(row => row.type))
    .toEqual(["attach_session", "get_messages", "prompt"]);
  expect(f.state.acceptedSecrets).toBe(2); // One discovery observer, one attached control peer.
});

test.each([
  ["foreign large response", "terminal_read_limit"],
  ["oversized event", "terminal_read_limit"],
  ["wrong command with matching id", "terminal_protocol"],
  ["wrong command before the transcript work limit", "terminal_protocol"],
  ["duplicate id", "terminal_protocol"],
  ["closed during a matched frame", "terminal_offline"],
] as const)("preserves fail-closed behavior for a %s", async (caseName, code) => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  f.state.messagesReply = async (peer, requestId) => {
    if (caseName === "foreign large response") return writeLargeTerminalTranscript(peer, "foreign");
    if (caseName === "oversized event") {
      await writeTerminalBytes(peer, '{"type":"message_update","payload":"');
      for (let i = 0; i < 35; i++) await writeTerminalBytes(peer, transcriptPadding);
      await writeTerminalBytes(peer, '"}\n');
      return;
    }
    const prefix = `{"type":"response","id":${JSON.stringify(requestId)},`;
    if (caseName === "closed during a matched frame") {
      await writeTerminalBytes(peer, prefix + `"command":"get_messages","success":true,"data":{"messages":[`);
      peer.end();
    } else if (caseName === "wrong command with matching id") {
      await writeTerminalBytes(peer, prefix + `"command":"get_state","success":true,"data":{"messages":[]}}\n`);
    } else if (caseName === "wrong command before the transcript work limit") {
      await writeTerminalBytes(peer, prefix + `"command":"get_state","success":true,"data":${"[".repeat(70)}0${"]".repeat(70)}}\n`);
    } else {
      await writeTerminalBytes(peer, prefix + `"id":"foreign","command":"get_messages","success":true,"data":{"messages":[]}}\n`);
    }
  };
  await expect(f.adapter.snapshot(id)).rejects.toMatchObject({ code });
  await expect(f.adapter.input(id, { message: "not sent", mode: "prompt", clientMessageId: "closed" }))
    .rejects.toMatchObject({ code: "terminal_not_attached" });
  expect(f.delivered).toEqual([]);
  expect(f.state.acceptedSecrets).toBe(2);
});

test("keeps a draining read pending beyond the generic timeout and rejects a drain that never realigns", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  const started = Promise.withResolvers<void>();
  f.state.messagesReply = async (peer, requestId) => {
    await writeTerminalBytes(peer, `{"id":${JSON.stringify(requestId)},"type":"response","command":"get_messages","data":${"[".repeat(70)}`);
    started.resolve();
  };
  const read = f.adapter.snapshot(id);
  let settled = false;
  const markSettled = () => { settled = true; };
  void read.then(markSettled, markSettled);
  await started.promise;
  await Bun.sleep(1_650);
  expect(settled).toBe(false);
  const control = expect(f.adapter.input(id, { message: "not sent", mode: "prompt", clientMessageId: "draining" }))
    .rejects.toMatchObject({ code: "terminal_offline" });
  await expect(read).rejects.toMatchObject({ code: "terminal_timeout" });
  await control;
  expect(f.trace.filter(row => ["attach_session", "prompt"].includes(String(row.type))).map(row => row.type)).toEqual(["attach_session"]);
}, 7_000);

test("rejects command and attachment input instead of expanding the native RPC allowlist", async () => {
  const f = await setup();
  const { id } = await f.discover();
  await f.adapter.attach(id);
  const input = { message: "message", mode: "prompt", clientMessageId: "unsafe" } as const;
  const requestWithAttachment = { ...input, images: [{ type: "image", data: "fixture-private" }] };
  await expect(f.adapter.input(id, requestWithAttachment)).rejects.toMatchObject({ code: "terminal_invalid_input" });
  await expect(f.adapter.input(id, { ...input, message: " /quit " })).rejects.toMatchObject({ code: "terminal_invalid_input" });
  expect(f.trace.filter(row => row.type === "prompt")).toEqual([]);
  expect(f.state.running).toBe(false);
});
