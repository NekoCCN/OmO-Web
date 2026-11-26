import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionDirName } from "../src/cli-history.ts";
import { startApp } from "../src/server.ts";
import { terminalFixture } from "../test/terminal-socket-fixture.ts";

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const evidence = process.env.OMO_WORKSPACE_EVIDENCE;
const browserRoot = await mkdtemp(join(tmpdir(), "omo-workspace-browser-"));
let app, browser, native;

function watchRequests() {
  const fetchActual = window.fetch.bind(window);
  const probe = window.workspaceProbe = { posts: [], hold: false, release: null, reads: 0, errors: 0 };
  for (const type of ["error", "unhandledrejection"]) window.addEventListener(type, () => { probe.errors++; });
  window.fetch = async (path, init) => {
    const url = new URL(path, location.href);
    if (init?.method === "POST") probe.posts.push({ path: url.pathname, body: JSON.parse(init.body) });
    if (url.pathname !== "/api/cli-follow") return fetchActual(path, init);
    probe.reads++;
    if (!probe.hold) return fetchActual(path, init);
    probe.hold = false;
    const response = await fetchActual(path, { ...init, signal: undefined });
    await new Promise(resolve => { probe.release = resolve; window.dispatchEvent(new Event("follow-held")); });
    probe.release = null;
    return response;
  };
}

