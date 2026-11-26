import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const secret = "RUNTIME_PRIVATE_CANARY";
const time = "2026-11-25T12:34:56.000Z";
const stamp = Date.parse(time);

if (process.argv[2] === "--runtime-fixture") {
  const states = new Map();
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line);
    const state = states.get(req.sessionId);
    const reply = (data, error) => process.stdout.write(`${JSON.stringify({
      type: "response", id: req.id, command: req.type, sessionId: req.sessionId,
      success: !error, data, ...(error ? { errorCode: "engine_refused", error } : {}),
    })}\n`);
    switch (req.type) {
      case "get_protocol_info": reply({ mode: "multi", protocolVersion: 1, serverVersion: "fixture" }); break;
      case "open_session": {
        const route = `route-${states.size + 1}`;
        const sessionId = `${secret}-${basename(req.sessionPath, ".jsonl")}`;
        const next = { sessionId, sessionFile: req.sessionPath, cwd: req.cwd, permissionPreset: "ask", isStreaming: false };
        states.set(route, next);
        reply({ sessionId: route, state: next, permissionPreset: "ask", permissionPresetStatus: "applied" });
        break;
      }
      case "get_state": reply(state); break;
      case "get_messages": reply({ messages: [] }); break;
      case "get_session_stats": reply({ contextUsage: state?.contextUsage }); break;
      case "get_tree": reply({ tree: [], leafId: null }); break;
      case "get_pending_inputs": reply({ inputs: [] }); break;
      case "get_available_models": reply({ models: [] }); break;
      case "get_available_thinking_levels": reply({ levels: [] }); break;
      case "get_commands": reply({ commands: [] }); break;
      case "get_loaded_surfaces": reply({ extensions: [], mcpServers: [] }); break;
      case "list_sessions": reply({ sessions: [] }); break;
      case "set_session_name": {
        const contextUsage = req.name === "live" ? { tokens: 0, contextWindow: 128000, percent: 0 } : undefined;
        states.set(req.sessionId, { ...state, sessionName: req.name, contextUsage });
        reply({});
        break;
      }
      case "set_client_info":
      case "close_session": reply({}); break;
      case "extension_request": {
        const name = state?.sessionName;
        if (name === "older") {
          reply({}, `Unknown extension RPC request: ${req.name}`);
        } else if (req.name === "omo.task.list") {
          reply({ parent_session_id: state?.sessionId, tasks: name === "empty" ? [] : [{
            task_id: secret, status: name === "partial" ? secret : "error", created_at: time, updated_at: time,
            description: secret, task_summary: secret, error_message: secret, final_response: secret,
          }] });
        } else if (req.name === "omo.dag.list") {
          reply({ ok: true, value: { limit: 256, runs: name === "empty" ? [] : [{
            runId: secret, name: secret, parentSessionId: name === "foreign" ? secret : state?.sessionId, status: "running",
            createdAt: time, updatedAt: time, counts: { total: 3 }, nodes: [{ prompt: secret }],
          }] } });
        } else if (req.name === "omo.memory.status") {
          reply({ schemaVersion: name === "partial" ? 2 : 1, identity: secret, repo: { path: secret },
            journal: { sessionId: state?.sessionId, totalSteps: name === "empty" ? 0 : 8,
              reflectedSteps: name === "empty" ? 0 : 5 }, reflection: { content: secret } });
        } else reply({}, `Unknown extension RPC request: ${req.name}`);
        break;
      }
      default: reply({}, "Unexpected fixture command");
    }
  }
} else {
  await verify();
}

