import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey, WebError } from "../src/protocol.ts";
import { startSendFile } from "../src/send-file.ts";

test("private bridge rejects browser origins, missing credentials and unbound Native identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-attachment-bridge-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "file"), "private bytes");
  const bridge = await startSendFile(join(root, "data"), async input => {
    if (input.sessionId !== "bound" || input.sessionFile !== "/fixture" || input.cwd !== cwd) throw new WebError(403, "refused", "refused");
    return { id: sessionKey.parse("11111111-1111-4111-8111-111111111111"), verify: async () => {} };
  });
  try {
    const body = JSON.stringify({ sessionId: "bound", sessionFile: "/fixture", cwd, path: "file" });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${bridge.secret}` };
    const send = (payload: string, extra: Record<string, string>) => fetch(bridge.url, {
      method: "POST", headers: { ...headers, ...extra }, body: payload,
    });
    expect((await send(body, { Origin: "http://127.0.0.1" })).status).toBe(403);
    expect((await send(body, { "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect((await send(body, { Authorization: "Bearer invalid" })).status).toBe(403);
    expect((await send(JSON.stringify({ sessionId: "other", sessionFile: "/fixture", cwd, path: "file" }), {})).status).toBe(403);
    const invalidName = await send(JSON.stringify({ sessionId: "bound", sessionFile: "/fixture", cwd, path: "bad\u0000name" }), {});
    expect(invalidName.status).toBe(403);
    expect(await invalidName.text()).not.toContain(cwd);
    const response = await send(body, {});
    expect(response.status).toBe(200);
    const receipt = await response.text();
    expect(receipt).not.toContain("private bytes");
    expect(receipt).not.toContain(cwd);
    expect(JSON.parse(receipt)).toMatchObject({ omoWebAttachment: 1, name: "file", size: 13 });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