async function seedJournal(profile, cwd, name) {
  const dir = join(profile, "sessions", sessionDirName(cwd));
  await mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const timestamp = "2026-11-26T04:00:00.000Z";
  await writeFile(join(dir, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "session_info", id: "info", parentId: null, timestamp, name },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
}

try {
  native = await terminalFixture();
  const a = native.cwd;
  const b = join(dirname(a), "projects-with-a-long-absolute-path", "long-nested-workspace-directory", "workspace-b");
  const hidden = join(dirname(a), "unapproved");
  const web = join(dirname(a), "web");
  const staleId = crypto.randomUUID();
  await Promise.all([mkdir(b, { recursive: true }), mkdir(hidden), mkdir(join(web, "sessions"), { recursive: true, mode: 0o700 }),
    evidence && mkdir(evidence, { recursive: true })]);
  await writeFile(join(web, "sessions", `${staleId}.json`), JSON.stringify({
    id: staleId, name: "以前授权的工作区", cwd: hidden, updatedAt: 1, archived: false, settled: false,
  }), { mode: 0o600 });
  await Promise.all([seedJournal(native.agentDir, a, "CLI 历史 A"), seedJournal(native.agentDir, b, "CLI 历史 B"),
    seedJournal(native.agentDir, hidden, "NOT_AUTHORIZED_JOURNAL")]);
  native.state.messages = [{ role: "assistant", content: "CLI_ALPHA_MESSAGE" }];
  app = await startApp({
    dataDir: web, workspaces: [a, b], cliAgentDir: native.agentDir, port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("../test/engine-fixture.ts", import.meta.url))],
  });
  const { token } = await (await fetch(new URL("/api/bootstrap", app.url))).json();
  const create = async (cwd, name) => {
    const result = await fetch(new URL("/api/sessions", app.url), { method: "POST",
      headers: { Origin: app.url.origin, "X-OmO-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name }),
    });
    assert.equal(result.status, 201);
    return (await result.json()).session.id;
  };
  const aId = await create(a, "Web 会话 A");
  const bId = await create(b, "Web 会话 B");
  browser = await omowright.connectPipe({ browserPath, storageRoot: browserRoot,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${browserRoot}`] });
  const page = await browser.newTab("about:blank");
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${watchRequests})()` }, await page.resolveSessionId());
  await omowright.emulate(page, "desktop-1440");
  const wait = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`Not visible: ${selector} (${text})`)); }, 13_000);
    function check() {
      if (![...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(text))) return;
      observer.disconnect();
      clearTimeout(deadline);
      resolve(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, text });
  const click = async selector => { await wait(selector); await page.locator(selector).click(); };
  const capture = async name => { if (evidence) await Bun.write(join(evidence, `${name}.png`), await page.screenshot()); };
  const theme = value => page.evaluate(value => {
    const select = document.querySelector("#theme");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const row = id => `#session-list button[data-session="${id}"]`;
  const exists = selector => page.evaluate(selector => Boolean(document.querySelector(selector)?.getClientRects().length), selector);
  const choose = async (cwd, id, cliName) => {
    await page.locator("#workspace-select").selectOption(cwd);
    await wait(row(id));
    await wait("#cli-session-list button", cliName);
  };
  const selectValue = selector => page.evaluate(selector => document.querySelector(selector).value, selector);
  const follow = "#cli-follow-view";
  const held = () => page.evaluate(() => new Promise((resolve, reject) => {
    if (window.workspaceProbe.release) { resolve(true); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); reject(new Error("No follow response held")); }, 13_000);
    window.addEventListener("follow-held", () => { clearTimeout(timeout); resolve(true); }, { once: true, signal: controller.signal });
  }));
  const release = () => page.evaluate(async () => {
    window.workspaceProbe.release();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  await page.goto(app.url.origin);
  await wait("#workspace-select");
  await wait(row(aId));
  await wait(row(bId));
  assert(!await exists(row(staleId)), "All workspaces still excludes sessions from an old unapproved root");
  assert.equal(await page.evaluate(() => window.workspaceProbe.reads), 0, "Follow is opt-in");
  await choose(a, aId, "CLI 历史 A");
  assert(!await exists(row(bId)), "B stays out of A's Web list");
  assert(!await page.evaluate(() => document.querySelector("#cli-session-list").textContent.includes("CLI 历史 B")));
  await click(row(aId));
  await wait("#prompt:enabled");
  await page.locator("#prompt").fill("草稿只属于 A");
  await choose(b, bId, "CLI 历史 B");
  assert(!await exists(row(aId)), "A stays out of B's Web list");
  assert(!await page.evaluate(() => document.querySelector("#cli-session-list").textContent.includes("CLI 历史 A")));
  await click("#cli-history-button");
  await wait("#cli-history-list button", "CLI 历史 B");
  assert(!await page.evaluate(() => document.querySelector("#cli-history-list").textContent.includes("CLI 历史 A")));
  await page.locator("#cli-history-dialog [data-close]").click();
  await click("#new-sidebar:not(:disabled)");
  assert.equal(await selectValue("#new-cwd"), b, "New session defaults to selected workspace");
  await page.locator("#new-name").fill("在 B 新建");
  await click("#create:not(:disabled)");
  await wait("#session-title", "在 B 新建");
  const created = await (await fetch(new URL("/api/sessions", app.url))).json();
  assert.equal(created.sessions.find(item => item.name === "在 B 新建")?.cwd, b);
  await choose(a, aId, "CLI 历史 A");
  await wait("#session-title", "Web 会话 A");
  await wait("#prompt:enabled");
  assert.equal(await selectValue("#prompt"), "草稿只属于 A");
  await page.goto(app.url.origin);
  await wait("#workspace-select");
  assert.equal(await selectValue("#workspace-select"), a, "Workspace selection survives reload");
  assert(!await exists(row(bId)));
  assert(!await page.evaluate(cwd => Array.from(document.querySelector("#workspace-select").options).some(option => option.value === cwd), hidden));
  await capture("desktop-workspace-a");
  await theme("dark");
  await capture("desktop-workspace-a-dark");
  await theme("light");

  await click("#cli-follow-button");
  await wait("#cli-follow-messages", "CLI_ALPHA_MESSAGE");
  assert(!await exists("#composer-shell"), "Read-only follow has no composer");
  assert(!await exists("#manage-button"), "Read-only follow exposes no session management");
  native.state.cwd = b;
  native.state.durable = "fixture-b-current";
  native.state.messages = [{ role: "assistant", content: "CLI_BETA_MESSAGE" }];
  await wait("#cli-follow-messages", "CLI_BETA_MESSAGE");
  assert.equal(await selectValue("#workspace-select"), b, "Verified CLI workspace and displayed conversation move together");
  assert(!await page.evaluate(() => document.querySelector("#cli-follow-messages").textContent.includes("CLI_ALPHA_MESSAGE")));
  await capture("desktop-follow-b");
  await theme("dark");
  await capture("desktop-follow-b-dark");
  await omowright.emulate(page, { width: 320, height: 600, deviceScaleFactor: 1, mobile: true, hasTouch: true });
  const narrow = await page.evaluate(() => {
    const path = document.querySelector("#session-path");
    return { overflow: document.documentElement.scrollWidth - innerWidth, height: path.getBoundingClientRect().height,
      twoLines: parseFloat(getComputedStyle(path).lineHeight) * 2, value: path.textContent,
      prefix: getComputedStyle(path, "::before").content };
  });
  assert.equal(narrow.overflow, 0);
  assert.equal(narrow.value, b);
  assert.match(narrow.prefix, /^"workspace-b · /, "Mobile heading shows the distinguishing workspace name before the truncation point");
  assert(narrow.height <= narrow.twoLines + 1, "A long cwd does not consume the fixed follow header");
  await capture("mobile-follow-b-dark");
  await theme("light");
  await capture("mobile-follow-b");
  await omowright.emulate(page, { width: 1050, height: 510, deviceScaleFactor: 1, mobile: false, hasTouch: false });
  assert.deepEqual(await page.evaluate(() => {
    const picker = document.querySelector("#workspace-select");
    return [picker.selectedOptions[0].text, picker.title];
  }), ["workspace-b", b], "Short desktop shows a compact label while retaining the full path");
  await wait(row(bId));
  native.state.cwd = hidden;
  native.state.messages = [{ role: "assistant", content: "UNAUTHORIZED_CONTENT" }];
  await wait("#cli-follow-status");
  await page.evaluate(() => new Promise((resolve, reject) => {
    const target = document.querySelector("#cli-follow-messages");
    const clock = setTimeout(() => { observer.disconnect(); reject(new Error("Unauthorized wake left old transcript visible")); }, 13_000);
    function check() {
      if (target?.textContent.includes("CLI_BETA_MESSAGE")) return;
      clearTimeout(clock); observer.disconnect(); resolve(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  }));
  assert.equal(await selectValue("#workspace-select"), b, "Unapproved CLI cwd does not become selected");
  assert(!await page.evaluate(() => document.body.textContent.includes("UNAUTHORIZED_CONTENT")));
  native.state.cwd = b;
  native.state.messages = [{ role: "assistant", content: "CLI_BETA_MESSAGE" }];
  await wait("#cli-follow-messages", "CLI_BETA_MESSAGE");
  await page.evaluate(() => { window.workspaceProbe.hold = true; });
  await held();
  await choose(a, aId, "CLI 历史 A");
  await release();
  assert(!await exists(follow), "Manual workspace selection stops follow even when the response ignores cancellation");
  assert.equal(await selectValue("#workspace-select"), a);
  await click(row(aId));
  await wait("#prompt:enabled");

  const competing = join(native.registry, "aabb112233445566");
  await mkdir(competing, { mode: 0o700 });
  await click("#cli-follow-button");
  await wait("#cli-follow-status", "多个");
  assert(!await page.evaluate(() => document.querySelector("#cli-follow-messages").textContent.includes("CLI_BETA_MESSAGE")));
  assert.equal(await selectValue("#workspace-select"), a, "An ambiguous terminal never updates the workspace");
  await capture("desktop-ambiguous");
  await click("#cli-follow-stop");
  assert(!await exists(follow));
  const probe = await page.evaluate(() => ({ posts: window.workspaceProbe.posts, errors: window.workspaceProbe.errors }));
  assert.deepEqual(probe, { posts: [], errors: 0 }, "Scope and follow are read only and cannot accidentally resume");
  assert(native.trace.length > 0 && native.trace.every(frame => frame.observe === true &&
    ["get_protocol_info", "list_sessions", "get_state", "get_messages"].includes(frame.type)), "Observe never attaches or writes");
  console.log("WORKSPACE_FOLLOW_BROWSER_OK exact-scope persisted default draft isolated read-only switch late-response ambiguity mobile-320 short-desktop");
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally {
      try { await native?.close(); } finally { await rm(browserRoot, { recursive: true, force: true }); }
    }
  }
}
