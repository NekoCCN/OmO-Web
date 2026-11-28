import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the Native acceptance runner executes the explicitly selected entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-acceptance-entry-"));
  try {
    const marker = join(root, "entry-ran");
    const entry = join(root, "exit-entry.mjs");
    await writeFile(entry, `await Bun.write(${JSON.stringify(marker)}, "started"); process.exit(17);\n`);
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve("scripts/verify-send-file-native.ts"),
      "--entry", entry], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [, , code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(await Bun.file(marker).text()).toBe("started");
    expect(code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
