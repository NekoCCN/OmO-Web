import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const root = await mkdtemp(join(tmpdir(), "omo-model-browser-"));
const cwd = join(root, "workspace");
const storageRoot = join(root, "browser");
const log = join(root, "calls.jsonl");
const evidence = process.env.OMO_MODEL_EVIDENCE;
let app, browser;

function probeModelPreview() {
  const realFetch = window.fetch.bind(window);
  const probe = window.modelProbe = { reads: [], writes: [], hold: "", release: null, errors: 0 };
  for (const type of ["error", "unhandledrejection"]) window.addEventListener(type, () => { probe.errors++; });
  window.fetch = async (path, init) => {
    const url = new URL(path, location.href);
    if (url.pathname.endsWith("/actions")) probe.writes.push(JSON.parse(init.body));
    if (!url.pathname.endsWith("/model-preview")) return realFetch(path, init);
    const model = url.searchParams.get("modelId");
    probe.reads.push({ path: url.pathname, model, method: init?.method });
    if (probe.hold !== model) return realFetch(path, init);
    probe.hold = "";
    const response = await realFetch(path, { ...init, signal: undefined });
    await new Promise(resolve => { probe.release = resolve; window.dispatchEvent(new Event("preview-held")); });
    probe.release = null;
    return response;
  };
}