function installBrowserProbe() {
  const fetchApp = window.fetch.bind(window);
  const probe = window.runtimeProbe = { reads: [], snapshots: [], writes: [], errors: [], hold: null, held: {}, released: {}, failRuntime: false };
  for (const event of ["error", "unhandledrejection"]) window.addEventListener(event, () => probe.errors.push(event));
  window.fetch = async (path, init) => {
    const url = new URL(typeof path === "string" ? path : path.url, location.href);
    if (init?.method === "POST") probe.writes.push(url.pathname);
    if (url.pathname.endsWith("/activity")) probe.snapshots.push(url.pathname);
    const key = url.pathname.split("/").at(-1);
    if (key !== "native-runtime" && key !== "details") return fetchApp(path, init);
    const isRuntime = key === "native-runtime";
    const hold = probe.hold?.includes(key);
    if (hold) probe.hold = probe.hold.filter(name => name !== key);
    const fail = isRuntime && probe.failRuntime;
    if (fail) probe.failRuntime = false;
    const response = fail ? Response.json({ code: "internal_error", error: "isolated runtime failure" }, { status: 500 })
      : await fetchApp(path, hold ? { ...init, signal: undefined } : init);
    const read = { path: url.pathname, method: init?.method, status: response.status,
      hasToken: new Headers(init?.headers).has("X-OmO-Token") };
    if (isRuntime) probe.reads.push(read);
    if (hold) {
      await new Promise(resolve => {
        probe.held[key] = resolve;
        window.dispatchEvent(new Event(`${key}-reply-held`));
      });
      delete probe.held[key];
      const json = response.json.bind(response);
      response.json = async () => {
        const parsed = await json();
        probe.released[key] = true;
        return parsed;
      };
    }
    return response;
  };
}

