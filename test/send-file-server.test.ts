import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/protocol.ts";
import { AttachmentStore } from "../src/send-file.ts";
import { startApp } from "../src/server.ts";
import { WorkspaceAccess } from "../src/workspace-access.ts";

test("attachment storage opens at the canonical data root and still rejects an aliased attachment directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-attachment-alias-")));
  const data = join(root, "数据目录");
  const alias = join(root, "data-alias");
  const store = new AttachmentStore(alias);
  const app = () => startApp({ dataDir: alias, workspaces: [root], port: 0, sendFile: true,
    engineCommand: ["native-must-not-start"] });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await mkdir(data, { mode: 0o700 });
    await symlink(data, alias, linkType);
    const server = await app();
    try { expect((await fetch(server.url)).status).toBe(200); }
    finally { await server.stop(); }
    await store.load();
    await store.close();
    const attachments = join(data, "attachments");
    await rename(attachments, join(data, "other"));
    await symlink(join(data, "other"), attachments, linkType);
    await expect(app()).rejects.toMatchObject({ code: "attachment_refused" });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test.each(["0", "-1", "1e6", "9007199254740992"])("invalid quota %s fails before the attachment service starts", async value => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-attachment-config-")));
  try {
    await expect(startApp({ dataDir: join(root, "data"), workspaces: [root], port: 0, sendFile: true,
      webEnv: { OMO_WEB_ATTACHMENT_QUOTA_BYTES: value }, engineCommand: ["native-must-not-start"] }))
      .rejects.toMatchObject({ setting: "OMO_WEB_ATTACHMENT_QUOTA_BYTES" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download authorizes only its target workspace without starting Native", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-attachment-target-")));
  const data = join(root, "data");
  const first = join(root, "first");
  const second = join(root, "second");
  const id = sessionKey.parse("11111111-1111-4111-8111-111111111111");
  const other = sessionKey.parse("22222222-2222-4222-8222-222222222222");
  const store = new AttachmentStore(data);
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let exact: ReturnType<typeof spyOn<typeof WorkspaceAccess.prototype, "exact">> | undefined;
  try {
    await Promise.all([mkdir(first), mkdir(second), mkdir(join(data, "sessions"), { recursive: true })]);
    await writeFile(join(first, "file"), "target bytes");
    const policy = await WorkspaceAccess.fromConfig([first, second]);
    for (const row of [{ id, cwd: first }, { id: other, cwd: second }]) {
      const workspaceKey = await policy.exact(row.cwd);
      expect(workspaceKey).toBeDefined();
      await writeFile(join(data, "sessions", `${row.id}.json`), JSON.stringify({
        ...row, name: "fixture", updatedAt: 1, archived: false, settled: false, workspaceKey,
      }));
    }
    await store.load();
    const receipt = await store.register({ sessionId: "native", sessionFile: "/fixture", cwd: first, path: "file" },
      { id, verify: async () => {} });
    await store.close();
    app = await startApp({ dataDir: data, workspaces: [first, second], port: 0, sendFile: true,
      engineCommand: [join(root, "native-must-not-start")] });
    exact = spyOn(WorkspaceAccess.prototype, "exact");
    const download = await fetch(new URL(`/api/sessions/${id}/attachments/${receipt.id}`, app.url));
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("target bytes");
    expect(exact.mock.calls.map(call => call[0])).toEqual([first]);
    const endpoint = new URL(`/api/sessions/${id}/attachments/${receipt.id}`, app.url);
    const etag = download.headers.get("etag");
    expect(etag).toMatch(/^"[^"]+"$/u);
    expect(download.headers.get("accept-ranges")).toBe("bytes");
    const tail = await fetch(endpoint, { headers: { Range: "bytes=7-", "If-Range": etag ?? "" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 7-11/12");
    expect(tail.headers.get("content-length"), JSON.stringify(Object.fromEntries(tail.headers))).toBe("5");
    expect(tail.headers.get("content-disposition")).toBe(download.headers.get("content-disposition"));
    expect(tail.headers.get("etag")).toBe(etag);
    expect(await tail.text()).toBe("bytes");
    const stale = await fetch(endpoint, { headers: { Range: "bytes=7-", "If-Range": '"old"' } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("target bytes");
    const outOfBounds = await fetch(endpoint, { headers: { Range: "bytes=12-" } });
    expect(outOfBounds.status).toBe(416);
    expect(outOfBounds.headers.get("content-range")).toBe("bytes */12");
    expect(await outOfBounds.text()).toBe("");
    exact.mockClear();
    expect((await fetch(new URL(`/api/sessions/${id}/attachments/${receipt.id}`, app.url),
      { headers: { Origin: "http://attacker.invalid" } })).status).toBe(403);
    expect(exact.mock.calls).toEqual([]);
    expect((await fetch(new URL(`/api/sessions/${other}/attachments/${receipt.id}`, app.url),
      { headers: { Range: "bytes=7-" } })).status).toBe(404);
    expect(exact.mock.calls.map(call => call[0])).toEqual([second]);
    await rename(first, `${first}-moved`);
    expect((await fetch(new URL(`/api/sessions/${id}/attachments/${receipt.id}`, app.url))).status).toBe(404);
  } finally {
    exact?.mockRestore();
    try { await app?.stop(); } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test.each(["sessions", "listener"] as const)("failed %s startup closes the private bridge and releases the store", async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-attachment-startup-")));
  const cwd = join(root, "workspace");
  const data = join(root, "data");
  const store = new AttachmentStore(data);
  let blocker: Bun.Server<undefined> | undefined;
  let served: ReturnType<typeof spyOn<typeof Bun, "serve">> | undefined;
  let closeBridge: (() => void) | undefined;
  try {
    await mkdir(cwd);
    if (mode === "sessions") {
      await mkdir(data);
      await writeFile(join(data, "sessions"), "not a directory");
    } else {
      blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
    }
    served = spyOn(Bun, "serve");
    await expect(startApp({ dataDir: data, workspaces: [cwd], port: blocker?.port ?? 0, sendFile: true,
      engineCommand: [join(root, "native-must-not-start")] })).rejects.toBeDefined();
    const bridge = served.mock.results[0]?.value;
    if (!bridge || typeof bridge !== "object" || !("url" in bridge) || !(bridge.url instanceof URL) ||
      !("stop" in bridge) || typeof bridge.stop !== "function") throw new Error("Private bridge was not created");
    const stopBridge = bridge.stop.bind(bridge);
    closeBridge = () => { stopBridge(true); };
    await expect(fetch(bridge.url, { signal: AbortSignal.timeout(2_000) })).rejects.toBeDefined();
    await store.load();
  } finally {
    served?.mockRestore();
    closeBridge?.();
    await blocker?.stop(true);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
