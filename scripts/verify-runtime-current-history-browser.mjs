import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";
import { runReplay } from "./runtime-current-history-replay.mjs";
import { runDagDensityReplay } from "./runtime-dag-density-replay.mjs";
import { runExecutionReplay } from "./runtime-execution-replay.mjs";

function installProbe() {
  const realFetch = window.fetch.bind(window);
  const probe = window.runtimeProbe = { reads: [], held: {}, drained: {}, next: null, errors: [] };
  for (const event of ["error", "unhandledrejection"]) window.addEventListener(event, () => probe.errors.push(event));
  window.fetch = async (input, init) => {
    const { pathname, search } = new URL(typeof input === "string" ? input : input.url, location.href);
    const route = pathname + search;
    probe.reads.push({ route, method: init?.method ?? "GET" });
    const next = probe.next;
    if (!next || !route.endsWith(next.route)) return realFetch(input, init);
    probe.next = null;
    if (next.mode === "fail") return Response.json({ code: "internal_error", error: "fixture read failure" }, { status: 500 });
    const response = await realFetch(input, next.mode === "hold" ? { ...init, signal: undefined } : init);
    if (next.mode === "mismatch") return Response.json({ ...await response.json(), leafId: "wrong-fixture-leaf" });
    if (next.mode === "stale-child") {
      const data = await response.json();
      return Response.json({ ...data, nodes: data.nodes.map(({ taskKey, ...node }) => node) });
    }
    await new Promise(done => { probe.held[next.route] = done; });
    delete probe.held[next.route];
    const parse = response.json.bind(response);
    response.json = async () => {
      const data = await parse();
      requestAnimationFrame(() => requestAnimationFrame(() => { probe.drained[next.route] = true; }));
      return data;
    };
    return response;
  };
}

const baseline = process.argv.includes("--baseline");
const density = process.argv.includes("--density");
const execution = process.argv.includes("--execution");
const evidence = resolve(process.env.OMO_RUNTIME_EVIDENCE ??
  (execution ? ".omo/evidence/dag-node-agent-details/chromium"
    : density ? ".omo/evidence/runtime-current-history/dag-density" : ".omo/evidence/runtime-current-history"));
const { OMO_HANDOFF_OMOWRIGHT: loader, OMO_HANDOFF_CHROMIUM: browserPath } = process.env;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { omowright } = await (await import(pathToFileURL(resolve(loader)).href)).loadOmowright();
const detector = process.env.OMO_RUNTIME_DETECT
  ? await import(pathToFileURL(resolve(process.env.OMO_RUNTIME_DETECT)).href) : undefined;
const root = await mkdtemp(join(tmpdir(), "omo-runtime-history-browser-"));
const cwd = join(root, "workspace");
const profile = join(root, "agent");
const scroller = "#details-scroll";
const todo = "#runtime-todo";
const dag = "#runtime-dag";
const history = kind => `#runtime-${kind}-history`;
const current = kind => `${kind === "todo" ? todo : dag} > ${kind === "todo" ? "[data-runtime-branch]" : "#runtime-dag-current"}`;
const details = "#details-dialog";
let app;
let browser;