try {
  await Promise.all([mkdir(cwd), mkdir(storageRoot), evidence && mkdir(evidence, { recursive: true })]);
  app = await startApp({ dataDir: join(root, "web"), workspaces: [cwd], port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("../test/model-options-engine-fixture.ts", import.meta.url)), log] });
  const { token } = await (await fetch(new URL("/api/bootstrap", app.url))).json();
  const ids = new Map();
  for (const name of ["preview-A", "old"]) {
    const response = await fetch(new URL("/api/sessions", app.url), { method: "POST", headers: {
      Origin: app.url.origin, "X-OmO-Token": token, "Content-Type": "application/json",
    }, body: JSON.stringify({ cwd, name }) });
    assert.equal(response.status, 201);
    ids.set(name, (await response.json()).session.id);
  }
  browser = await omowright.connectPipe({ browserPath, storageRoot,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`] });
  const page = await browser.newTab("about:blank");
  const cdpSession = await page.resolveSessionId();
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${probeModelPreview})()` }, cdpSession);
  await omowright.emulate(page, "desktop-1440");
  const wait = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Not visible: ${selector} (${text})`)); }, 7_000);
    function check() {
      const node = document.querySelector(selector);
      if (!node?.getClientRects().length || !node.textContent.includes(text)) return;
      clearTimeout(timer); observer.disconnect(); resolve(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, text });
  const click = async selector => { await wait(selector); await page.locator(selector).click(); };
  const selectSession = async name => {
    await click(`button.session-link[data-session="${ids.get(name)}"]`);
    await wait("#session-title", name);
    await wait("#model:enabled");
  };
  const held = () => page.evaluate(() => new Promise((resolve, reject) => {
    if (window.modelProbe.release) { resolve(true); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); reject(new Error("Preview response was not held")); }, 7_000);
    window.addEventListener("preview-held", () => { clearTimeout(timer); resolve(true); }, { once: true, signal: abort.signal });
  }));
  const holdBeta = () => page.evaluate(() => { window.modelProbe.hold = "beta"; });
  const release = () => page.evaluate(async () => {
    window.modelProbe.release();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const preview = "#model-preview";
  const assertPassiveDescription = () => page.evaluate(() => {
    const status = document.querySelector("#model-preview");
    return getComputedStyle(status).position === "absolute" && ["model", "thinking"].every(id => {
      const select = document.getElementById(id);
      return select.getAttribute("aria-describedby") === status.id && select.title === status.textContent;
    });
  });
  const summary = () => page.evaluate(() => ({
    status: document.querySelector("#model-preview").textContent,
    model: JSON.parse(document.querySelector("#model").value)[1],
    enabled: !document.querySelector("#thinking").disabled,
    levels: [...document.querySelector("#thinking").options].map(option => option.value).filter(Boolean),
  }));
  const capture = async name => {
    if (evidence) await Bun.write(join(evidence, `${name}.png`), await page.screenshot());
  };
  await page.goto(app.url.origin);
  await selectSession("preview-A");
  await wait(preview, "当前：低（来源：默认设置） · 可用：关闭、低、高");
  assert(await assertPassiveDescription(), "Current model source stays available without reserving a row");
  assert.deepEqual(await page.evaluate(id => window.modelProbe.reads.filter(call => call.path.includes(id)).map(call => call.model),
    ids.get("preview-A")), ["alpha"]);
  await page.evaluate(() => document.querySelector("#prompt").focus());
  await page.locator("#prompt").press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "model");
  await holdBeta();
  await page.locator("#model").press("End");
  await held();
  await wait(preview, "正在读取");
  assert.equal((await summary()).enabled, false);
  await page.locator("#model").press("ArrowUp");
  await wait(preview, "当前：低");
  await release();
  assert.deepEqual(await summary(), { status: "当前：低（来源：默认设置） · 可用：关闭、低、高",
    model: "alpha", levels: ["off", "low", "high"], enabled: true });
  assert.deepEqual(await page.evaluate(() => window.modelProbe.writes), []);
  await holdBeta();
  await page.locator("#model").press("End");
  await held();
  await selectSession("old");
  await wait(preview, "档位预览和来源不可用");
  assert(await assertPassiveDescription(), "Unavailable status does not reserve a passive row");
  await release();
  assert.match((await summary()).status, /不可用/);
  assert.equal((await summary()).enabled, true);
  await page.locator("#model").press("End");
  await wait(preview, "档位预览和来源不可用");
  await wait("#apply-model:enabled");
  await page.locator("#model").press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "apply-model");
  await page.locator("#apply-model").press("Enter");
  await wait("#thinking:enabled");
  assert.deepEqual(await summary(), { status: "此模型的档位预览和来源不可用。",
    model: "beta", levels: ["off", "medium"], enabled: true });
  assert.equal(await page.evaluate(() => document.activeElement.id), "model");
  await selectSession("preview-A");
  await wait(preview, "当前：低");
  await page.locator("#model").press("End");
  await wait(preview, "切换后：中（来源：默认设置） · 可用：关闭、中");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#model-preview")).position),
    "static", "A staged preview visibly keeps its source and level list");
  await capture("desktop-preview");
  await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 480, deviceScaleFactor: 1, mobile: true }, cdpSession);
  await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, cdpSession);
  await click("#compose-options-button");
  await wait(preview, "切换后：中");
  assert.deepEqual(await page.evaluate(() => {
    const targets = ["model", "apply-model", "model-preview"].map(id => document.getElementById(id));
    return { noOverflow: document.documentElement.scrollWidth === innerWidth,
      inViewport: targets.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      }),
      hit: targets.slice(0, 2).every(node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      }) };
  }), { noOverflow: true, inViewport: true, hit: true });
  await capture("mobile-320-preview");
  await click("#apply-model");
  await wait(preview, "当前：中（来源：默认设置） · 可用：关闭、中");
  assert.deepEqual((await summary()).levels, ["off", "medium"]);
  await page.locator("#compose-options-button").press("Escape");
  await wait("#compose-options-button[aria-expanded=false]");
  assert.equal(await page.evaluate(() => document.activeElement.id), "compose-options-button");
  await omowright.emulate(page, "desktop-1440");
  await page.locator("#thinking").press("ArrowUp");
  await wait(preview, "当前：关闭（来源：会话内记录）");
  const { reads, writes, errors } = await page.evaluate(() => window.modelProbe);
  assert(reads.every(call => call.method === "GET" && ["alpha", "beta"].includes(call.model)));
  assert.deepEqual(writes, [{ action: "model", provider: "fixture", modelId: "beta" },
    { action: "model", provider: "fixture", modelId: "beta" }, { action: "thinking", level: "off" }]);
  assert.equal(errors, 0);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(call => call.type === "set_model").map(call => [call.sessionId, call.scope]),
    [["rpc-2", "session"], ["rpc-1", "session"]]);
  assert.deepEqual(calls.filter(call => call.type === "set_thinking_level").map(call => [call.sessionId, call.level, call.scope]),
    [["rpc-1", "off", "turn"]]);
  assert(!calls.some(call => call.type === "prompt"));
  console.log(`MODEL_BROWSER_OK ${JSON.stringify({ keyboard: true, mobile: "320x480", reads: reads.length,
    staleSelectionAndSession: true, legacyFallback: true, previewWrites: 0 })}`);
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
