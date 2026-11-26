import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server.ts";

const live = process.env.OMO_WEB_REAL_INVENTORY_TEST === "1" ? test : test.skip;

live("reads an isolated native session with a commandless extension and no MCP servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-capabilities-native-"));
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const cwd = join(root, "workspace");
    const profile = join(root, "profile");
    const extension = join(root, "passive-fixture.ts");
    await Promise.all([mkdir(cwd), mkdir(join(profile, "prompts"), { recursive: true })]);
    await writeFile(extension, "export default function () {}\n");
    await writeFile(join(profile, "prompts", "inventory-fixture.md"), "Inventory fixture (never invoked).\n");
    app = await startApp({
      dataDir: join(root, "web"),
      workspaces: [cwd],
      port: 0,
      engineCommand: ["env", "-i", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, `HOME=${root}`,
        `OMO_CODING_AGENT_DIR=${profile}`, `SENPI_CODING_AGENT_DIR=${profile}`, `PI_CODING_AGENT_DIR=${profile}`,
        // The OmO wrapper injects its plugin bundle, including eager MCP servers.
        process.env.OMO_WEB_INVENTORY_BIN || "senpi", "--mode", "rpc", "--multi-session", "--session-runtime", "in-process",
        "--offline", "--no-approve", "--no-extensions", "--extension", extension],
    });
    const boot = await (await fetch(new URL("/api/bootstrap", app.url))).json();
    expect(boot.engine, JSON.stringify(boot.engine)).toMatchObject({ online: true });
    const opened = await fetch(new URL("/api/sessions", app.url), {
      method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name: "Native inventory fixture" }),
    });
    const openedBody = await opened.json();
    expect(opened.status, JSON.stringify(openedBody)).toBe(201);
    const path = `/api/sessions/${openedBody.session.id}`;
    const response = await fetch(new URL(`${path}/capabilities`, app.url));
    const receipt = await response.text();
    expect(receipt).not.toContain(root);
    expect(response.status, receipt).toBe(200);
    const inventory = JSON.parse(receipt);
    const passive = { name: "passive-fixture", enabled: true, origin: "top-level" };
    expect(inventory.extensions.status).toBe("ok");
    expect(inventory.extensions.rows).toContainEqual(passive);
    expect(inventory.mcpServers).toEqual({ status: "ok", rows: [], incomplete: false });
    expect(inventory.commands.status).toBe("ok");
    expect(inventory.commands.rows).toContainEqual({ name: "inventory-fixture", source: "prompt", invocation: "/inventory-fixture" });
    expect(inventory.commands.rows.some((row: { name: string }) => row.name === "passive-fixture")).toBe(false);
    const snapshot = await (await fetch(new URL(path, app.url))).json();
    expect(snapshot.messages).toEqual([]);
    console.log(JSON.stringify({ serverVersion: boot.engine.version, httpStatus: response.status, extension: passive,
      mcpServers: inventory.mcpServers, command: "/inventory-fixture", messages: snapshot.messages.length }));
  } finally {
    try { await app?.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