try {
  await Promise.all([mkdir(cwd), mkdir(join(profile, "herdr-dag"), { recursive: true }),
    mkdir(join(evidence, baseline ? "before" : "after"), { recursive: true })]);
  app = await startApp({ dataDir: join(root, "web"), cliAgentDir: profile, workspaces: [cwd], port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("runtime-current-history-fixture.mjs", import.meta.url)),
      ...(execution ? ["--execution"] : density ? ["--density"] : [])] });
  const request = (path, body) => fetch(new URL(path, app.url), body === undefined ? undefined : {
    method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const assetHashes = async () => Object.fromEntries(await Promise.all(["/app.js", "/", "/styles.css", "/workbench.css", "/dag-graph.css"].map(async path => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return [path, new Bun.CryptoHasher("sha256").update(await response.arrayBuffer()).digest("hex")];
  })));
  const assets = await assetHashes();
  const boot = await (await request("/api/bootstrap")).json();
  assert.equal(boot.engine.online, true);
  const ids = {};
  for (const name of ["Current fixture", "Other fixture", "Older fixture"]) {
    const response = await request("/api/sessions", { cwd, name });
    assert.equal(response.status, 201, await (response.ok ? Promise.resolve(name) : response.text()));
    ids[name] = (await response.json()).session.id;
  }
  const old = ids["Older fixture"];
  const stamp = Date.parse("2026-11-25T12:34:56.000Z");
  await writeFile(join(profile, "herdr-dag", `${"a".repeat(24)}.json`), JSON.stringify({
    version: 1, sessionId: old, connected: false, language: "en", updatedAt: stamp, tasks: [],
    runs: [{ id: "saved", name: "Private snapshot label", status: "completed", createdAt: stamp, updatedAt: stamp,
      nodes: [{ id: "saved-node", label: "Private node label", state: "done", attempt: 1 }], edges: [] }],
  }));
  assert.equal((await (await request(`/api/sessions/${old}/activity`)).json()).status, "ok", "The old host must have a readable disk fixture");
  browser = await omowright.connectPipe({ browserPath, storageRoot: join(root, "browser"), browserArgs: ["--headless", "--no-first-run"] });
  const page = await browser.newTab("about:blank");
  const session = await page.resolveSessionId();
  const init = `localStorage.setItem("omo-web-language", "en"); (${installProbe})(); window.EventSource = new Proxy(EventSource, { construct: (Type, args) => (window.runtimeProbe.events = new Type(...args)) });`;
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: init }, session);
  page.cdp.on("Page.javascriptDialogOpening", () => { void page.cdp.send("Page.handleJavaScriptDialog", { accept: true }, session); });
  await omowright.emulate(page, "desktop-1440");
  await page.goto(app.url.origin);
  const until = (predicate, argument, label) => page.evaluate(([source, arg, label]) => new Promise((done, fail) => {
    const check = Function(`return (${source})`)();
    const timer = setTimeout(() => fail(new Error(`Missing browser evidence: ${label}`)), 8000);
    const frame = () => {
      if (!check(arg)) { requestAnimationFrame(frame); return; }
      clearTimeout(timer);
      done(true);
    };
    frame();
  }), [String(predicate), argument, label]);
  const visible = (selector, needle = "") => until(([selector, needle]) => [...document.querySelectorAll(selector)].some(
    node => node.getClientRects().length && node.textContent.includes(needle)), [selector, needle], `${selector} / ${needle}`);
  const click = async selector => { await visible(selector); await page.locator(selector).click(); };
  const toggle = selector => click(`${selector} > summary`);
  const tab = name => click(`#runtime-open-${name}`);
  const text = selector => page.evaluate(selector => document.querySelector(selector)?.textContent ?? "", selector);
  const readCount = suffix => page.evaluate(suffix => window.runtimeProbe.reads.filter(row => row.route.endsWith(suffix)).length, suffix);
  const probeCount = () => page.evaluate(() => window.runtimeProbe.reads.filter(({ route }) =>
    /(?:todo-history|dag-history|scope=history|\/activity)$/u.test(route)).length);
  const arm = (route, mode) => page.evaluate(next => { window.runtimeProbe.next = next; delete window.runtimeProbe.drained[next.route]; },
    { route, mode });
  const held = route => until(route => window.runtimeProbe.held[route], route, `held ${route}`);
  const release = async route => {
    await page.evaluate(route => window.runtimeProbe.held[route](), route);
    await until(route => window.runtimeProbe.drained[route], route, `late reply drained ${route}`);
  };
  const collapsed = selector => page.evaluate(selector => !document.querySelector(selector).open, selector);
  const focus = selector => page.evaluate(selector => document.activeElement?.matches(selector), selector);
  const select = async name => {
    if (await page.evaluate(() => innerWidth <= 760)) await click("#open-navigation");
    await click(`.session-link[data-session="${ids[name]}"]`);
    await visible("#session-title", name);
    await visible("#details-button:not([hidden])");
  };
  const open = async () => {
    if (!await page.evaluate(() => document.querySelector("#details-dialog").open)) await click("#details-button");
  };
  const theme = value => page.evaluate(value => {
    const target = document.querySelector("#theme");
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const shots = [];
  const findings = {};
  const capture = async name => {
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const region = await page.evaluate(([dialog, scroller]) => {
      const box = document.querySelector(dialog).getBoundingClientRect();
      const scroll = document.querySelector(scroller);
      const summary = scroll.querySelector('[role="tabpanel"]:not([hidden]) > details[id$="-history"] > summary');
      const contrast = (a, b) => {
        const lightness = color => color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number)
          .map(component => component / 255).map(srgb => srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4)
          .reduce((total, linear, index) => total + linear * [.2126, .7152, .0722][index], 0);
        const [high, low] = [lightness(a), lightness(b)].sort((x, y) => y - x);
        return (high + .05) / (low + .05);
      };
      const summaryStyle = summary && getComputedStyle(summary);
      const disclosureStyle = summary && getComputedStyle(summary.parentElement);
      const summaryBg = summaryStyle?.backgroundColor === "rgba(0, 0, 0, 0)" ? disclosureStyle?.backgroundColor : summaryStyle?.backgroundColor;
      return { x: Math.ceil(Math.max(0, box.x)), y: Math.ceil(Math.max(0, box.y)),
        width: Math.floor(Math.min(innerWidth, box.right) - Math.ceil(Math.max(0, box.x))),
        height: Math.floor(Math.min(innerHeight, box.bottom) - Math.ceil(Math.max(0, box.y))),
        viewport: [innerWidth, innerHeight], scheme: getComputedStyle(document.body).colorScheme,
        overflow: scroll.scrollWidth - scroll.clientWidth,
        scrollOwners: [...scroll.querySelectorAll("*"), scroll].filter(node => {
          const style = getComputedStyle(node);
          return /auto|scroll/u.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        }).map(node => node.id || node.className),
        history: summaryStyle && { textContrast: contrast(summaryStyle.color, summaryBg),
          focusContrast: summary.matches(":focus-visible") ? contrast(summaryStyle.outlineColor, getComputedStyle(scroll).backgroundColor ===
            "rgba(0, 0, 0, 0)" ? getComputedStyle(scroll.closest("dialog")).backgroundColor : getComputedStyle(scroll).backgroundColor) : null,
          focusStyle: summaryStyle.outlineStyle },
      };
    }, [details, scroller]);
    assert.equal(region.overflow, 0);
    const widthCase = /-(1440|1100|390|320)-/u.exec(name);
    if (widthCase) assert.equal(region.viewport[0], Number(widthCase[1]), name);
    if (region.history) {
      assert(region.history.textContrast >= 4.5, `${name} History text contrast: ${region.history.textContrast}`);
      if (region.history.focusContrast !== null) {
        assert(region.history.focusContrast >= 3 && region.history.focusStyle === "solid",
          `${name} History keyboard focus: ${JSON.stringify(region.history)}`);
      }
    }
    const { x, y, width, height } = region;
    const { data } = await page.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true,
      clip: { x, y, width, height, scale: 1 } }, session);
    const png = Buffer.from(data, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const file = `${name}-${baseline ? "before" : "after"}.png`;
    await writeFile(join(evidence, baseline ? "before" : "after", file), png);
    shots.push({ file, ...region, png: [png.readUInt32BE(16), png.readUInt32BE(20)] });
    if (detector) findings[file] = detector.lintSnapshot(await page.evaluate(
      `(${detector.collectPageSnapshot})(${JSON.stringify(detector.STYLE_PROPS)}, 2000)`));
  };
  const ensureCurrent = async kind => {
    await tab(kind);
    if (kind === "todo") {
      const fold = `${todo} [data-runtime-branch] details`;
      await visible(`${fold} > summary`);
      if (await collapsed(fold)) await toggle(fold);
      await visible(`${todo} [data-runtime-branch]`, "Current-only item");
    } else await visible(dag, "1 node");
  };

  await select("Current fixture");
  await open();
  if (execution) {
    await runExecutionReplay({ baseline, page, tab, visible, toggle, click, text, focus, capture, open,
      theme, resize: size => omowright.emulate(page, size), current: current("dag"), history: history("dag"),
      probeCount, readCount, arm, held, release, select, ids });
  } else if (density) {
    await runDagDensityReplay({ baseline, page, tab, visible, toggle, click, text, focus, probeCount, readCount,
      capture, open, theme, resize: size => omowright.emulate(page, size), current: current("dag"), history: history("dag") });
  } else if (!baseline) {
    assert.equal(await probeCount(), 0, "Overview must not prefetch history");
    await ensureCurrent("todo");
    assert.equal(await readCount("/branch-runtime?scope=todo"), 1, "Todo must read the current-only route");
    await runReplay({ page, ids, request, visible, click, toggle, tab, text, readCount,
      probeCount, arm, held, release, collapsed, focus, select, open, capture, ensureCurrent,
      resize: size => omowright.emulate(page, size), theme, history, current });
  } else {
    for (const width of [1440, 390]) {
      if (width === 390) {
        await click(`${details} [data-close]`);
        await omowright.emulate(page, "iphone-14");
        await open();
      }
      for (const mode of ["light", "dark"]) {
        await theme(mode);
        for (const kind of ["todo", "dag"]) {
          await ensureCurrent(kind);
          await capture(`${kind}-current-${width}-${mode}`);
          await capture(`${kind}-history-${width}-${mode}`);
        }
      }
    }
  }
  assert.deepEqual(await assetHashes(), assets, "Browser evidence must match the unchanged served assets");
  assert.deepEqual(await page.evaluate(() => window.runtimeProbe.errors), []);
  if (detector) await writeFile(join(evidence, baseline ? "detect-before.json" : "detect-after.json"),
    `${JSON.stringify(findings, null, 2)}\n`);
  await writeFile(join(evidence, baseline ? "baseline.json" : "browser.json"),
    `${JSON.stringify({ assets, shots, requests: await page.evaluate(() => window.runtimeProbe.reads) }, null, 2)}\n`);
  console.log(`RUNTIME_CURRENT_HISTORY_${baseline ? "BASELINE" : "OK"} shots=${shots.length}`);
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
