import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const fixture = fileURLToPath(new URL("../test/tool-lifecycle-engine-fixture.ts", import.meta.url));
const evidence = resolve(process.env.OMO_WORKSPACE_EVIDENCE ?? "artifacts/qa/tonal-workspace");
const detectorPath = process.env.OMO_WORKSPACE_DETECT;
const detector = detectorPath ? await import(pathToFileURL(resolve(detectorPath)).href) : undefined;
const phase = process.argv.includes("--baseline") ? "before" : "after";
const assertTrace = phase === "after" && !process.argv.includes("--measure-ledger-baseline");
const mobileNarrow = { width: 320, height: 740, deviceScaleFactor: 1, mobile: true, hasTouch: true };
const root = await mkdtemp(join(tmpdir(), "omo-tonal-workspace-"));
const cwd = join(root, "workspace");
const storageRoot = join(root, "profile");
let app;
let browser;

try {
  await Promise.all([mkdir(cwd), mkdir(storageRoot), mkdir(evidence, { recursive: true })]);
  const workspaceName = "OmO Web · 运行检查";
  app = await startApp({
    dataDir: join(root, "data"), cliAgentDir: join(root, "agent"), workspaces: [cwd],
    engineCommand: [process.execPath, fixture], port: 0,
  });
  browser = await omowright.connectPipe({
    browserPath, storageRoot, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`],
  });
  const page = await browser.newTab("about:blank");
  if (detectorPath) {
    const probe = join(dirname(resolve(detectorPath)), "snapshot", "collect.ts");
    const { SCRIPT_ERROR_PROBE } = await import(pathToFileURL(probe).href);
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SCRIPT_ERROR_PROBE }, await page.resolveSessionId());
  }
  await omowright.emulate(page, "desktop-1440");
  const visible = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((resolve, reject) => {
    const clock = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Not visible: ${selector}${text ? ` (${text})` : ""}`));
    }, 10_000);
    function check() {
      const selectorMatch = [...document.querySelectorAll(selector)].some(node =>
        node.getClientRects().length && node.textContent.includes(text));
      if (!selectorMatch) return;
      observer.disconnect();
      clearTimeout(clock);
      resolve(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, text });
  const click = async (selector) => {
    await visible(selector);
    await page.locator(selector).click();
  };
  const assertNoOverflow = async () => {
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      transcript: document.querySelector("#transcript").scrollWidth - document.querySelector("#transcript").clientWidth,
    }));
    assert.equal(layout.document, 0, `Page scrolls horizontally at ${layout.width}px`);
    assert.equal(layout.transcript, 0, `Transcript scrolls horizontally at ${layout.width}px`);
  };
  const assertTraceTargets = async (count) => {
    const controls = await page.evaluate(() => [...document.querySelectorAll("#session-trace button:not([hidden])")]
      .map(control => {
        const { width, height, left, right } = control.getBoundingClientRect();
        return { width, height, left, right, viewport: innerWidth };
      }));
    assert.equal(controls.length, count);
    assert(controls.every(({ width, height, left, right, viewport }) => width >= 44 && height >= 44 && left >= 0 && right <= viewport),
      "Each live mobile trace target is an on-screen touch target at least 44px square");
  };
  const capture = async (name) => {
    await assertNoOverflow();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(async value => {
        const select = document.querySelector("#theme");
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      }, theme);
      const file = join(evidence, `${phase}-${name}-${theme}`);
      await Bun.write(`${file}.png`, await page.screenshot());
      if (detector) {
        const source = `(${detector.collectPageSnapshot})(${JSON.stringify(detector.STYLE_PROPS)}, 1500)`;
        const snapshot = await page.evaluate(source);
        await Bun.write(`${file}.json`, JSON.stringify(detector.lintSnapshot(snapshot), null, 2));
        assert(snapshot.scriptErrorsCaptured, "Script-error probe did not initialize before navigation");
        assert.deepEqual(snapshot.scriptErrors, [], `Uncaught browser-side errors in ${name} (${theme})`);
      }
    }
  };
  const open = async () => {
    await click("#details-button:not([hidden])");
    await visible("#details-dialog[open] #runtime-metrics h3", "运行");
  };
  const close = async () => {
    await click("#details-dialog[open] [data-close]");
    assert.equal(await page.evaluate(() => document.querySelector("#details-dialog").open), false);
  };

  await page.goto(app.url.origin);
  await visible("#new-welcome:not(:disabled)");
  await capture("desktop-welcome");
  await click("#new-welcome:not(:disabled)");
  await page.locator("#new-name").fill(workspaceName);
  await click("#create:not(:disabled)");
  await visible("#composer-shell #prompt:not(:disabled)");
  await page.locator("#prompt").fill("请检查工作区的配置，写入前停下来。tool-lifecycle-approval");
  await click("#send:not(:disabled)");
  await visible("#interactions", "Synthetic write approval");
  await visible("#messages .tool-details[data-state=running]");
  await page.locator("#prompt").fill("待原生确认后，继续核对配置。");
  await capture("desktop-awaiting-approval");
  const density = await page.evaluate(() => Object.fromEntries(
    ["#transcript", "#composer-shell", "#interactions form", "#session-list .session-link"]
      .map(selector => [selector, Math.round(document.querySelector(selector).getBoundingClientRect().height)]),
  ));
  await Bun.write(join(evidence, "pending-desktop-dimensions.json"), JSON.stringify(density, null, 2));
  console.log("WORKSPACE_DENSITY", JSON.stringify(density));
  if (assertTrace) {
    const trace = await page.evaluate(() => document.querySelector("#session-trace")?.getClientRects().length);
    assert(trace, "Active transcript exposes a session trace, not just stacked messages");
    assert(density["#transcript"] >= 593 && density["#composer-shell"] <= 213 && density["#interactions form"] <= 236,
      `Desktop should keep at least 593px for the transcript and compact the composer and approval: ${JSON.stringify(density)}`);
    await page.locator("#trace-jump-user").press("Enter");
    assert(await page.evaluate(() => document.activeElement.matches("#messages .message--user")),
      "The trace focuses the actual recent user message");
    await page.locator("#trace-jump-tool").press("Enter");
    assert(await page.evaluate(() => document.activeElement.matches("#messages .tool-details summary") &&
      document.activeElement.closest("details").dataset.state === "running" && !document.activeElement.closest("details").open),
    "The trace points to the actual running tool, without expanding it");
    assert.equal(await page.evaluate(() => document.querySelector("#prompt").value), "待原生确认后，继续核对配置。");
  }
  await open();
  await capture("desktop-inspector");
  const desktop = await page.evaluate(() => {
    const detail = document.querySelector("#details-dialog");
    const transcript = document.querySelector("#transcript");
    return { modal: detail.matches(":modal"), panelLeft: detail.getBoundingClientRect().left,
      transcriptRight: transcript.getBoundingClientRect().right };
  });
  if (phase === "before") {
    await close();
    await omowright.emulate(page, "iphone-14");
    await capture("phone-awaiting-approval");
    await open();
    await capture("phone-inspector");
  }
  assert.equal(desktop.modal, false, "Desktop inspector must not make conversation inert");
  assert(desktop.panelLeft >= desktop.transcriptRight - 1, "Desktop inspector must sit beside the transcript");
  const view = async (name) => {
    await visible(`#details-dialog button[aria-controls="${name}"]`);
    await click(`#details-dialog button[aria-controls="${name}"]`);
  };
  for (const name of ["runtime-subagent", "runtime-dag", "runtime-todo"]) {
    await view(name);
    await visible(`#details-dialog[open] #${name}`);
    assert.equal(await page.evaluate(() => document.querySelector("#runtime-metrics").getClientRects().length), 0);
  }
  await view("runtime-metrics");
  await visible("#runtime-metrics");
  await page.locator("#runtime-open-overview").press("ArrowRight");
  await visible("#runtime-subagent");
  assert.equal(await page.evaluate(() => document.activeElement.id), "runtime-open-subagents");
  await page.locator("#runtime-open-subagents").press("Home");
  await visible("#runtime-metrics");
  await page.locator("#prompt").fill("审批完成后再发送的草稿");
  assert.equal(await page.evaluate(() => document.querySelector("#prompt").value), "审批完成后再发送的草稿");

  await omowright.emulate(page, "iphone-14");
  await visible("#details-dialog:modal");
  assert(await page.evaluate(() => {
    const panel = document.querySelector("#details-dialog");
    document.querySelector("#prompt").focus();
    return panel.contains(document.activeElement);
  }), "The native phone sheet keeps focus inside while it is modal");
  await capture("phone-inspector");
  await omowright.emulate(page, "desktop-1440");
  await visible("#details-dialog[open]:not(:modal) #runtime-metrics h3");
  await omowright.emulate(page, "iphone-14");
  await visible("#details-dialog:modal");
  await page.locator("#details-dialog [data-close]").press("Escape");
  assert.equal(await page.evaluate(() => document.querySelector("#details-dialog").open), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "details-button");
  assert.equal(await page.evaluate(() => document.querySelector("#prompt").value), "审批完成后再发送的草稿");
  if (assertTrace) {
    const height = await page.evaluate(() => document.querySelector("#session-trace").getBoundingClientRect().height);
    assert(height <= 46, `At 390px the pending trace fits in one 44px control row, got ${height}px`);
  }
  await capture("phone-awaiting-approval");
  await click("#jump-to-request");
  assert(await page.evaluate(() => document.activeElement.matches("#interactions form")));
  await capture("phone-approval-actions");
  await click("#compose-options-button");
  await visible("#model");
  await visible("#approval");
  await page.locator("#compose-options-button").press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "compose-options-button");
  await open();
  await close();

  await omowright.emulate(page, mobileNarrow);
  await assertNoOverflow();
  const metrics = await page.evaluate(() => {
    const send = document.querySelector("#stop").getBoundingClientRect();
    const composer = document.querySelector("#composer").getBoundingClientRect();
    return { stopWidth: send.width, stopHeight: send.height, composerBottom: composer.bottom, viewport: innerHeight };
  });
  assert(metrics.stopWidth >= 44 && metrics.stopHeight >= 44 && metrics.composerBottom <= metrics.viewport,
    "Stop remains a reachable touch target and fits at 320px");
  if (assertTrace) await assertTraceTargets(3);
  await page.locator(".request-form select").selectOption("Deny");
  await click(".request-form button[type=submit]");
  await visible("#messages", "Synthetic approval settled.");
  assert.equal(await page.evaluate(() => document.querySelector(".request-form")), null);
  assert.equal(await page.evaluate(() => document.querySelector("#prompt").value), "审批完成后再发送的草稿");
  if (assertTrace) {
    await omowright.emulate(page, "desktop-1440");
    await capture("desktop-settled");
    await visible("#trace-jump-assistant:not([hidden])");
    await page.locator("#trace-jump-assistant").press("Enter");
    assert(await page.evaluate(() => document.activeElement.matches("#messages .message") &&
      document.activeElement.textContent.includes("Synthetic approval settled.")),
    "The reply target points to the actual settled assistant message");
    assert.equal(await page.evaluate(() => document.querySelector("#jump-to-request").getClientRects().length), 0,
      "Resolved approvals are not left in the trace");
    await page.locator("#prompt").fill("再次确认后执行。tool-lifecycle-approval");
    await click("#send:not(:disabled)");
    await visible("#interactions", "Synthetic write approval");
    await omowright.emulate(page, mobileNarrow);
    await assertNoOverflow();
    await assertTraceTargets(4);
    const height = await page.evaluate(() => document.querySelector("#session-trace").getBoundingClientRect().height);
    assert(height <= 46, `At 320px four trace targets fit one 44px control row, got ${height}px`);
    await omowright.emulate(page, "desktop-1440");
    await click("#new-sidebar:not(:disabled)");
    await page.locator("#new-name").fill("隔离的新会话");
    await click("#create:not(:disabled)");
    await visible("#session-title", "隔离的新会话");
    await visible("#no-messages");
    assert.equal(await page.evaluate(() => document.querySelector("#trace-jump-tool").getClientRects().length), 0,
      "A new session never keeps a tool target from the previous session");
  }
  console.log("TONAL_WORKSPACE_BROWSER_OK desktop-inspector-nonmodal four-views phone-modal focus-restored draft-preserved reflow-320 approval-settled");
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
