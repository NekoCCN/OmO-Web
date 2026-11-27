import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_HISTORY_LIMITS, CliHistory } from "../src/cli-history.ts";
import { WebError } from "../src/protocol.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

const sessionDirName = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const iso = "2026-11-20T00:00:00.000Z";

function header(id: string, cwd: string): string {
  return line({ type: "session", version: 3, id, timestamp: iso, cwd });
}

function msg(id: string, parentId: string | null, role: string, text: string): string {
  return line({ type: "message", id, parentId, timestamp: iso,
    message: { role, content: [{ type: "text", text }], timestamp: 1_700_000_000_000 } });
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "omo-cli-history-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const agentDir = join(base, "agent");
  const ws = join(base, "proj");
  await mkdir(join(agentDir, "sessions", sessionDirName(ws)), { recursive: true });
  await mkdir(ws, { recursive: true });
  return { base, agentDir, ws };
}

async function writeSession(agentDir: string, ws: string, file: string, lines: string, mtimeMs: number) {
  const path = join(agentDir, "sessions", sessionDirName(ws), file);
  await writeFile(path, lines);
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

async function namedFixture() {
  const { agentDir, ws } = await setup();
  const t0 = 1_700_000_000_000;
  await writeSession(agentDir, ws, "2026-11-20T00-00-00-000Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl",
    header("aaaaaaaa-1111-4111-8111-111111111111", ws) +
    msg("m1", null, "user", "hello") +
    msg("m2", "m1", "assistant", "hi") +
    line({ type: "session_info", id: "s1", parentId: "m2", timestamp: iso, name: "Named" }),
    t0 + 2000);
  await writeSession(agentDir, ws, "2026-11-20T00-00-01-000Z_bbbbbbbb-2222-4222-8222-222222222222.jsonl",
    header("bbbbbbbb-2222-4222-8222-222222222222", ws) +
    msg("n1", null, "user", "untitled hello"),
    t0 + 1000);
  return { agentDir, ws };
}

async function branchedFixture() {
  const { agentDir, ws } = await setup();
  const id = "cccccccc-3333-4333-8333-333333333333";
  const body =
    header(id, ws) +
    msg("m1", null, "user", "root") +
    msg("m2", "m1", "assistant", "base") +
    line({ type: "compaction", id: "c1", parentId: "m2", timestamp: iso,
      summary: "older work", firstKeptEntryId: "m1", tokensBefore: 10 }) +
    msg("m3a", "m2", "user", "branch A") +
    line({ type: "usage", id: "u1", parentId: "m3a", timestamp: iso, kind: "cache_warm",
      provider: "p", model: "m", usage: { totalTokens: 5 } }) +
    msg("m3b", "c1", "user", "branch B") +
    line({ type: "custom_message", id: "x1", parentId: "m3b", timestamp: iso,
      customType: "ext.secret", content: "credential.invalid private dialog", display: false, details: {} }) +
    line({ type: "custom", id: "x2", parentId: "x1", timestamp: iso, customType: "ext.state", data: { v: 1 } }) +
    line({ type: "message", id: "m4", parentId: "x2", timestamp: iso,
      message: { role: "custom", content: "no display flag", timestamp: 1_700_000_000_001 } }) +
    line({ type: "context_edit", id: "e1", parentId: "m4", timestamp: iso, targetId: "m1", replacement: "root edited" }) +
    line({ type: "context_edit", id: "e2", parentId: "e1", timestamp: iso, targetId: "m2", replacement: null }) +
    '{"type":"message","id":"cut';
  await writeSession(agentDir, ws, `2026-11-20T00-00-02-000Z_${id}.jsonl`, body, 1_700_000_002_000);
  return { agentDir, ws, id };
}

describe("CliHistory", () => {
  test("lists named and untitled sessions newest first without file paths", async () => {
    const { agentDir, ws } = await namedFixture();
    const history = new CliHistory(agentDir, [ws]);
    const result = await history.list();
    expect(result.available).toBe(true);
    expect(result.sessions.map(s => [s.id, s.name, s.cwd])).toEqual([
      ["aaaaaaaa-1111-4111-8111-111111111111", "Named", ws],
      ["bbbbbbbb-2222-4222-8222-222222222222", ws, ws],
    ]);
    expect(result.sessions.map(s => s.updatedAt)).toEqual([1_700_000_002_000, 1_700_000_001_000]);
    expect(JSON.stringify(result)).not.toContain(".jsonl");
    expect(JSON.stringify(result)).not.toContain(agentDir);
  });

  test("reads only the latest active branch, applies edits, and drops the partial tail", async () => {
    const { agentDir, ws, id } = await branchedFixture();
    const history = new CliHistory(agentDir, [ws]);
    const result = await history.read(id);
    expect(result.session).toMatchObject({ id, cwd: ws });
    const texts = result.messages.map(m => {
      const message = m as { role?: unknown; content?: unknown };
      const content = message.content;
      return [message.role, typeof content === "string" ? content : (content as { text?: unknown }[])?.[0]?.text];
    });
    expect(texts).toEqual([["user", "root edited"], ["user", "branch B"]]);
    expect(JSON.stringify(result)).not.toContain("branch A");
    expect(JSON.stringify(result)).not.toContain("credential.invalid");
    expect(JSON.stringify(result)).not.toContain("no display flag");
  });

  test("terminates on parent-id cycles instead of walking forever", async () => {
    const { agentDir, ws } = await setup();
    const id = "12121212-8888-4888-8888-888888888888";
    await writeSession(agentDir, ws, `2026-11-20T00-00-06-000Z_${id}.jsonl`,
      header(id, ws) +
      msg("za", "zb", "user", "cycle a") +
      msg("zb", "za", "user", "cycle b"),
      1_700_000_006_000);
    const result = await new CliHistory(agentDir, [ws]).read(id);
    expect(result.messages.map(m => (m as { content?: { text?: unknown }[] }).content?.[0]?.text))
      .toEqual(["cycle a", "cycle b"]);
  });

  test("excludes transcripts from unconfigured workspaces and refuses their ids", async () => {
    const { agentDir, ws } = await setup();
    const other = join(ws, "..", "elsewhere");
    await mkdir(join(agentDir, "sessions", sessionDirName(other)), { recursive: true });
    const foreign = "dddddddd-4444-4444-8444-444444444444";
    await writeSession(agentDir, other, `2026-11-20T00-00-03-000Z_${foreign}.jsonl`,
      header(foreign, other) + msg("f1", null, "user", "elsewhere"), 1_700_000_003_000);
    const history = new CliHistory(agentDir, [ws]);
    expect((await history.list()).sessions).toEqual([]);
    const error = await history.read(foreign).catch(error => error);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).status).toBe(404);
  });

  test("skips symlinked files and directories without following them", async () => {
    const { agentDir, ws } = await namedFixture();
    const dir = join(agentDir, "sessions", sessionDirName(ws));
    await symlink(
      join(dir, "2026-11-20T00-00-00-000Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl"),
      join(dir, "2026-11-20T00-00-09-000Z_link.jsonl"));
    const outside = join(dir, "..", "outside-target");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(agentDir, "sessions", sessionDirName(`${ws}-alias`)));
    const history = new CliHistory(agentDir, [ws, `${ws}-alias`]);
    const result = await history.list();
    expect(result.sessions).toHaveLength(2);
    const reread = await history.read("aaaaaaaa-1111-4111-8111-111111111111");
    expect(reread.messages).toHaveLength(2);
  });

  test("rejects public ids that look like file paths", async () => {
    const { agentDir, ws } = await namedFixture();
    const history = new CliHistory(agentDir, [ws]);
    for (const bad of ["../sessions/x.jsonl", "/tmp/evil.jsonl", "a/b", "a\\b"]) {
      const error = await history.read(bad).catch(error => error);
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).status).toBe(400);
    }
    const filename = "2026-11-20T00-00-00-000Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl";
    const missing = await history.read(filename).catch(error => error);
    expect(missing).toBeInstanceOf(WebError);
    expect((missing as WebError).status).toBe(404);
  });

  test("reports unavailable when the agent directory is missing", async () => {
    const { ws } = await setup();
    const history = new CliHistory(join(ws, "no-such-agent"), [ws]);
    expect(await history.list()).toEqual({ available: false, sessions: [] });
    const error = await history.read("aaaaaaaa-1111-4111-8111-111111111111").catch(error => error);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).status).toBe(503);
  });

  test("throws a 404 WebError for unknown ids", async () => {
    const { agentDir, ws } = await namedFixture();
    const error = await new CliHistory(agentDir, [ws])
      .read("eeeeeeee-5555-4555-8555-555555555555").catch(error => error);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).status).toBe(404);
  });

  test("exposes INTERNAL native identity for same-history selection without paths", async () => {
    const { agentDir, ws } = await namedFixture();
    const history = new CliHistory(agentDir, [ws]);
    const listed = await history.list();
    const readBack = await history.read(listed.sessions[0].id);
    expect(readBack.internal.nativeSessionId).toBe(listed.sessions[0].id);
    expect(readBack.session).toMatchObject({ id: listed.sessions[0].id, cwd: ws });
    expect(JSON.stringify(readBack)).not.toContain(".jsonl");
    expect(JSON.stringify(readBack)).not.toContain(agentDir);
  });

  test("treats an undefined agent dir as an explicit opt-out", async () => {
    const { ws } = await setup();
    const history = new CliHistory(undefined, [ws]);
    expect(await history.list()).toEqual({ available: false, sessions: [] });
    const error = await history.read("aaaaaaaa-1111-4111-8111-111111111111").catch(error => error);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).status).toBe(503);
  });

  test("skips fifos without blocking the scan", async () => {
    const { agentDir, ws } = await namedFixture();
    const { $ } = await import("bun");
    await $`mkfifo ${join(agentDir, "sessions", sessionDirName(ws), "2026-11-20T00-00-07-000Z_fifo.jsonl")}`.quiet();
    expect((await new CliHistory(agentDir, [ws]).list()).sessions).toHaveLength(2);
  });

  test("bounds file sizes and message counts", async () => {
    const { agentDir, ws } = await setup();
    const big = "ffffffff-6666-4666-8666-666666666666";
    const filler = "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 64);
    await writeSession(agentDir, ws, `2026-11-20T00-00-04-000Z_${big}.jsonl`,
      header(big, ws) + msg("g1", null, "user", filler), 1_700_000_004_000);
    const history = new CliHistory(agentDir, [ws]);
    expect((await history.list()).sessions).toEqual([
      { id: big, name: ws, cwd: ws, updatedAt: 1_700_000_004_000 },
    ]);
    const tooLarge = await history.read(big).catch(error => error);
    expect(tooLarge).toBeInstanceOf(WebError);
    expect((tooLarge as WebError).status).toBe(400);

    const many = "99999999-7777-4777-8777-777777777777";
    let chain = header(many, ws);
    let parent: string | null = null;
    for (let index = 0; index < CLI_HISTORY_LIMITS.maxMessages + 50; index += 1) {
      const entry = `k${index}`;
      chain += msg(entry, parent, "user", `m${index}`);
      parent = entry;
    }
    await writeSession(agentDir, ws, `2026-11-20T00-00-05-000Z_${many}.jsonl`, chain, 1_700_000_005_000);
    const capped = await history.read(many);
    expect(capped.messages).toHaveLength(CLI_HISTORY_LIMITS.maxMessages);
    const texts = capped.messages.map(m =>
      (m as { content?: { text?: unknown }[] }).content?.[0]?.text);
    expect(texts[0]).toBe("m50");
    expect(texts.at(-1)).toBe(`m${CLI_HISTORY_LIMITS.maxMessages + 49}`);
  });
});

