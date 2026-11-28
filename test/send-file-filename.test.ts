import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/protocol.ts";
import { AttachmentStore } from "../src/send-file.ts";

const id = sessionKey.parse("11111111-1111-4111-8111-111111111111");
const binding = { id, verify: async () => {} };

test("refuses unsafe Unicode, malformed names and alternate data streams before native filesystem calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-attachment-names-"));
  const store = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const paths = ["note\u202etxt", "note\u2066txt", "note\u200ftxt", "note\u2028txt",
      "name:stream", "note\u0007txt", "note\u0000txt", "note\ud800txt"];
    if (process.platform !== "win32") {
      for (const path of paths.slice(0, 6)) await writeFile(join(cwd, path), "fixture");
    }
    await store.load();
    for (const path of paths) {
      await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path }, binding))
        .rejects.toMatchObject({ code: "attachment_refused" });
    }
    await expect(store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "dir\u0000/file" }, binding))
      .rejects.toMatchObject({ code: "attachment_refused" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses malformed persisted filename instead of throwing during header encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-attachment-metadata-"));
  const data = join(root, "data");
  const store = new AttachmentStore(data);
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "file.txt"), "fixture");
    await store.load();
    const receipt = await store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "file.txt" }, binding);
    await writeFile(join(data, "attachments", `${receipt.id}.json`), JSON.stringify({
      sessionId: id, receipt: { ...receipt, name: "bad\ud800name.txt" },
    }));
    await expect(store.download(id, receipt.id)).rejects.toMatchObject({ status: 404, code: "attachment_not_found" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves well-formed supplementary Unicode filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-attachment-unicode-"));
  const store = new AttachmentStore(join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "📄.txt"), "fixture");
    await store.load();
    const receipt = await store.register({ sessionId: "native", sessionFile: "/fixture", cwd, path: "📄.txt" }, binding);
    expect(receipt.name).toBe("📄.txt");
    const response = await store.download(id, receipt.id);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''%F0%9F%93%84.txt");
    expect(await response.text()).toBe("fixture");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
