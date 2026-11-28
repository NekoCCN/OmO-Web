import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/protocol.ts";
import { AttachmentStore } from "../src/send-file.ts";

const session = sessionKey.parse("11111111-1111-4111-8111-111111111111");
const other = sessionKey.parse("22222222-2222-4222-8222-222222222222");
const binding = { id: session, verify: async () => {} };

test("snapshots bytes immutably and persists them only for the owning Web session", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-store-"));
  const store = new AttachmentStore(join(root, "data"));
  const restarted = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "文档.txt"), "original bytes");
    await store.load();
    const receipt = await store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "文档.txt" }, binding);
    expect(receipt).toEqual({ omoWebAttachment: 1, id: expect.any(String), name: "文档.txt", size: 14 });
    await writeFile(join(cwd, "文档.txt"), "changed bytes");
    await store.close();
    await restarted.load();
    await expect(restarted.download(other, receipt.id)).rejects.toMatchObject({ status: 404 });
    const response = await restarted.download(session, receipt.id);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"download\"; filename*=UTF-8''%E6%96%87%E6%A1%A3.txt");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("original bytes");
  } finally {
    await store.close();
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses outside, aliased, missing, nonregular and control-named sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-refusal-"));
  const store = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(root, "outside"), "private");
    await symlink(join(root, "outside"), join(cwd, "alias"));
    await link(join(root, "outside"), join(cwd, "hard-link"));
    await writeFile(join(cwd, "bad\nname"), "private");
    await store.load();
    await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "hard-link" }, binding))
      .rejects.toMatchObject({ code: "attachment_refused" });
    for (const path of ["../outside", "alias", "missing", ".", "bad\nname"]) {
      await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path }, binding)).rejects.toBeDefined();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("only enforces an explicitly configured quota and preserves files over a lowered quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-quota-"));
  const data = join(root, "data");
  const unlimited = new AttachmentStore(data);
  const limited = new AttachmentStore(data, 1024);
  try {
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(cwd), mkdir(join(data, "attachments"), { recursive: true, mode: 0o700 })]);
    await writeFile(join(cwd, "one-byte"), "x");
    await writeFile(join(cwd, "too-big"), new Uint8Array(1024));
    const staged = await open(join(data, "attachments", "interrupted.stage"), "w");
    try { await staged.truncate(512 * 1024 * 1024 + 1); } finally { await staged.close(); }
    const input = { sessionId: "native", sessionFile: "/fixture", cwd, path: "one-byte" };
    await unlimited.load();
    const prior = await unlimited.register(input, binding);
    await unlimited.close();
    await limited.load();
    expect(await (await limited.download(session, prior.id)).text()).toBe("x");
    await expect(limited.register(input, binding)).rejects.toMatchObject({ code: "attachment_quota_exceeded", status: 507 });
    await limited.close();
    const empty = new AttachmentStore(join(root, "empty"), 1024);
    try {
      await empty.load();
      await expect(empty.register({ ...input, path: "too-big" }, binding))
        .rejects.toMatchObject({ code: "attachment_quota_exceeded", status: 507 });
      expect((await empty.register(input, binding)).size).toBe(1);
    } finally { await empty.close(); }
  } finally {
    await unlimited.close();
    await limited.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive store ownership prevents independent quota accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-lock-"));
  const first = new AttachmentStore(root);
  const second = new AttachmentStore(root);
  try {
    await first.load();
    await expect(second.load()).rejects.toBeDefined();
    await first.close();
    await second.load();
    await second.close();
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects registration if the private attachment directory is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-replaced-"));
  const store = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    const foreign = join(root, "foreign");
    await Promise.all([mkdir(cwd), mkdir(foreign)]);
    await writeFile(join(cwd, "file"), "content");
    await store.load();
    await rename(join(root, "data", "attachments"), join(root, "data", "old-attachments"));
    await symlink(foreign, join(root, "data", "attachments"));
    await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "file" }, binding)).rejects.toBeDefined();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not issue a receipt when the live binding expires during the copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-expired-"));
  const store = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "file"), "content");
    await store.load();
    let checks = 0;
    const expiring = { id: session, async verify() {
      checks++;
      if (checks === 2) throw new Error("binding revoked");
    } };
    await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "file" }, expiring))
      .rejects.toThrow("binding revoked");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
