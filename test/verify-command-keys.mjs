// Run with the same owned Chrome/OmOWright paths as verify-inventory-browser.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const { OMO_HANDOFF_OMOWRIGHT: loader, OMO_HANDOFF_CHROMIUM: browserPath } = process.env;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const root = await mkdtemp(join(tmpdir(), "omo-command-keys-"));
const cwd = join(root, "workspace");
const profile = join(root, "agent");
const storageRoot = join(root, "browser");
const extension = join(root, "command-keys.ts");
const baseline = process.argv.includes("--baseline");
let app, browser;

try {
  await Promise.all([mkdir(cwd), mkdir(storageRoot), mkdir(join(profile, "prompts"), { recursive: true })]);
  const names = Array.from({ length: 12 }, (_, i) => `command-keys-${String(i + 1).padStart(2, "0")}`);
  for (const name of names) {
    const skill = `skill-${name}`;
    await mkdir(join(profile, "skills", skill), { recursive: true });
    await writeFile(join(profile, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Keyboard test fixture\n---\nNever invoked.\n`);
    await writeFile(join(profile, "prompts", `prompt-${name}.md`), "Keyboard test fixture (never invoked).\n");
  }
  await writeFile(extension, `export default function (pi) {
    ${names.map(name => `pi.registerCommand("extension-${name}", { description: "Keyboard test fixture",
      handler() { throw new Error("The chooser must never execute a command"); } });`).join("\n")}
  }\n`);
  app = await startApp({
    dataDir: join(root, "web"), cliAgentDir: profile, workspaces: [cwd], port: 0,
    engineCommand: ["env", "-i", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, `HOME=${root}`,
      `TMPDIR=${root}`, `OMO_CODING_AGENT_DIR=${profile}`, `SENPI_CODING_AGENT_DIR=${profile}`, `PI_CODING_AGENT_DIR=${profile}`,
      process.env.OMO_WEB_INVENTORY_BIN || "senpi", "--mode", "rpc", "--multi-session", "--session-runtime", "in-process",
      "--offline", "--no-approve", "--no-extensions", "--extension", extension],
  });
  const get = async path => {
    const response = await fetch(new URL(path, app.url), { signal: AbortSignal.timeout(15_000) })
      .catch(cause => { throw new Error(`Could not read ${path}`, { cause }); });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const boot = await get("/api/bootstrap");
  assert.equal(boot.engine.online, true, JSON.stringify(boot.engine));
  const session = await fetch(new URL("/api/sessions", app.url), {
    method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name: "Command keys" }), signal: AbortSignal.timeout(15_000),
  }).catch(cause => { throw new Error("Could not create the isolated session", { cause }); });
  assert.equal(session.status, 201);
  const { session: { id } } = await session.json();
  const { commands } = await get(`/api/sessions/${id}/options`);
  if (!baseline) {
    for (const [source, prefix] of [["prompt", "/prompt-"], ["skill", "$skill-"], ["extension", "/extension-"]]) {
      assert.deepEqual(commands.filter(row => row.source === source && row.invocation.startsWith(prefix)).map(row => row.invocation).sort(),
        names.map(name => prefix + name));
    }
  }
  browser = await omowright.connectPipe({
    browserPath, storageRoot, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`],
  });
  const page = await browser.newTab("about:blank");
  const sid = await page.resolveSessionId();
  const cdp = (method, params) => page.cdp.send(method, params, sid);
  const appBundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser", minify: true });
  const appBody = Buffer.from(await appBundle.outputs[0].arrayBuffer()).toString("base64");
  page.cdp.on("Fetch.requestPaused", ({ requestId }) => cdp("Fetch.fulfillRequest", {
    requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: appBody,
  }));
  await cdp("Fetch.enable", { patterns: [{ urlPattern: `${app.url.origin}/app.js` }] });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${() => {
    window.commandWrites = [];
    const fetchApp = window.fetch.bind(window);
    window.fetch = (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/actions")) window.commandWrites.push(String(url));
      return fetchApp(url, init);
    };
  }})()` });
  if (baseline) {
    // The reported reproduction used a catalog with /clone first. This
    // installed build also exposes commands sorting before it (e.g. /account).
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${() => {
      const fetchApp = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        const result = await fetchApp(url, init);
        if (!String(url).endsWith("/options") || !result.ok) return result;
        const options = await result.json();
        options.commands = options.commands.filter(row => row.invocation.localeCompare("/clone") >= 0);
        return Response.json(options);
      };
    }})()` });
  }
  await omowright.emulate(page, "desktop-1440");
  await page.goto(app.url.origin);

  const wait = (selector, visible = true) => page.evaluate(({ selector, visible }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Not ready: ${selector}`)); }, 8000);
    const check = () => {
      const node = document.querySelector(selector);
      if (!node || (visible && !node.getClientRects().length)) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    check();
  }), { selector, visible });
  const sessionLink = `button.session-link[data-session="${id}"]`;
  await wait(sessionLink);
  await page.locator(sessionLink).click();
  await wait("#command-mode:not(:disabled)");
  const prompt = page.locator("#prompt");
  const key = async (name, modifiers = 0) => {
    const windowsVirtualKeyCode = { ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33, Enter: 13, Escape: 27, Tab: 9 }[name];
    const params = { key: name, code: name, modifiers, windowsVirtualKeyCode };
    await cdp("Input.dispatchKeyEvent", name === "Enter"
      ? { type: "keyDown", ...params, text: "\r", unmodifiedText: "\r" }
      : { type: "rawKeyDown", ...params });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  };
  const selected = () => page.evaluate(() => document.querySelector('#inline-commands li[aria-selected="true"] code')?.textContent ?? null);
  const fixture = async value => {
    await prompt.fill(value);
    await wait("#inline-commands:not([hidden]) > li");
  };
  await fixture("/");
  const sequence = [];
  for (let i = 0; i < 8; i++) {
    await key("ArrowDown");
    sequence.push(await selected());
  }
  if (baseline) {
    assert.equal(sequence[0], "/clone");
    assert.equal(sequence[7], "/clone");
    console.log("COMMAND_KEYS_BASELINE", sequence);
  } else {
    assert.equal(new Set(sequence).size, 8, `Arrow traversal must cross row seven: ${sequence}`);
    const geometry = () => page.evaluate(() => {
      const pop = document.querySelector("#inline-commands");
      const row = pop.querySelector('[aria-selected="true"]');
      const edge = pop.getBoundingClientRect().top + pop.clientTop;
      const rect = row?.getBoundingClientRect();
      return {
        popup: pop.scrollTop, bounded: pop.clientHeight < pop.scrollHeight,
        visible: rect && rect.top >= edge - 1 && rect.bottom <= edge + pop.clientHeight + 1,
        ancestors: [...document.querySelectorAll("*")].filter(node => node !== pop && node.scrollTop).map(node => node.scrollTop),
        focused: document.activeElement === document.querySelector("#prompt"),
      };
    });
    const outcome = () => page.evaluate(() => ({
      text: document.querySelector("#prompt").value,
      closed: document.querySelector("#inline-commands").hidden,
    }));
    const pressTimes = async (n, name) => { for (let i = 0; i < n; i++) await key(name); };
    const guard = (selector, key, options) => page.evaluate(({ selector, key, options }) =>
      document.querySelector(selector).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })),
    { selector, key, options });
    const catalogCases = [
      ["/prompt-command-keys-", "/prompt-"], ["$", "$skill-"], ["/extension-command-keys-", "/extension-"],
      ["/skill:skill-command-keys-", "$skill-"],
    ];
    for (const [query, prefix] of catalogCases) {
      await fixture(query);
      const expected = names.map(name => prefix + name);
      const rows = await page.evaluate(() => [...document.querySelectorAll("#inline-commands li code")].map(row => row.textContent));
      assert.deepEqual(rows.filter(row => row.startsWith(prefix + "command-keys-")), expected);
      const initial = await geometry();
      if (query === "$") await fixture("$skill-command-keys-");
      await pressTimes(8, "ArrowDown");
      assert.equal(await selected(), expected[7]);
      const eighth = await geometry();
      assert(eighth.bounded && eighth.visible && eighth.focused && eighth.popup > 0);
      assert.deepEqual(eighth.ancestors, initial.ancestors, "Only the popup should scroll");
      await key("PageDown");
      const afterPage = expected.indexOf(await selected());
      assert(afterPage > 8);
      await key("PageUp");
      assert(expected.indexOf(await selected()) < afterPage - 1);
      assert((await geometry()).visible);
      const active = await selected();
      for (const field of ["altKey", "ctrlKey", "metaKey", "shiftKey", "isComposing"]) {
        assert.equal(await guard("#prompt", "ArrowDown", { [field]: true }), true);
        assert.equal(await selected(), active);
      }
      assert.equal(await guard("#prompt", "Enter", { isComposing: true }), true);
      assert.equal(await selected(), active);
      await key("Enter");
      assert.deepEqual(await outcome(), { text: active + " ", closed: true });
    }
    await fixture("/prompt-command-keys-");
    await key("ArrowUp");
    assert.equal(await selected(), "/prompt-command-keys-12");
    await key("Escape");
    assert.deepEqual(await outcome(), { text: "/prompt-command-keys-", closed: true });
    await page.evaluate(() => document.querySelector("#prompt").dispatchEvent(new Event("input", { bubbles: true })));
    assert.equal((await outcome()).closed, true, "Dismissal survives rerender with the same text");
    await fixture("/prompt-command-keys-0");
    await page.evaluate(() => document.querySelector("#prompt").dispatchEvent(new CompositionEvent("compositionstart")));
    assert.equal((await outcome()).closed, true);
    assert.equal(await guard("#prompt", "Enter", {}), true);
    await page.evaluate(() => document.querySelector("#prompt").dispatchEvent(new CompositionEvent("compositionend")));
    await fixture("/prompt-command-keys-");
    await key("ArrowDown");
    await key("Tab");
    assert.deepEqual(await outcome(), { text: "/prompt-command-keys-01 ", closed: true });

    // Wire the shipped dialog DOM exactly as the application integration will,
    // without changing app.ts or simulating insertion through a separate path.
    const source = await Bun.file("src/web/command-list-keys.ts").text();
    const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replace(/^export(?=\s)/gm, "");
    const install = await cdp("Runtime.evaluate", { expression: `(() => {
      ${script}
      bindCommandListKeys(document.querySelector("#command-dialog"), document.querySelector("#command-search"),
        document.querySelector("#command-list"));
    })()` });
    assert(!install.exceptionDetails, JSON.stringify(install.exceptionDetails));
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 480, deviceScaleFactor: 1, mobile: false });
    await page.locator("#command-mode").click();
    await page.locator("#command-picker").click();
    await wait("#command-list button[data-invocation='/prompt-command-keys-12']");
    const filter = page.locator("#command-search");
    const modalFocus = () => page.evaluate(() => document.activeElement.dataset.invocation ?? document.activeElement.id);
    await filter.fill("prompt-command-keys-");
    const modalRows = await page.evaluate(() =>
      [...document.querySelectorAll("#command-list button")].map(button => button.dataset.invocation));
    assert.deepEqual([...modalRows].sort(), names.map(name => "/prompt-" + name));
    assert.equal(await guard("#command-search", "ArrowDown", { isComposing: true }), true);
    assert.equal(await modalFocus(), "command-search");
    await key("PageUp");
    assert.equal(await modalFocus(), modalRows.at(-1));
    await filter.focus();
    await pressTimes(8, "ArrowDown");
    assert.equal(await modalFocus(), modalRows[7]);
    const modalScroll = () => page.evaluate(() => document.querySelector("#command-dialog").scrollTop);
    assert(await modalScroll() > 0);
    const beforePage = await modalScroll();
    await key("PageDown");
    const afterPage = modalRows.indexOf(await modalFocus());
    assert(afterPage > 8);
    assert(await modalScroll() > beforePage);
    await key("PageUp");
    assert(modalRows.indexOf(await modalFocus()) < afterPage - 1);
    assert(await page.evaluate(() => {
      const dialog = document.querySelector("#command-dialog");
      const edge = dialog.getBoundingClientRect().top + dialog.clientTop;
      const rect = document.activeElement.getBoundingClientRect();
      return rect.top >= edge - 1 && rect.bottom <= edge + dialog.clientHeight + 1;
    }), "The focused modal result should be visible after PageUp");
    const invocation = await modalFocus();
    await key("Enter");
    assert.deepEqual(await outcome(), { text: invocation + " ", closed: true });
    assert.equal(await page.evaluate(() => document.querySelector("#command-dialog").open), false);
    await page.locator("#command-picker").click();
    await wait("#command-list button[data-invocation='/extension-command-keys-12']");
    await filter.fill("extension-command-keys-12");
    await key("Enter");
    assert.deepEqual(await outcome(), { text: "/extension-command-keys-12 ", closed: true });
    assert.deepEqual(await page.evaluate(() => window.commandWrites), []);
    console.log("COMMAND_KEYS_BROWSER_OK: 12 native matches per source; inline arrows/pages/IME/dismissal/Tab; modal filter/rows/pages/Enter; zero action writes");
  }
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
