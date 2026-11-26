import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("../test/capabilities-engine-fixture.ts", import.meta.url));

// The endpoint fixture owns capability results. Supply the ordinary session
// reads it doesn't implement so the real Web inspector can open normally.
if (process.argv[2] === "--fixture-rpc") {
  const child = Bun.spawn([process.execPath, fixture, process.argv[3]], {
    env: process.env, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const relay = new Response(child.stdout.pipeThrough(new TransformStream({
    transform(chunk) { process.stdout.write(chunk); },
  }))).arrayBuffer();
  const defaults = new Map([
    ["get_state", { isStreaming: false, permissionPreset: "ask" }],
    ["get_messages", { messages: [] }],
    ["get_session_stats", {}],
    ["get_tree", { tree: [] }],
    ["get_pending_inputs", { inputs: [] }],
    ["get_available_models", { models: [] }],
    ["get_available_thinking_levels", { levels: [] }],
  ]);
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, type } = JSON.parse(line);
    if (defaults.has(type)) {
      process.stdout.write(`${JSON.stringify({ id, type: "response", command: type, success: true, data: defaults.get(type) })}\n`);
    } else {
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    }
  }
  child.stdin.end();
  await Promise.all([child.exited, relay]);
  process.exit(child.exitCode ?? 1);
}

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const native = process.argv.includes("--native");
const evidence = resolve(process.env.OMO_INVENTORY_EVIDENCE ?? "artifacts/qa/native-inventory-ui");
const detectorPath = process.env.OMO_INVENTORY_DETECT;
const detector = detectorPath ? await import(pathToFileURL(resolve(detectorPath)).href) : undefined;
const root = await mkdtemp(join(tmpdir(), "omo-inventory-browser-"));
const cwd = join(root, "workspace");
const profile = join(root, "agent");
const storageRoot = join(root, "browser");
const extension = join(root, "passive-fixture.ts");
const log = join(root, "calls.jsonl");
const panel = "#runtime-capabilities";
const tab = "#runtime-open-capabilities";
let app;
let browser;

// Scope fault injection to the one read under test. A held response really
// comes from the application; allow it through even after the signal aborts
// to exercise the consumer's stale-response check, not just Fetch's.
function inventoryProbe() {
  const fetchApp = window.fetch.bind(window);
  const probe = window.inventoryProbe = { reads: [], writes: 0, errors: 0, next: null, held: null };
  for (const type of ["error", "unhandledrejection"]) window.addEventListener(type, () => { probe.errors++; });
  window.fetch = async (path, init) => {
    const url = new URL(typeof path === "string" ? path : path.url, location.href);
    if (init?.method === "POST" && url.pathname.endsWith("/actions")) probe.writes++;
    if (url.origin !== location.origin || !url.pathname.endsWith("/capabilities")) return fetchApp(path, init);
    const read = { path: url.pathname, method: init?.method, noToken: !new Headers(init?.headers).has("X-OmO-Token") };
    probe.reads.push(read);
    const next = probe.next;
    probe.next = null;
    if (next?.hold) {
      const response = await fetchApp(path, { ...init, signal: undefined });
      read.status = response.status;
      await new Promise(resolve => {
        probe.held = resolve;
        window.dispatchEvent(new Event("inventory-fixture-held"));
      });
      probe.held = null;
      return response;
    }
    const response = next
      ? Response.json({ code: next.code, error: "QA-private-diagnostic" }, { status: next.status })
      : await fetchApp(path, init);
    read.status = response.status;
    return response;
  };
}