async function verify() {
  const { OMO_HANDOFF_OMOWRIGHT: loader, OMO_HANDOFF_CHROMIUM: browserPath } = process.env;
  assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
  const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
  const { omowright } = await loadOmowright();
  const detector = process.env.OMO_RUNTIME_DETECT
    ? await import(pathToFileURL(resolve(process.env.OMO_RUNTIME_DETECT)).href) : undefined;
  const native = process.argv.includes("--native");
  const nativeBin = process.env.OMO_WEB_REAL_RUNTIME_BIN;
  assert(!native || nativeBin, "Set OMO_WEB_REAL_RUNTIME_BIN for isolated native mode");
  const root = await mkdtemp(join(tmpdir(), "omo-runtime-browser-"));
  const evidence = resolve(process.env.OMO_RUNTIME_EVIDENCE ?? "artifacts/qa/native-runtime-ui/after");
  const cwd = join(root, "workspace");
  const profile = join(root, "agent");
  const storageRoot = join(root, "browser");
  const home = join(root, "home");
  let app;
  let browser;
  try {
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(storageRoot), mkdir(join(profile, "herdr-dag"), { recursive: true }),
      mkdir(evidence, { recursive: true })]);
    if (native) {
      await Promise.all([
        writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", quietStartup: true })),
        writeFile(join(profile, "models.json"), JSON.stringify({ providers: {
          fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-never-used",
            models: [{ id: "fixture", name: "Only for offline registry", contextWindow: 128000, maxTokens: 4096 }] },
        } })),
      ]);
    }
    const engineCommand = native
      ? ["/usr/bin/bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/",
        "--dev", "/dev", "--proc", "/proc", "--bind", root, root, "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", home, "--setenv", "TMPDIR", root,
        ...["CONFIG", "CACHE", "STATE", "DATA"].flatMap(name => ["--setenv", `XDG_${name}_HOME`, join(root, name.toLowerCase())]),
        ...["OMO", "SENPI", "PI"].flatMap(name => ["--setenv", `${name}_CODING_AGENT_DIR`, profile]),
        "--chdir", cwd, process.execPath, "--no-env-file", nativeBin, "--mode", "rpc", "--multi-session", "--offline",
        "--no-approve", "--session-runtime", "in-process", "--omo-senpi-builtin-mcps-disabled"]
      : [process.execPath, fileURLToPath(import.meta.url), "--runtime-fixture"];
    app = await startApp({ dataDir: join(root, "web"), cliAgentDir: profile, workspaces: [cwd],
      port: 0, engineCommand });
    const assetHashes = async () => Object.fromEntries(await Promise.all(
      ["/app.js", "/", "/styles.css", "/workbench.css"].map(async path => {
        const response = await fetch(new URL(path, app.url));
        assert.equal(response.status, 200, `Check the served asset: ${path}`);
        return [path, new Bun.CryptoHasher("sha256").update(await response.arrayBuffer()).digest("hex")];
      }),
    ));
    const assets = await assetHashes();
    const boot = await (await fetch(new URL("/api/bootstrap", app.url))).json();
    assert.equal(boot.engine.online, true);
    const ids = new Map();
    for (const name of native ? ["native-a", "native-b"] : ["live", "empty", "older", "partial", "foreign"]) {
      const response = await fetch(new URL("/api/sessions", app.url), {
        method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name }),
      });
      assert.equal(response.status, 201, `Create isolated session: ${name}`);
      ids.set(name, (await response.json()).session.id);
    }
    for (const [name, id] of ids) {
      const response = await fetch(new URL(`/api/sessions/${id}/native-runtime`, app.url));
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(secret));
      if (name === "live") {
        const { tasks, dag, memory } = JSON.parse(body);
        assert.deepEqual(tasks, { status: "ok", rows: [{ status: "error", createdAt: stamp, updatedAt: stamp }], omittedCount: 0 });
        assert.deepEqual(dag, { status: "ok", rows: [{ status: "running", createdAt: stamp, updatedAt: stamp, nodeCount: 3 }], limitReached: false });
        assert.deepEqual(memory, { status: "ok", totalSteps: 8, reflectedSteps: 5 });
      } else if (native || name === "empty") {
        assert.deepEqual(JSON.parse(body), {
          tasks: { status: "empty" }, dag: { status: "empty" },
          memory: { status: "ok", totalSteps: 0, reflectedSteps: 0 },
        });
        const session = await (await fetch(new URL(`/api/sessions/${id}`, app.url))).json();
        assert.deepEqual(session.messages, []);
      }
    }
    if (!native) {
      for (const [i, owner] of ["older", "empty", "live", "foreign"].entries()) {
        await writeFile(join(profile, "herdr-dag", `${String(i).repeat(24)}.json`), JSON.stringify({
          version: 1, sessionId: `${secret}-${ids.get(owner)}`, connected: false, language: "zh-CN", updatedAt: stamp,
          tasks: [{ id: secret, description: secret, agent: secret, model: secret, status: "done", startedAt: stamp }],
          runs: [{ id: secret, name: secret, status: "completed", createdAt: stamp, updatedAt: stamp,
            nodes: [{ id: "n1", label: secret, state: "done", attempt: 1, taskId: secret }], edges: [] }],
        }));
      }
      const activity = await (await fetch(new URL(`/api/sessions/${ids.get("older")}/activity`, app.url))).json();
      assert.equal(activity.status, "ok", "Legacy snapshot privacy test requires actual disk data");
      assert.equal(activity.tasks[0].description, secret);
    }

    browser = await omowright.connectPipe({
      browserPath, storageRoot, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`],
    });
    const page = await browser.newTab("about:blank");
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBrowserProbe})()` },
      await page.resolveSessionId());
    await omowright.emulate(page, "desktop-1440");
    await page.goto(app.url.origin);
    const visible = (selector, pattern = "") => page.evaluate(({ selector, pattern }) => new Promise((done, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Not visible: ${selector} / ${pattern}`));
      }, 5000);
      function check() {
        if (![...document.querySelectorAll(selector)].some(node =>
          node.getClientRects().length && new RegExp(pattern).test(node.textContent))) return;
        clearTimeout(timer);
        observer.disconnect();
        done(true);
      }
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    }), { selector, pattern });
    const click = async selector => { await visible(selector); await page.locator(selector).click(); };
    const select = async name => {
      await click(`.session-link[data-session="${ids.get(name)}"]`);
      await visible("#session-title", `^${name}$`);
      await visible("#details-button:not([hidden])");
    };
    const tasks = "#runtime-subagent";
    const dag = "#runtime-dag";
    const journal = "#runtime-journal";
    const metrics = "#runtime-metrics";
    const compat = "#runtime-compatibility";
    const scroll = "#details-scroll";
    const tab = name => `#runtime-open-${name}`;
    const tabClick = name => click(tab(name));
    const focus = selector => page.evaluate(selector => document.activeElement.matches(selector), selector);
    const text = selector => page.evaluate(selector => document.querySelector(selector).textContent, selector);
    const detailsHtml = () => page.evaluate(() => document.querySelector("#details-dialog").innerHTML);
    const privacy = async () => assert.doesNotMatch(await detailsHtml(), new RegExp(secret));
    const theme = value => page.evaluate(value => {
      const target = document.querySelector("#theme");
      target.value = value;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    const mobile = { width: 320, height: 480, deviceScaleFactor: 1, mobile: true, hasTouch: true };
    const mobileMeasure = () => page.evaluate(scroll => {
      const root = document.documentElement;
      const scroller = document.querySelector(scroll);
      const buttons = [...document.querySelectorAll("#runtime-shortcuts [role=tab], #details-refresh, #details-dialog [data-close]")];
      return { overflow: [root.scrollWidth - root.clientWidth, scroller.scrollWidth - scroller.clientWidth],
        targets: buttons.map(button => {
          const { width, height, left, right, top, bottom, x, y } = button.getBoundingClientRect();
          const hit = document.elementFromPoint(x + width / 2, y + height / 2);
          const range = document.createRange();
          range.selectNodeContents(button);
          const label = range.getBoundingClientRect();
          return { width, height, left, right, top, bottom, hit: hit === button || button.contains(hit),
            fits: label.left >= left && label.right <= right && label.top >= top && label.bottom <= bottom };
        }) };
    }, scroll);
    const verifyMobile = async () => {
      const layout = await mobileMeasure();
      assert.deepEqual(layout.overflow, [0, 0], "Page and inspector must not scroll sideways at 320 CSS px");
      assert.equal(layout.targets.length, 7);
      assert(layout.targets.every(x => x.width >= 44 && x.height >= 44 && x.left >= 0 &&
        x.right <= 320 && x.top >= 0 && x.bottom <= 480 && x.hit && x.fits), JSON.stringify(layout));
      return layout;
    };
    const shots = [];
    const measurements = {};
    const colors = () => page.evaluate(() => {
      const dialog = document.querySelector("#details-dialog");
      const palette = getComputedStyle(dialog);
      const parse = color => (color.startsWith("#")
        ? color.slice(1).match(/../g).map(value => parseInt(value, 16))
        : color.match(/[\d.]+/g).slice(0, 3).map(Number))
        .map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      const luminance = color => parse(color).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (a, b) => {
        const [higher, lower] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (higher + .05) / (lower + .05);
      };
      const role = color => palette.getPropertyValue(`--runtime-${color}`).trim();
      const gradient = [role("head"), role("violet")];
      const text = [...dialog.querySelectorAll(
        ".details-toolbar :is(button, h2), .runtime-index button, [role=tabpanel] :is(h3, h4, dt, dd, p:not(.sr-only))",
      )].filter(node => {
        if (!node.textContent.trim()) return false;
        const { x, y, width, height } = node.getBoundingClientRect();
        const hit = document.elementFromPoint(x + width / 2, y + height / 2);
        return hit === node || node.contains(hit);
      }).map(node => {
        const style = getComputedStyle(node);
        const background = style.backgroundColor !== "rgba(0, 0, 0, 0)" ? [style.backgroundColor]
          : node.closest("[role=tabpanel]") ? [palette.backgroundColor] : gradient;
        return Math.min(...background.map(bg => contrast(bg, style.color)));
      });
      return { textMinimum: Math.min(...text),
        headerFocusMinimum: Math.min(...[...gradient, role("active")].map(bg => contrast(bg, role("signal")))) };
    });
    const capture = async (name, width = 1440, height = 900) => {
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
      if (width === 320) await verifyMobile();
      await privacy();
      assert.equal(await page.evaluate(() => document.querySelector("#compose-error").hidden), true,
        "An unrelated composer error must not pollute runtime screenshots");
      const contrast = await colors();
      assert(contrast.textMinimum >= 4.5 && contrast.headerFocusMinimum >= 3, `${name}: ${JSON.stringify(contrast)}`);
      measurements[name] = contrast;
      const png = Buffer.from(await page.screenshot());
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height]);
      await writeFile(join(evidence, `${name}.png`), png);
      shots.push(`${name}.png`);
      if (detector) {
        const source = `(${detector.collectPageSnapshot})(${JSON.stringify(detector.STYLE_PROPS)}, 1500)`;
        const findings = detector.lintSnapshot(await page.evaluate(source));
        await writeFile(join(evidence, `${name}-detect.json`), JSON.stringify(findings, null, 2));
      }
    };
    const assertCounts = async (total, reflected) => assert.deepEqual(await page.evaluate(journal =>
      [...document.querySelectorAll(`${journal} dd`)].map(node => node.textContent), journal), [total, reflected]);
    const checkReadOnly = async panel => {
      assert.equal(await page.evaluate(panel => document.querySelector(panel).querySelectorAll(
        "button, input, textarea, select, [role=button], [contenteditable=true]").length, panel), 0);
    };
    const assertEmpty = async () => {
      await tabClick("subagents");
      await visible(tasks, "宿主报告当前没有子代理任务");
      await tabClick("dag");
      await visible(dag, "宿主报告当前没有 DAG 运行");
      await tabClick("todo");
      await visible(`${journal} dd`, "^0$");
      await assertCounts("0", "0");
      assert.doesNotMatch(await detailsHtml(), /磁盘快照 · 只读|正在读取会话记忆/);
    };
    const open = () => click("#details-button");
    const close = () => page.locator("#runtime-shortcuts [aria-selected=true]").press("Escape");
    const scrollEnd = async () => assert(await page.evaluate(scroll => {
      const el = document.querySelector(scroll);
      el.scrollTop = el.scrollHeight;
      return el.scrollTop > 0;
    }, scroll));

    if (native) {
      assert.equal(boot.engine.version, "2026.11.23");
      await select("native-a");
      await open();
      await assertEmpty();
      await capture("native-desktop-zero-light");
      await select("native-b");
      await open();
      await assertEmpty();
      await omowright.emulate(page, mobile);
      await visible("#details-dialog:modal");
      await theme("dark");
      await tabClick("subagents");
      await capture("native-320-empty-dark", 320, 480);
      await close();
      assert(await focus("#details-button"));
    } else {
      await select("live");
      await open();
      await visible(metrics, "128,000");
      assert.match(await text(metrics), /上下文已用（原生）0 \(0%\)上下文窗口128,000 token/);
      assert(await focus(tab("overview")));
      await page.locator(tab("overview")).press("ArrowRight");
      assert(await focus(tab("subagents")));
      await visible(tasks, "实时宿主");
      await visible(tasks, "出错");
      await checkReadOnly(tasks);
      await tabClick("dag");
      await visible(dag, "3 个节点");
      await checkReadOnly(dag);
      await tabClick("todo");
      await visible(`${journal} dd`, "^8$");
      await assertCounts("8", "5");
      await tabClick("capabilities");
      await visible(compat, "浏览器原生兼容未启用");
      assert.match(await text(compat), /本机 OmO.*不会启动终端、执行或重放命令.*会话管理 → 转到 CLI/);
      assert.equal(await page.evaluate(compat => document.querySelector(compat).querySelectorAll("button, a, code, input").length, compat), 0);
      await visible("#capabilities-content", "MCP 服务");
      assert.equal(await page.evaluate(() => window.runtimeProbe.snapshots.length), 0, "Do not read raw disk activity on live success");

      for (const [view, width, height] of [["desktop", 1440, 900], ["320", 320, 480]]) {
        if (width === 320) {
          await omowright.emulate(page, mobile);
          await visible("#details-dialog:modal");
        }
        for (const appearance of ["light", "dark"]) {
          await theme(appearance);
          for (const [pane, selector, pattern] of [["overview", metrics, "128,000"], ["subagents", tasks, "出错"],
            ["dag", dag, "3 个节点"], ["todo", journal, "已反思步数"], ["capabilities", compat, "浏览器原生兼容未启用"]]) {
            await tabClick(pane);
            await visible(selector, pattern);
            if (pane === "capabilities" && width === 320) await scrollEnd();
            await capture(`${view}-${appearance}-${pane}`, width, height);
          }
        }
      }
      await page.locator(tab("capabilities")).press("Home");
      await page.locator(tab("overview")).press("ArrowRight");
      assert(await page.evaluate(() => {
        const tab = document.activeElement;
        return tab.matches("#runtime-open-subagents:focus-visible") && getComputedStyle(tab).outlineStyle === "solid";
      }), "Keyboard-selected tab has a visible focus outline");
      await capture("320-keyboard-focus-dark", 320, 480);
      await page.locator(tab("subagents")).press("Tab");
      assert(await focus(tasks), "Tab moves from the selected tab to its panel");
      assert(await page.evaluate(() => {
        const before = document.activeElement;
        document.querySelector("#prompt").focus();
        return before === document.activeElement && document.activeElement.closest("dialog:modal");
      }), "The scene behind the modal cannot steal focus");
      const original = await verifyMobile();
      await page.evaluate(() => {
        const style = document.createElement("style");
        style.id = "runtime-spacing-test";
        style.textContent = "#details-dialog * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } #details-dialog p { margin-block-end: 2em !important; }";
        document.head.append(style);
      });
      const spaced = await verifyMobile();
      assert.deepEqual(spaced.targets, original.targets, "User text spacing keeps targets stable");
      await page.evaluate(() => document.querySelector("#runtime-spacing-test").remove());
      await page.locator(tasks).press("Escape");
      assert(await focus("#details-button"), "Modal Escape restores the trigger");
      await omowright.emulate(page, "desktop-1440");
      await theme("light");

      // Hold actual successful HTTP responses past abort from the previous view.
      await page.evaluate(() => { window.runtimeProbe.hold = ["native-runtime", "details"]; });
      await open();
      await visible(metrics, "正在读取上下文");
      await tabClick("subagents");
      await visible(tasks, "正在读取宿主");
      await tabClick("todo");
      await visible(journal, "正在读取会话记忆");
      assert.equal(await page.evaluate(journal => document.querySelectorAll(`${journal} dd`).length, journal), 0);
      await capture("desktop-held-waiting");
      await page.evaluate(() => Promise.all(["native-runtime", "details"].map(key => new Promise((done, reject) => {
        if (window.runtimeProbe.held[key]) { done(); return; }
        const abort = new AbortController();
        const timer = setTimeout(() => { abort.abort(); reject(new Error(`No held ${key} HTTP reply`)); }, 5000);
        window.addEventListener(`${key}-reply-held`, () => { clearTimeout(timer); done(); }, { once: true, signal: abort.signal });
      }))));
      await select("empty");
      await open();
      await assertEmpty();
      await page.evaluate(async () => {
        for (const release of Object.values(window.runtimeProbe.held)) release();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.deepEqual(await page.evaluate(() => window.runtimeProbe.released), { "native-runtime": true, details: true });
      await assertEmpty();
      await tabClick("overview");
      await visible(metrics, "上下文窗口");
      assert.match(await text(metrics), /上下文窗口—尚无数据/);
      assert.doesNotMatch(await text(metrics), /128,000/);
      assert.equal(await page.evaluate(() => window.runtimeProbe.snapshots.length), 0, "Explicit empty does not fall back over disk records");
      await tabClick("todo");
      await capture("desktop-empty-after-switch");

      await select("older");
      await open();
      await tabClick("subagents");
      await visible(tasks, "当前宿主或连接方式不支持");
      await visible(tasks, "任务 1 · 已完成");
      assert.match(await text(tasks), /磁盘快照 · 只读.*保存时间：.*非实时/);
      await tabClick("dag");
      await visible(dag, "1 个节点");
      await capture("desktop-older-dag-snapshot");
      await tabClick("todo");
      await visible(journal, "不可用");
      assert.equal(await page.evaluate(journal => document.querySelectorAll(`${journal} dd`).length, journal), 0);
      await omowright.emulate(page, mobile);
      await visible("#details-dialog:modal");
      await theme("dark");
      await tabClick("subagents");
      await capture("320-older-task-snapshot-dark", 320, 480);
      await close();
      await omowright.emulate(page, "desktop-1440");
      await page.evaluate(() => { window.runtimeProbe.failRuntime = true; });
      await open();
      await tabClick("subagents");
      await visible(tasks, "读取失败");
      assert.doesNotMatch(await text(tasks), /磁盘快照|任务 1/, "Generic runtime failure is not evidence for a legacy fallback");
      assert.equal(await page.evaluate(() => window.runtimeProbe.snapshots.length), 1, "The failed read must not fetch disk activity");

      await select("partial");
      await open();
      await tabClick("subagents");
      await visible(tasks, "摘要格式无效");
      assert.doesNotMatch(await text(tasks), /磁盘快照|任务 1/);
      await tabClick("dag");
      await visible(dag, "3 个节点");
      await tabClick("todo");
      await visible(journal, "不支持");
      await capture("desktop-partial-memory-dark");

      await select("foreign");
      await open();
      await tabClick("dag");
      await visible(dag, "会话归属已变化");
      assert.doesNotMatch(await text(dag), /磁盘快照|3 个节点/);
      await tabClick("subagents");
      await visible(tasks, "出错");
      await privacy();
    }
    const probe = await page.evaluate(() => {
      const { reads, writes, errors, snapshots } = window.runtimeProbe;
      return { reads, writes, errors, snapshots };
    });
    assert(probe.reads.some(({ status }) => status === 200) && probe.reads.every(({ path, method, hasToken }) =>
      method === "GET" && !hasToken && [...ids.values()].some(id => path === `/api/sessions/${id}/native-runtime`)));
    assert.deepEqual(probe.reads.filter(({ status }) => status !== 200),
      native ? [] : [{ path: `/api/sessions/${ids.get("older")}/native-runtime`, method: "GET", status: 500, hasToken: false }]);
    assert.deepEqual(probe.writes, [], "Inspector, local instructions and action affordances do not write");
    assert.deepEqual(probe.errors, []);
    assert.deepEqual(probe.snapshots, native ? [] : [`/api/sessions/${ids.get("older")}/activity`]);
    assert.deepEqual(await assetHashes(), assets, "Served app and styles must not change during capture");
    const summary = { mode: native ? "isolated private stdio" : "local RPC fixture", version: boot.engine.version,
      chromium: await page.evaluate(() => navigator.userAgent.match(/(?:Headless)?Chrome\/([0-9.]+)/)?.[1]),
      reads: probe.reads.length, snapshots: probe.snapshots.length, writes: probe.writes.length, errors: probe.errors.length,
      assets, shots, measurements };
    await writeFile(join(evidence, native ? "real-native.json" : "fixture.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`NATIVE_RUNTIME_BROWSER_OK ${JSON.stringify({ ...summary, measurements: Object.keys(measurements).length })}`);
  } finally {
    try { await browser?.close(); } finally {
      try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}
