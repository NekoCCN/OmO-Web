import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLI_HISTORY_LIMITS, sessionDirName } from "../src/cli-history.ts";
import { startApp } from "../src/server.ts";
import { TRANSCRIPT_PAGE_BYTES } from "../src/transcript-pages.ts";

const loader = process.env.OMO_HANDOFF_OMOWRIGHT;
const chromium = process.env.OMO_HANDOFF_CHROMIUM;
assert(loader && chromium, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const evidence = process.env.OMO_DIRECTORY_EVIDENCE;
const detectPath = process.env.OMO_DIRECTORY_DETECT;
const detect = detectPath ? await import(pathToFileURL(resolve(detectPath)).href) : undefined;
const baseline = process.argv.includes("--baseline");
const root = await realpath(await mkdtemp(join(tmpdir(), "omo-directory-picker-")));
const alpha = join(root, "alpha", "project");
const beta = join(root, "beta", "project");
const child = join(beta, "child");
const profile = join(root, "profile");
const history = "/api/cli-history";
let app, browser;

async function seed(cwd, name, size = 0) {
  const id = crypto.randomUUID();
  const bucket = join(profile, "sessions", sessionDirName(cwd));
  const timestamp = "2026-11-26T00:00:00.000Z";
  const path = join(bucket, `${id}.jsonl`);
  await mkdir(bucket, { recursive: true });
  await writeFile(path, [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "session_info", id: "title", parentId: null, timestamp, name },
    { type: "message", id: "user", parentId: "title", timestamp,
      message: { role: "user", content: size ? "x".repeat(size) : `${name} original conversation`, timestamp: 1 } },
  ].map(row => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  return { id, path };
}

function watchRequests() {
  const send = window.fetch.bind(window);
  const probe = window.directoryProof = { reads: [], writes: [], responses: [], hold: "", release: null, held: false };
  window.fetch = async (path, init) => {
    const url = new URL(path, location.href);
    const route = url.pathname + url.search;
    if (init?.method === "POST") probe.writes.push(route);
    else if (url.pathname.startsWith("/api/cli-history")) probe.reads.push(route);
    const held = probe.hold === route;
    if (held) probe.hold = "";
    const result = await send(path, held ? { ...init, signal: undefined } : init);
    if (url.pathname.startsWith("/api/cli-history")) {
      probe.responses.push({ route, status: result.status, bytes: (await result.clone().arrayBuffer()).byteLength });
    }
    if (held) await new Promise(resolve => {
      probe.held = true;
      probe.release = resolve;
      window.dispatchEvent(new Event("request-held"));
    });
    return result;
  };
}

try {
  await Promise.all([mkdir(child, { recursive: true }), mkdir(alpha, { recursive: true }),
    evidence && mkdir(evidence, { recursive: true })]);
  const [, , bigAlpha, bigBeta, , mobileSeed] = await Promise.all([
    seed(alpha, "Web alpha"), seed(beta, "Web beta"), seed(alpha, "Large journal", CLI_HISTORY_LIMITS.maxFileBytes + 1),
    seed(beta, "Large preview", TRANSCRIPT_PAGE_BYTES + 1), seed(child, "Unapproved child"), seed(beta, "Phone journal"),
  ]);
  app = await startApp({ dataDir: join(root, "web"), workspaces: [alpha, beta], cliAgentDir: profile, port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("../test/session-handoff-engine-fixture.ts", import.meta.url))] });
  const get = async path => (await fetch(new URL(path, app.url))).json();
  const { token } = await get("/api/bootstrap");
  const catalog = cwd => `${history}?${new URLSearchParams({ cwd })}`;
  for (const [cwd, title] of [[alpha, "Web alpha"], [beta, "Web beta"]]) {
    const { sessions } = await get(catalog(cwd));
    const entry = sessions.find(row => row.name === title);
    assert(entry);
    const response = await fetch(new URL(`${history}/${entry.id}/resume`, app.url), { method: "POST",
      headers: { Origin: app.url.origin, "X-OmO-Token": token, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200, await response.text());
  }
  const storage = join(root, "browser");
  await mkdir(storage);
  browser = await omowright.connectPipe({ browserPath: chromium, storageRoot: storage,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storage}`] });
  const page = await browser.newTab("about:blank");
  const sid = await page.resolveSessionId();
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${watchRequests})()` }, sid);
  const wait = (selector, text = "") => page.evaluate(({ selector, text }) => new Promise((done, fail) => {
    const stop = () => { observer.disconnect(); document.removeEventListener("focusin", check); clearTimeout(timer); };
    const timer = setTimeout(() => { stop(); fail(new Error(`Not rendered at ${innerWidth}×${innerHeight}: ${selector} ${text}`)); }, 10000);
    function check() {
      if (![...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(text))) return;
      stop(); done(true);
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    document.addEventListener("focusin", check);
    check();
  }), { selector, text });
  const click = async (selector, text = "") => {
    await wait(selector, text);
    const control = page.locator(selector);
    await (text ? control.filter({ hasText: text }) : control).click();
  };
  const capture = async (name, width) => {
    for (const theme of ["light", "dark"]) {
      await page.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sid);
      const measured = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
        const frame = document.querySelector("dialog:modal") ?? document.querySelector(".session-rail");
        const targets = [...frame.querySelectorAll("button:enabled, select:enabled, input:enabled")].filter(node => node.getClientRects().length);
        const luminance = value => value.match(/[\d.]+/g)?.slice(0, 3).reduce((sum, channel, index) => {
          const n = Number(channel) / 255;
          return sum + (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
        }, 0);
        const contrast = targets.map(node => {
          let surface = node;
          let bg = getComputedStyle(surface).backgroundColor;
          while (surface.parentElement && bg === "rgba(0, 0, 0, 0)") {
            surface = surface.parentElement;
            bg = getComputedStyle(surface).backgroundColor;
          }
          const values = [luminance(getComputedStyle(node).color), luminance(bg)].sort((a, b) => b - a);
          return (values[0] + .05) / (values[1] + .05);
        });
        const scrollOwners = [...document.querySelectorAll("*")].filter(node =>
          /auto|scroll/.test(getComputedStyle(node).overflowY) && node.clientHeight && node.scrollHeight > node.clientHeight)
          .map(node => node.id ? `#${node.id}` : `.${node.classList[0]}`);
        return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, scrollOwners,
          frameOverflow: frame.scrollWidth - frame.clientWidth,
          minTarget: Math.min(...targets.map(node => Math.min(node.getBoundingClientRect().height, node.getBoundingClientRect().width))),
          minContrast: Math.min(...contrast) };
      });
      assert.equal(measured.width, width);
      assert.equal(measured.overflow, 0);
      assert.equal(measured.frameOverflow, 0);
      assert(measured.minTarget >= (width <= 760 ? 44 : 24), `${name} target size: ${JSON.stringify(measured)}`);
      assert(measured.minContrast >= 4.5, `${name} contrast: ${JSON.stringify(measured)}`);
      console.log("DIRECTORY_CAPTURE", name, width, theme, JSON.stringify(measured));
      if (evidence) await Bun.write(join(evidence, `${name}-${width}-${theme}-${baseline ? "before" : "after"}.png`), await page.screenshot());
      if (detect) {
        const { result, exceptionDetails } = await page.cdp.send("Runtime.evaluate", {
          expression: `(${detect.collectPageSnapshot})(${JSON.stringify(detect.STYLE_PROPS)}, 2000)`, returnByValue: true,
        }, sid);
        assert(!exceptionDetails, "Could not collect Chromium DOM for frontend-detect");
        const findings = detect.lintSnapshot(result.value);
        if (evidence) await Bun.write(join(evidence, `${name}-${width}-${theme}-detect.json`), JSON.stringify(findings, null, 2));
      }
    }
  };
  const value = selector => page.evaluate(selector => document.querySelector(selector).value, selector);
  const requests = () => page.evaluate(() => ({ reads: window.directoryProof.reads, writes: window.directoryProof.writes }));
  const focused = () => page.evaluate(() => document.activeElement.id);
  const hold = route => page.evaluate(route => { window.directoryProof.hold = route; window.directoryProof.held = false; }, route);
  const held = () => page.evaluate(() => new Promise((resolve, reject) => {
    if (window.directoryProof.held) { resolve(true); return; }
    const timeout = setTimeout(() => reject(new Error("Expected request was not held")), 10_000);
    window.addEventListener("request-held", () => { clearTimeout(timeout); resolve(true); }, { once: true });
  }));
  const release = () => page.evaluate(async () => {
    window.directoryProof.release();
    await new Promise(requestAnimationFrame);
  });
  const assertNoWrites = async () => assert.deepEqual((await requests()).writes.filter(path => !path.startsWith("/api/workspaces/")), []);
  const choose = cwd => page.locator("#cli-history-directory").selectOption(cwd);
  const launcher = "#cli-history-button";
  const closePicker = () => click("#cli-history-dialog [data-close]");
  const assertGroups = async (names = [["Web beta"], ["Web alpha"]]) => {
    const groups = await page.evaluate(() => [...document.querySelectorAll("#session-list [data-cwd]")].map(group => [
      group.dataset.cwd, [...group.querySelectorAll("button > span:first-child")].map(name => name.textContent),
    ]));
    assert.deepEqual(groups.sort(), [[alpha, names[1]], [beta, names[0]]].sort());
  };
  const assertOriginal = async (name, cwd, original) => {
    const { sessions } = await get("/api/sessions");
    const matching = sessions.filter(session => session.name === name && session.cwd === cwd && session.active);
    assert.equal(matching.length, 1);
    const [session] = matching;
    const saved = await Bun.file(join(root, "web", "sessions", `${session.id}.json`)).json();
    assert.equal(saved.nativeId, original.id, "Bookmark binds to original durable ID");
    assert.equal(saved.cwd, cwd);
    assert.equal(saved.cliBookmark, true);
  };
  const matrix = process.argv.includes("--short-only") ? [] : [["desktop-1440", 1440], ["iphone-14", 390]];
  for (const [device, width] of matrix) {
    await page.goto(app.url.origin);
    await omowright.emulate(page, device);
    await wait('body:has(#connection[data-state="online"])');
    if (width === 390) await click("#open-navigation");
    await wait("#session-list button", "Web alpha");
    await wait("#session-list button", "Web beta");
    if (baseline) await wait("#cli-session-list button", "Large journal");
    await capture("sidebar", width);
    if (!baseline) {
      await assertGroups(width === 1440 ? undefined : [["Large preview", "Web beta"], ["Large journal", "Web alpha"]]);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      assert.deepEqual(await requests(), { reads: [], writes: [] }, "Boot, SSE ready, sidebar and visibility must not discover CLI history");
    }
    await click(launcher);
    if (baseline) {
      await wait("#cli-history-list button", "Large journal");
      await capture("picker", width);
      continue;
    }
    assert.equal(await focused(), "cli-history-directory");
    assert.deepEqual((await requests()).reads, []);
    await capture("picker", width);
    if (width === 390) {
      await page.locator("#cli-history-directory").press("Escape");
      await wait("#open-navigation[aria-expanded=false]:focus");
      assert.equal(await focused(), "open-navigation");
      await click("#open-navigation");
      await click(launcher);
      await choose(beta);
      await wait("#cli-history-list button", "Phone journal");
      assert.deepEqual((await requests()).reads, [catalog(beta)]);
      const dedup = await page.evaluate(() => ({
        native: [...document.querySelectorAll("#cli-history-list button")].map(row => row.querySelector("span").textContent),
        web: [...document.querySelectorAll("#cli-history-web-list button")].map(row => row.textContent),
      }));
      assert.deepEqual(dedup.native, ["Phone journal"]);
      assert.deepEqual(dedup.web.sort(), ["Large preview", "Web beta"]);
      await capture("catalog", width);
      await click("#cli-history-list button", "Phone journal");
      await wait("#cli-history-messages article", "Phone journal original conversation");
      await capture("record", width);
      await click("#cli-history-back");
      await wait("#cli-history-list button:focus", "Phone journal");
      await click("#cli-history-list button", "Phone journal");
      await click("#cli-history-resume:enabled");
      await wait("#session-title", "Phone journal");
      await wait("#messages article", "Phone journal original conversation");
      await wait("#prompt:focus");
      assert.equal((await requests()).writes.filter(route => route.endsWith("/resume")).length, 1);
      await assertOriginal("Phone journal", beta, mobileSeed);
      continue;
    }
    await hold(catalog(alpha));
    await choose(alpha);
    await wait("#cli-history-list-status:not([hidden])");
    await held();
    await capture("held", width);
    await choose(beta);
    await wait("#cli-history-list button", "Large preview");
    await release();
    assert.deepEqual((await requests()).reads, [catalog(alpha), catalog(beta)]);
    const summaries = await page.evaluate(() => window.directoryProof.responses);
    assert(summaries.every(response => response.status === 200 && response.bytes < 4096), JSON.stringify(summaries));
    await assertNoWrites();
    assert(!await page.evaluate(() => document.querySelector("#cli-history-list").textContent.includes("Large journal")));
    await capture("catalog", width);

    for (const [cwd, title, expectedStatus, original] of [[beta, "Large preview", 413, bigBeta], [alpha, "Large journal", 400, bigAlpha]]) {
      if (cwd === alpha) {
        await click(launcher);
        await choose(cwd);
        await wait("#cli-history-list button", title);
      }
      await click("#cli-history-list button", title);
      assert.equal(await focused(), "cli-history-record-title");
      await wait("#cli-history-record-error:not([hidden])");
      const { route: preview, status } = await page.evaluate(() => window.directoryProof.responses.at(-1));
      assert.equal(status, expectedStatus);
      await capture(expectedStatus === 413 ? "preview-limit" : "journal-limit", width);
      if (expectedStatus === 413) {
        await hold(`${preview}/resume`);
        await click("#cli-history-resume:enabled");
        await held();
        await wait("#cli-history-resume:disabled");
        await click("#cli-history-back");
        await click("#cli-history-list button", title);
        await wait("#cli-history-resume:disabled");
        await closePicker();
        await release();
        await wait("#session-list button", title);
        assert.equal(await page.evaluate(() => document.querySelector("#session-path").hidden), true, "Late resume records a bookmark without navigation");
        await click("#session-list button", title);
      } else await click("#cli-history-resume:enabled");
      await wait("#session-title", title);
      await wait("#prompt:enabled");
      assert.equal(await page.evaluate(() => document.querySelector("#session-path").textContent), cwd);
      await assertOriginal(title, cwd, original);
    }
    const writes = (await requests()).writes;
    assert.equal(writes.filter(route => route.endsWith("/resume")).length, 2);
    await assertGroups([["Large preview", "Web beta"], ["Large journal", "Web alpha"]]);
    await page.locator("#prompt").fill("Alpha draft before selecting another directory");
    await click(launcher);
    await choose(alpha);
    await wait("#cli-history-web-list button", "Large journal");
    await page.locator("#cli-history-search").fill("Large journal");
    await click("#cli-history-browse");
    await wait("#workspace-browser-current", alpha);
    await page.locator("#workspace-browser-path").press("Escape");
    await wait("#cli-history-browse:focus");
    assert.equal(await value("#cli-history-search"), "Large journal");
    assert.equal(await focused(), "cli-history-browse");
    await closePicker();
    await click("#workspace-browser-button");
    await wait("#workspace-browser-current", alpha);
    await page.locator("#workspace-browser-path").fill(child);
    await click("#workspace-browser-use");
    await click("#workspace-browser-deny");
    await wait("#workspace-browser-feedback:not([hidden])");
    assert.equal((await requests()).reads.filter(path => path === catalog(child)).length, 0);
    await click("#workspace-browser-use");
    await click("#workspace-browser-confirm");
    await wait("#cli-history-list button", "Unapproved child");
    assert.equal(await value("#cli-history-directory"), child);
    await closePicker();
    await wait("#workspace-browser-button:focus");
    assert.equal(await value("#prompt"), "Alpha draft before selecting another directory");
    assert.equal((await requests()).writes.filter(route => route.endsWith("/resume")).length, 2);
    await click("#new-sidebar");
    assert.equal(await value("#new-cwd"), child);
    await click("#new-dialog [data-close]");
    for (const command of ["/resume", "/sessions"]) {
      const composer = page.locator("#prompt");
      const before = (await requests()).reads;
      await composer.fill(command);
      await composer.press("Control+Enter");
      await wait("#cli-history-dialog[open]");
      assert.equal(await value("#cli-history-directory"), "");
      assert.deepEqual((await requests()).reads, before);
      await closePicker();
      await wait("#prompt:focus");
    }
    await rename(child, `${child}-moved`);
    await click(launcher);
    await choose(child);
    await wait("#cli-history-list-error:not([hidden])");
    assert.equal(await page.evaluate(() => window.directoryProof.responses.at(-1).status), 403);
    assert(await page.evaluate(() => document.querySelector("#cli-history-list").hidden));
    await capture("refused", width);
    await choose(beta);
    await wait("#cli-history-list button", "Phone journal");
    assert(await page.evaluate(() => document.querySelector("#cli-history-list-error").hidden));
    await closePicker();
    await rename(`${child}-moved`, child);
  }
  if (baseline) {
    assert.deepEqual((await requests()).reads, [], "Baseline regression: startup and the launcher perform global CLI discovery");
  }
  await page.goto(app.url.origin);
  await omowright.emulate(page, { width: 320, height: 480, deviceScaleFactor: 1, mobile: true, hasTouch: true });
  await wait('body:has(#connection[data-state="online"])');
  await click("#open-navigation");
  const short = await page.evaluate(() => {
    const target = [...document.querySelectorAll("#session-list button")].find(row => row.textContent.includes("Web beta"));
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y, width, height } = target.getBoundingClientRect();
    const actual = document.elementFromPoint(x + width / 2, y + height / 2);
    const rail = document.querySelector(".session-rail").getBoundingClientRect();
    const footer = document.querySelector(".sidebar-footer").getBoundingClientRect();
    const lastRowBottom = Math.max(...[...document.querySelectorAll("#session-list button")].map(row => row.getBoundingClientRect().bottom));
    return { reachable: target.contains(actual), actual: actual?.id, railHeight: rail.height, footerDisjoint: footer.top >= lastRowBottom };
  });
  assert(short.reachable, `Short phone bookmark must have a real hit point: ${JSON.stringify(short)}`);
  assert(short.footerDisjoint, `Drawer footer must not overlap the grouped list: ${JSON.stringify(short)}`);
  await capture("short-sidebar", 320);
  await click("#session-list button", "Web beta");
  await wait("#session-title", "Web beta");
  console.log("DIRECTORY_PICKER_BROWSER_OK scoped lazy reads, two groups, both preview limits, exact original resumes, grant and focus");
} finally {
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
