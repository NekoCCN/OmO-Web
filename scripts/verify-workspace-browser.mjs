import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const root = await mkdtemp(join(tmpdir(), "omo-file-browser-"));
const approved = join(root, "approved");
const child = join(approved, "child");
const external = join(root, "需要确认的目录");
const evidence = process.env.OMO_WORKSPACE_EVIDENCE;
let app, browser;

function recordRequests() {
  const send = window.fetch.bind(window);
  window.directoryRequests = [];
  window.fetch = (url, options) => {
    if (options?.method === "POST") window.directoryRequests.push({
      path: new URL(url, location.href).pathname,
      body: JSON.parse(options.body),
    });
    return send(url, options);
  };
}

try {
  const storage = join(root, "browser");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(external), mkdir(storage), evidence && mkdir(evidence, { recursive: true })]);
  await Promise.all([
    writeFile(join(approved, "project-notes.txt"), "FILE_CONTENT_MUST_NOT_APPEAR"),
    writeFile(join(child, "child-notes.txt"), "CHILD_CONTENT_MUST_NOT_APPEAR"),
    writeFile(join(external, "external-notes.txt"), "UNAPPROVED_CONTENT_MUST_NOT_APPEAR"),
  ]);
  app = await startApp({
    dataDir: join(root, "web"), workspaces: [approved], port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("../test/engine-fixture.ts", import.meta.url))],
  });
  browser = await omowright.connectPipe({ browserPath, storageRoot: storage,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storage}`] });
  const page = await browser.newTab("about:blank");
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${recordRequests})()` }, await page.resolveSessionId());
  await omowright.emulate(page, "desktop-1440");
  const wait = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`Not visible: ${selector} (${text})`)); }, 9_000);
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
  const panel = "#workspace-browser-dialog";
  const field = "#workspace-browser-path";
  const entries = "#workspace-browser-entries";
  const browse = "#workspace-browser-button";
  const approve = "#workspace-browser-confirm";
  const deny = "#workspace-browser-deny";
  const use = "#workspace-browser-use";
  const exists = selector => page.evaluate(selector => Boolean(document.querySelector(selector)?.getClientRects().length), selector);
  const value = selector => page.evaluate(selector => document.querySelector(selector).value, selector);
  const click = async (selector, text = "") => {
    await wait(selector, text);
    const locator = text ? page.locator(selector).filter({ hasText: text }) : page.locator(selector);
    await locator.click();
  };
  const capture = async name => { if (evidence) await Bun.write(join(evidence, `${name}.png`), await page.screenshot()); };
  const theme = value => page.evaluate(value => {
    const select = document.querySelector("#theme");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const roots = async () => (await (await fetch(new URL("/api/bootstrap", app.url))).json()).workspaces;
  const assertNoContents = () => page.evaluate(() => !document.body.textContent.includes("CONTENT_MUST_NOT_APPEAR"));

  await page.goto(app.url.origin);
  await click("#new-sidebar:not(:disabled)");
  await page.locator("#new-name").fill("原工作区草稿");
  await click("#create:not(:disabled)");
  await wait("#session-title", "原工作区草稿");
  await wait("#prompt:enabled");
  await page.locator("#prompt").fill("这条草稿留在原工作区。");
  await page.evaluate(() => { window.directoryRequests.length = 0; });
  await click(browse);
  await wait(entries, "project-notes.txt");
  await capture("desktop-files");
  assert(await assertNoContents(), "The browser displays filenames, not file contents");
  const clickChild = () => click(`${entries} button`, "child");
  await clickChild();
  await wait(entries, "child-notes.txt");
  await click(use);
  await wait(`${approve}:enabled`);
  assert.deepEqual(await roots(), [approved], "A browsable child is not automatically a work directory");
  await click(deny);
  await wait(`${use}:enabled`);
  assert.deepEqual(await roots(), [approved]);
  assert(!await exists(approve));

  await page.locator(field).fill(external);
  await click(use);
  await wait(`${approve}:enabled`);
  await wait(panel, external);
  assert.equal(await page.evaluate(() => document.activeElement.id), "workspace-browser-approval-title");
  assert(!await page.evaluate(() => document.querySelector("#workspace-browser-entries").textContent.includes("external-notes.txt")));
  assert.deepEqual(await roots(), [approved], "Preparing an external path does not authorize it");
  await capture("desktop-confirm");
  await theme("dark");
  await capture("desktop-confirm-dark");
  await page.locator("#workspace-browser-approval-title").press("Tab");
  assert(await page.evaluate(() => {
    const deny = document.querySelector("#workspace-browser-deny");
    return document.activeElement === deny && getComputedStyle(deny).outlineStyle === "solid";
  }), "The first Tab focuses Deny visibly on desktop too");
  await capture("desktop-confirm-keyboard");
  await theme("light");
  await omowright.emulate(page, { width: 320, height: 640, deviceScaleFactor: 1, mobile: true, hasTouch: true });
  await page.locator("#workspace-browser-approval-title").press("Tab");
  assert(await page.evaluate(() => {
    const deny = document.querySelector("#workspace-browser-deny");
    const confirm = document.querySelector("#workspace-browser-confirm");
    return document.activeElement === deny && getComputedStyle(deny).outlineStyle === "solid" &&
      confirm.getBoundingClientRect().height >= 44 && document.documentElement.scrollWidth === innerWidth;
  }), "The first Tab from the approval heading focuses Deny visibly at 320px");
  await capture("mobile-confirm");
  await theme("dark");
  await capture("mobile-confirm-dark");
  await theme("light");
  await omowright.emulate(page, "desktop-1440");
  await click(deny);
  await wait(`${use}:enabled`);
  assert.deepEqual(await roots(), [approved]);

  await page.locator(field).fill(external);
  await click(use);
  await wait(`${approve}:enabled`);
  await click(approve);
  await wait("#workspace-select");
  assert.equal(await value("#workspace-select"), external);
  assert.deepEqual(await roots(), [approved, external]);
  assert(!await exists(`${panel}[open]`));
  const previousWrites = await page.evaluate(() => window.directoryRequests);
  assert.equal(previousWrites.filter(row => row.path === "/api/workspaces/confirm" && row.body.allow === false).length, 2);
  assert.equal(previousWrites.filter(row => row.path === "/api/workspaces/confirm" && row.body.allow === true).length, 1);
  assert.deepEqual(previousWrites.filter(row => row.path.startsWith("/api/sessions")), [], "Browsing switches view but opens no session");

  await click("#new-sidebar:not(:disabled)");
  assert.equal(await value("#new-cwd"), external);
  await page.locator("#new-name").fill("已确认工作区的会话");
  await click("#create:not(:disabled)");
  await wait("#session-title", "已确认工作区的会话");
  const { sessions } = await (await fetch(new URL("/api/sessions", app.url))).json();
  assert.equal(sessions.find(row => row.name === "已确认工作区的会话")?.cwd, external);
  assert.equal(sessions.find(row => row.name === "原工作区草稿")?.cwd, approved, "Approval never migrates old sessions");

  await omowright.emulate(page, { width: 320, height: 640, deviceScaleFactor: 1, mobile: true, hasTouch: true });
  await click("#open-navigation");
  await click(browse);
  await wait(entries, "external-notes.txt");
  const mobile = await page.evaluate(selector => {
    const panel = document.querySelector(selector);
    const rect = panel.getBoundingClientRect();
    return { modal: panel.matches(":modal"), fits: rect.left >= 0 && rect.right <= innerWidth &&
      document.documentElement.scrollWidth === innerWidth, touch: document.querySelector("#workspace-browser-use").getBoundingClientRect().height };
  }, panel);
  assert(mobile.modal && mobile.fits && mobile.touch >= 44);
  await capture("mobile-files");
  await theme("dark");
  await capture("mobile-files-dark");
  await page.locator(field).press("Escape");
  assert(!await exists(`${panel}[open]`));
  await omowright.emulate(page, "desktop-1440");
  await page.locator("#workspace-select").selectOption(approved);
  await wait("#session-list button", "原工作区草稿");
  await click("#session-list button", "原工作区草稿");
  await wait("#prompt:enabled");
  assert.equal(await value("#prompt"), "这条草稿留在原工作区。");
  console.log("WORKSPACE_FILE_BROWSER_OK approved files/child, exact grant, deny/allow, no auto-create, draft retained, 320px");
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
