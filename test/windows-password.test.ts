import { expect, onTestFinished, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPasswordFile, readWindowsPasswordFile } from "../packaging/npm/windows-password.js";

test.if(process.platform === "win32")("Windows creates a private password without overwriting, and rejects a shared ACL", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-acl-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "密码 file.txt");
  const password = randomBytes(32).toString("base64url");
  await createWindowsPasswordFile(path, password);
  expect((await readWindowsPasswordFile(path)).equals(Buffer.from(`${password}\n`))).toBe(true);
  await expect(createWindowsPasswordFile(path, randomBytes(32).toString("base64url"))).rejects.toThrow();
  expect((await readWindowsPasswordFile(path)).equals(Buffer.from(`${password}\n`))).toBe(true);

  const icacls = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  const change = Bun.spawn([icacls, path, "/grant", "*S-1-1-0:(R)"], {
    env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  expect(await change.exited, await new Response(change.stderr).text()).toBe(0);
  await expect(readWindowsPasswordFile(path)).rejects.toThrow(/ACL/);
}, 24000);