try {
  await Promise.all([mkdir(cwd), mkdir(storageRoot), mkdir(join(profile, "prompts"), { recursive: true }),
    mkdir(evidence, { recursive: true })]);
  const engineCommand = native
    ? ["env", "-i", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, `HOME=${root}`,
      `OMO_CODING_AGENT_DIR=${profile}`, `SENPI_CODING_AGENT_DIR=${profile}`, `PI_CODING_AGENT_DIR=${profile}`,
      process.env.OMO_WEB_INVENTORY_BIN || "senpi", "--mode", "rpc", "--multi-session", "--session-runtime", "in-process",
      "--offline", "--no-approve", "--no-extensions", "--extension", extension]
    : [process.execPath, fileURLToPath(import.meta.url), "--fixture-rpc", log];
  if (native) await Promise.all([writeFile(extension, "export default function () {}\n"),
    writeFile(join(profile, "prompts", "inventory-fixture.md"), "Inventory fixture (never invoked).\n")]);
  app = await startApp({ dataDir: join(root, "web"), cliAgentDir: profile, workspaces: [cwd], port: 0, engineCommand });
  const boot = await (await fetch(new URL("/api/bootstrap", app.url))).json();
  assert.equal(boot.engine.online, true, "Isolated engine must be online");
  const ids = new Map();
  for (const name of native ? ["native-fixture"] : ["passive", "legacy", "empty", "bounded"]) {
    const response = await fetch(new URL("/api/sessions", app.url), {
      method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name }),
    });
    assert.equal(response.status, 201, `Create isolated session: ${name}`);
    ids.set(name, (await response.json()).session.id);
  }
  browser = await omowright.connectPipe({
    browserPath, storageRoot, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`],
  });
  const page = await browser.newTab("about:blank");
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${inventoryProbe})()` }, await page.resolveSessionId());
  await omowright.emulate(page, "desktop-1440");
  const visible = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Not visible: ${selector} (${text})`));
    }, 8_000);
    function check() {
      if (![...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(text))) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, text });
  const click = async (selector) => { await visible(selector); await page.locator(selector).click(); };
  const section = async (heading, content) => {
    const text = await page.evaluate(({ panel, heading }) =>
      [...document.querySelectorAll(`${panel} section`)].find(node => node.querySelector("h3")?.textContent === heading)?.textContent,
    { panel, heading });
    assert.equal(typeof text, "string", `Missing section ${heading}`);
    assert.match(text, content);
    return text;
  };
  const openInspector = () => click("#details-button:not([hidden])");
  const selectSession = async name => {
    await click(`button.session-link[data-session="${ids.get(name)}"]`);
    await visible("#session-title", name);
    await visible("#details-button:not([hidden])");
  };
  const openCapabilities = async () => { await openInspector(); await click(tab); };
  const focus = selector => page.evaluate(selector => document.activeElement.matches(selector), selector);
  const contrast = () => page.evaluate(panel => {
    const levels = color => {
      const parts = color.startsWith("#")
        ? color.slice(1).match(/../g).map(value => parseInt(value, 16))
        : color.match(/[\d.]+/g).slice(0, 3).map(Number);
      return parts.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    };
    const luminance = color => {
      const [r, g, b] = levels(color);
      return .2126 * r + .7152 * g + .0722 * b;
    };
    const ratio = (foreground, background) => {
      const pair = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (pair[0] + .05) / (pair[1] + .05);
    };
    const inspector = getComputedStyle(document.querySelector("#details-dialog"));
    const role = name => inspector.getPropertyValue(`--runtime-${name}`).trim();
    const painted = "rgba(0, 0, 0, 0)";
    const text = [...document.querySelectorAll(`${panel} :is(h3, code, dd, p:not(.sr-only))`),
      ...document.querySelectorAll("#runtime-shortcuts button, #details-title, .details-toolbar button")]
      .filter(node => node.getClientRects().length)
      .map(node => {
        const style = getComputedStyle(node);
        const background = style.backgroundColor !== painted ? [style.backgroundColor]
          : node.closest(panel) ? [inspector.backgroundColor] : [role("head"), role("violet")];
        return Math.min(...background.map(color => ratio(style.color, color)));
      });
    return { text: Math.min(...text), focus: Math.min(...["head", "violet", "active"].map(name => ratio(role("signal"), role(name)))) };
  }, panel);
  const capture = async name => {
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const ratios = await contrast();
    assert(ratios.text >= 4.5 && ratios.focus >= 3, `Capability text and controls contrast: ${JSON.stringify(ratios)}`);
    await Bun.write(join(evidence, `${name}.png`), await page.screenshot());
    if (detector) {
      const source = `(${detector.collectPageSnapshot})(${JSON.stringify(detector.STYLE_PROPS)}, 1500)`;
      await Bun.write(join(evidence, `${name}-detect.json`),
        JSON.stringify({ ratios, findings: detector.lintSnapshot(await page.evaluate(source)) }));
    }
  };
  const theme = async value => {
    await page.evaluate(value => {
      const select = document.querySelector("#theme");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };
  const refresh = () => click("#details-refresh");
  const count = () => page.evaluate(() => window.inventoryProbe.reads.length);
  const nextResponse = value => page.evaluate(value => { window.inventoryProbe.next = value; }, value);
  const waitHeld = () => page.evaluate(() => new Promise((resolve, reject) => {
    if (window.inventoryProbe.held) { resolve(true); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); reject(new Error("The isolated reply was never held")); }, 8_000);
    window.addEventListener("inventory-fixture-held", () => { clearTimeout(timer); resolve(true); },
      { once: true, signal: abort.signal });
  }));
  const finishHeld = () => page.evaluate(async () => {
    window.inventoryProbe.held();
    // The reply now traverses Fetch and Response.json before the paint.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  await page.goto(app.url.origin);
  await selectSession(native ? "native-fixture" : "passive");
  await openInspector();
  assert.equal(await page.evaluate(tab => document.querySelector(tab)?.textContent, tab), "能力",
    "The runtime inspector has a fifth tab named 能力");
  assert.equal(await count(), 0, "Opening the overview doesn't read capabilities");
  await page.locator("#runtime-open-overview").press("End");
  assert(await focus(tab));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#runtime-shortcuts [role=tab]")].at(-1)?.getAttribute("aria-selected")), "true");
  await visible(`${panel} section`, "passive-fixture");
  await section("已加载扩展", /passive-fixture.*已启用.*顶层来源/);
  const rendered = () => page.evaluate(panel => document.querySelector(panel).innerHTML, panel);
  const capabilityText = () => page.evaluate(panel => document.querySelector(panel).textContent.trim(), panel);
  assert.doesNotMatch(await rendered(), /QA-private-diagnostic|private\.invalid|private-route|lastError|authStatus|sourceInfo/);
  if (native) {
    await section("注册命令与技能", /\/inventory-fixture.*提示模板/);
    assert.doesNotMatch(await section("注册命令与技能", /inventory-fixture/), /passive-fixture/);
    await section("MCP 服务", /未报告任何/);
    await capture("native-desktop-light");
    await page.evaluate(() => {
      const scroller = document.querySelector("#details-scroll");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await capture("native-desktop-end-light");
    const reads = await page.evaluate(() => window.inventoryProbe.reads.map(({ method, status }) => ({ method, status })));
    assert.deepEqual(reads, [{ method: "GET", status: 200 }]);
    assert.equal(await page.evaluate(() => window.inventoryProbe.writes), 0);
    assert.equal(await page.evaluate(() => window.inventoryProbe.errors), 0);
    console.log(`INVENTORY_NATIVE_BROWSER_OK ${JSON.stringify({ version: boot.engine.version, extension: "passive-fixture",
      extensionOrigin: "top-level", command: "/inventory-fixture", mcp: "explicitly empty", reads })}`);
  } else {
    await section("注册命令与技能", /\/fix-tests.*提示模板.*\$pdf-tools.*技能.*\/echo.*扩展/);
    await section("已加载扩展", /packaged.*已停用.*包来源/);
    assert.doesNotMatch(await section("已加载扩展", /origin-unknown/), /origin-unknown.*(?:顶层来源|包来源)/);
    await section("MCP 服务", /local-fixture.*连接中.*0 个工具/);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#details-dialog [role=tabpanel]:not([hidden])").length), 1);
    await capture("desktop-light");
    await theme("dark");
    await capture("desktop-dark");

    const mobile = { width: 320, height: 480, deviceScaleFactor: 1, mobile: true, hasTouch: true };
    await omowright.emulate(page, mobile);
    await visible("#details-dialog:modal");
    assert(await focus(tab), "Wide-to-narrow retains the selected tab's focus");
    assert.equal(await count(), 1, "Resizing does not reload the inventory");
    const measure = () => page.evaluate(() => {
      const bounds = document.documentElement;
      const scroller = document.querySelector("#details-scroll");
      const buttons = [...document.querySelectorAll("#runtime-shortcuts [role=tab], #details-refresh, #details-dialog [data-close]")];
      return {
        overflow: [bounds.scrollWidth - bounds.clientWidth, bounds.scrollHeight - innerHeight,
          scroller.scrollWidth - scroller.clientWidth],
        controls: buttons.map(button => {
          const { width, height, left, right, top, bottom } = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const label = range.getBoundingClientRect();
          return { id: button.id, width, height, left, right, top, bottom,
            fits: left <= label.left && right >= label.right && top <= label.top && bottom >= label.bottom,
            hit: document.elementFromPoint(left + width / 2, top + height / 2) === button };
        }),
      };
    });
    const layout = await measure();
    assert.deepEqual(layout.overflow, [0, 0, 0], "No page or panel horizontal overflow or page vertical scrolling");
    assert.equal(layout.controls.length, 7);
    assert(layout.controls.every(({ width, height, left, right, top, bottom, fits, hit }) =>
      width >= 44 && height >= 44 && left >= 0 && right <= 320 && top >= 0 && bottom <= 480 && fits && hit),
      `Mobile controls must be fully visible and tappable: ${JSON.stringify(layout)}`);
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.id = "inventory-spacing-probe";
      style.textContent = "#details-dialog * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } #details-dialog p { margin-block-end: 2em !important; }";
      document.head.append(style);
    });
    const spaced = await measure();
    assert.deepEqual(spaced.overflow, [0, 0, 0]);
    assert(spaced.controls.every(control => control.fits && control.hit), "User text spacing does not clip the tabs");
    await page.evaluate(() => { document.querySelector("#inventory-spacing-probe").remove(); });
    await capture("short-phone-dark");
    await theme("light");
    await capture("short-phone-light");
    assert(await page.evaluate(() => {
      const node = document.querySelector("#details-scroll");
      node.scrollTop = node.scrollHeight;
      return node.scrollTop > 0;
    }), "Short phone scrolls the capability body");
    assert.deepEqual((await measure()).controls, layout.controls, "Scrolling keeps the entire tab index stationary");
    await capture("short-phone-end-light");
    await omowright.emulate(page, "iphone-14");
    await visible("#details-dialog:modal");
    assert.deepEqual((await measure()).overflow, [0, 0, 0]);
    assert(await focus(tab));
    await page.evaluate(() => { document.querySelector("#details-scroll").scrollTop = 0; });
    await capture("phone-light");
    await theme("dark");
    await capture("phone-dark");
    await theme("light");
    await page.locator(tab).press("ArrowLeft");
    assert(await focus("#runtime-open-todo"));
    await page.locator("#runtime-open-todo").press("ArrowRight");
    assert(await focus(tab));
    assert.equal(await count(), 1, "Returning to a tab within the same open inspector reuses its snapshot");
    await refresh();
    await visible(`${panel} section`, "已连接");
    await section("MCP 服务", /local-fixture.*已连接.*3 个工具/);
    assert.equal(await count(), 2, "Explicit refresh reads and renders the new native status");
    await page.locator(tab).press("Escape");
    assert(await focus("#details-button"), "Modal Escape restores inspector trigger");

    await omowright.emulate(page, "desktop-1440");
    await selectSession("legacy");
    await openCapabilities();
    await visible(`${panel} section`, "当前不可用");
    await section("已加载扩展", /当前不可用/);
    await section("MCP 服务", /当前不可用/);
    await section("注册命令与技能", /\$pdf-tools/);
    assert.doesNotMatch(await rendered(), /不支持能力清单|未报告任何/);
    await capture("partial-unavailable-legacy");

    await selectSession("bounded");
    await openCapabilities();
    await visible(`${panel} section`, "extension-127");
    assert.doesNotMatch(await section("MCP 服务", /清单不完整/), /未报告任何/);
    const scrollTop = await page.evaluate(() => {
      const scroller = document.querySelector("#details-scroll");
      scroller.scrollTop = scroller.clientHeight;
      return scroller.scrollTop;
    });
    assert(scrollTop > 0);
    const boundedReads = await count();
    await omowright.emulate(page, mobile);
    await visible("#details-dialog:modal");
    assert.equal(await page.evaluate(() => document.querySelector("#details-scroll").scrollTop), scrollTop);
    assert.equal(await count(), boundedReads);
    await omowright.emulate(page, "desktop-1440");
    await visible("#details-dialog[open]:not(:modal)");

    await selectSession("passive");
    await nextResponse({ hold: true });
    await openCapabilities();
    await visible(panel, "正在读取能力清单");
    await waitHeld();
    await capture("held");
    const pendingCount = await count();
    // Repeated keyboard activation while the actual request is pending.
    await page.locator("#details-refresh").press("Enter");
    assert.equal(await count(), pendingCount);
    await selectSession("empty");
    assert.equal(await capabilityText(), "");
    await openCapabilities();
    await visible(`${panel} section`, "未报告任何");
    await finishHeld();
    for (const heading of ["注册命令与技能", "已加载扩展", "MCP 服务"]) await section(heading, /未报告任何/);
    assert.doesNotMatch(await rendered(), /local-fixture|pdf-tools|清单不完整|当前不可用/);
    await capture("explicitly-empty-after-switch");

    for (const [result, text] of [
      [{ status: 404, code: "not_found" }, "不支持能力清单"],
      [{ status: 409, code: "session_changed" }, "无法读取能力清单"],
      [{ status: 500, code: "fixture_failure" }, "无法读取能力清单"],
    ]) {
      await nextResponse(result);
      const before = await count();
      await refresh();
      await visible(panel, text);
      assert.equal(await count(), before + 1, "Failed reads never auto-retry");
      assert.doesNotMatch(await rendered(), /QA-private-diagnostic|未报告任何/);
      await capture(`http-${result.status}`);
    }
    await refresh();
    await visible(`${panel} section`, "未报告任何");

    await selectSession("passive");
    await openCapabilities();
    await visible(`${panel} section`, "已连接");
    await nextResponse({ hold: true });
    await refresh();
    await visible(panel, "正在读取能力清单");
    await waitHeld();
    assert.doesNotMatch(await rendered(), /local-fixture|pdf-tools/);
    await page.locator("#details-refresh").press("Escape");
    assert(await focus("#details-button"), "Non-modal Escape restores inspector trigger");
    assert.equal(await capabilityText(), "");
    await finishHeld();
    assert.equal(await capabilityText(), "");
    await openCapabilities();
    await visible(`${panel} section`, "已连接");
    await section("MCP 服务", /local-fixture.*已连接.*3 个工具/);
    assert.equal(await page.evaluate(() => window.inventoryProbe.writes), 0);
    assert.equal(await page.evaluate(() => window.inventoryProbe.errors), 0);
    const reads = await page.evaluate(() => window.inventoryProbe.reads);
    assert(reads.every(({ method, noToken }) => method === "GET" && noToken));
    assert(reads.every(({ path }) => [...ids.values()].some(id => path === `/api/sessions/${id}/capabilities`)));
    await capture("refreshed-connected");
    console.log(`INVENTORY_FIXTURE_BROWSER_OK ${JSON.stringify({ reads: reads.length, mobile: "320x480", tabTargets: layout.controls.filter(control => control.id.startsWith("runtime-open-")),
      proof: ["commandless", "origins", "native statuses and counts", "empty vs partial vs unavailable", "HTTP states",
        "held switch and close", "no writes or automatic retries", "keyboard", "responsive and fixed tabs"] })}`);
  }
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