describe("CliHistory oversized journals", () => {
  const isoBig = "2026-11-20T00:00:00.000Z";
  const rename = (id: string, parentId: string | null, name: string) =>
    line({ type: "session_info", id, parentId, timestamp: isoBig, name });
  const tooLargeOf = async (history: CliHistory, id: string) =>
    history.read(id).catch(error => error);

  test("discovers oversized journals by bounded head scan and keeps full preview capped", async () => {
    const { agentDir, ws } = await setup();
    const t0 = 1_700_000_010_000;
    const id = "10101010-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const filler = "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 4096);
    await writeSession(agentDir, ws, `2026-11-20T00-00-10-000Z_${id}.jsonl`,
      header(id, ws) + rename("s1", null, "Big Early Title") + msg("m1", null, "user", filler), t0);
    const small = "20202020-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await writeSession(agentDir, ws, `2026-11-20T00-00-11-000Z_${small}.jsonl`,
      header(small, ws) + msg("n1", null, "user", "small hello"), t0 - 1000);
    const history = new CliHistory(agentDir, [ws]);
    const result = await history.list();
    expect(result.available).toBe(true);
    expect(result.sessions.find(session => session.id === id))
      .toMatchObject({ id, name: "Big Early Title", cwd: ws });
    expect(result.sessions.find(session => session.id === small))
      .toMatchObject({ id: small, name: ws, cwd: ws });
    const refused = await tooLargeOf(history, id);
    expect(refused).toBeInstanceOf(WebError);
    expect((refused as WebError).status).toBe(400);
    expect((refused as WebError).code).toBe("history_too_large");
    const reread = await history.read(small);
    expect(reread.messages).toHaveLength(1);
  });

  test("prefers the newest sampled rename from the tail window", async () => {
    const { agentDir, ws } = await setup();
    const t0 = 1_700_000_011_000;
    const id = "30303030-cccc-4ccc-8ccc-cccccccccccc";
    await writeSession(agentDir, ws, `2026-11-20T00-00-12-000Z_${id}.jsonl`,
      header(id, ws) + rename("s1", null, "Big Early Title") +
      msg("m1", null, "user", "a".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 64)) +
      rename("s2", "m1", "Big Renamed Title"), t0);
    const result = await new CliHistory(agentDir, [ws]).list();
    expect(result.sessions.find(session => session.id === id))
      .toMatchObject({ id, name: "Big Renamed Title", cwd: ws });
  });

  test("falls back to cwd when the only rename lies outside sampled windows", async () => {
    const { agentDir, ws } = await setup();
    const t0 = 1_700_000_012_000;
    const id = "40404040-dddd-4ddd-8ddd-dddddddddddd";
    await writeSession(agentDir, ws, `2026-11-20T00-00-13-000Z_${id}.jsonl`,
      header(id, ws) + msg("m1", null, "user", "a".repeat(4 * 1024 * 1024)) +
      rename("s1", "m1", "Middle Only Title") +
      msg("m2", "s1", "user", "b".repeat(4 * 1024 * 1024 + 4096)), t0);
    const result = await new CliHistory(agentDir, [ws]).list();
    expect(result.sessions.find(session => session.id === id))
      .toMatchObject({ id, name: ws, cwd: ws });
  });

  test("omits oversized journals whose header cwd disagrees with the bucket", async () => {
    const { agentDir, ws } = await setup();
    const t0 = 1_700_000_013_000;
    const id = "50505050-eeee-4eee-8eee-eeeeeeeeeeee";
    await writeSession(agentDir, ws, `2026-11-20T00-00-14-000Z_${id}.jsonl`,
      header(id, join(ws, "elsewhere")) + rename("s1", null, "Elsewhere") +
      msg("m1", null, "user", "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 64)), t0);
    const result = await new CliHistory(agentDir, [ws]).list();
    expect(result.sessions.find(session => session.id === id)).toBeUndefined();
  });

  test("keeps oversized journals outside configured workspaces hidden", async () => {
    const { agentDir, ws } = await setup();
    const other = join(ws, "..", "elsewhere");
    await mkdir(join(agentDir, "sessions", sessionDirName(other)), { recursive: true });
    const foreign = "60606060-ffff-4fff-8fff-ffffffffffff";
    await writeSession(agentDir, other, `2026-11-20T00-00-15-000Z_${foreign}.jsonl`,
      header(foreign, other) + rename("s1", null, "Foreign Big") +
      msg("m1", null, "user", "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 64)), 1_700_000_014_000);
    const history = new CliHistory(agentDir, [ws]);
    expect((await history.list()).sessions).toEqual([]);
    const refused = await tooLargeOf(history, foreign);
    expect(refused).toBeInstanceOf(WebError);
    expect((refused as WebError).status).toBe(404);
  });

  test("resolves an owned oversized journal for resume without parsing the body", async () => {
    const { agentDir, ws } = await setup();
    const id = "70707070-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourcePath = await writeSession(agentDir, ws, `2026-11-20T00-00-16-000Z_${id}.jsonl`,
      header(id, ws) + rename("s1", null, "Big Resumable") +
      msg("m1", null, "user", "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 64)), 1_700_000_015_000);
    const source = await new CliHistory(agentDir, [ws]).branchSource(id, ws);
    expect(source).toMatchObject({ cwd: ws, nativeSessionId: id, sourcePath });
  });
});
