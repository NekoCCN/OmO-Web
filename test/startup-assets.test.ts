import { expect, onTestFinished, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the bundled entrypoint refuses to start when a required stylesheet is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-startup-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const install = join(root, "install");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await cp(fileURLToPath(new URL("../public/", import.meta.url)), join(install, "public"), { recursive: true });
  await rm(join(install, "public", "workbench.css"));
  const dist = join(install, "dist");
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    target: "bun", outdir: dist, naming: "server.js",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the Web entrypoint");
  await Bun.write(join(dist, "app.js"), "export {};\n");

  const child = Bun.spawn([process.execPath, "--no-env-file", join(dist, "server.js")], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OMO_WEB_/i.test(key))),
      OMO_WEB_PORT: "0", OMO_WEB_DATA: join(root, "data"),
      OMO_WEB_CLI_AGENT_DIR: join(root, "profile"), OMO_WEB_BIN: join(root, "no-engine"),
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stdout).not.toContain("OmO Web: http");
  expect(code).toBe(1);
  expect(stderr).toContain("public/workbench.css");
  expect(await readdir(root)).not.toContain("data");
});
