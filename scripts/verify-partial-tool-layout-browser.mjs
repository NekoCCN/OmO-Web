import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";
import { measureToolLayout, scrollOutputByKey, toolLayoutDefects } from "./partial-tool-layout-evidence.mjs";

const { OMO_HANDOFF_OMOWRIGHT: loader, OMO_HANDOFF_CHROMIUM: browserPath, OMO_PARTIAL_LAYOUT_EVIDENCE: evidence } = process.env;
assert(loader && browserPath, "Set OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
const { loadOmowright } = await import(pathToFileURL(resolve(loader)).href);
const { omowright } = await loadOmowright();
const directory = await mkdtemp(join(tmpdir(), "omo-tool-layout-browser-"));
const terminal = '.tool-details[data-tool-kind="terminal"][data-state="success"]';
const partial = '.tool-details[data-tool-kind="inspect"][data-state="unknown"]';
const malformed = '.tool-details[data-tool-kind="unknown"][data-state="incomplete"]';
const absent = '.tool-details[data-tool-kind="terminal"][data-state="unknown"]';
const cases = {
  normal: [],
  base: ["/styles.css"],
  ledger: ["/tool-ledger.css"],
  both: ["/styles.css", "/tool-ledger.css"],
};
const observations = {};
const defects = [];
let app, browser;

function check(condition, message) {
  if (!condition) defects.push(message);
}

function waitFor(page, selector, text = "") {
  return page.evaluate(({ selector, text }) => new Promise((done, fail) => {
    const observer = new MutationObserver(check);
    const deadline = setTimeout(() => {
      observer.disconnect();
      fail(new Error(`Not rendered: ${selector} (${text})`));
    }, 8_000);
    function check() {
      if (![...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(text))) return;
      clearTimeout(deadline);
      observer.disconnect();
      done(true);
    }
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, text });
}

async function capture(page, name, selector = `${terminal} > summary`) {
  if (!evidence) return;
  await page.evaluate(selector => {
    document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "instant" });
    return new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, selector);
  await Bun.write(join(evidence, `${name}.png`), await page.screenshot());
}

async function verifyPolicy(page) {
  const response = await fetch(app.url);
  const csp = response.headers.get("Content-Security-Policy");
  assert(csp, "App response must carry a CSP");
  const source = (await response.text()).match(/<style>([^]*?)<\/style>/gu)?.map(block => block.slice(7, -8)) ?? [];
  const hashes = source.map(css => `'sha256-${createHash("sha256").update(css).digest("base64")}'`);
  assert.deepEqual(csp.match(/(?:^|; )style-src ([^;]+)/u)?.[1].split(/\s+/u), ["'self'", ...hashes]);
  assert(!/unsafe-inline|style-src-attr/u.test(csp), csp);
  assert(await page.evaluate(() => {
    const style = document.createElement("style");
    const probe = document.createElement("span");
    probe.id = "probe-inline-style";
    style.textContent = "#probe-inline-style { display: none; }";
    probe.setAttribute("style", "visibility: hidden");
    document.head.append(style);
    document.body.append(probe);
    const blocked = !style.sheet && getComputedStyle(probe).display !== "none" &&
      getComputedStyle(probe).visibility === "visible";
    probe.remove();
    style.remove();
    return blocked;
  }), "CSP must still block arbitrary inline stylesheet and style attribute");
}

try {
  if (evidence) await mkdir(evidence, { recursive: true });
  app = await startApp({ dataDir: join(directory, "web"), workspaces: [directory], port: 0,
    engineCommand: [process.execPath, fileURLToPath(new URL("../test/tool-lifecycle-engine-fixture.ts", import.meta.url))] });
  const { origin } = app.url;
  const { token } = await (await fetch(`${origin}/api/bootstrap`)).json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": token };
  const create = await fetch(`${origin}/api/sessions`, { method: "POST", headers,
    body: JSON.stringify({ cwd: directory, name: "Partial layout" }) });
  assert.equal(create.status, 201);
  const { session } = await create.json();
  const action = async body => {
    const response = await fetch(`${origin}/api/sessions/${session.id}/actions`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  const storage = join(directory, "browser");
  await mkdir(storage);
  browser = await omowright.connectPipe({ browserPath, storageRoot: storage,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storage}`] });
  const page = await browser.newTab("about:blank");
  const sid = await page.resolveSessionId();
  const routes = omowright.createRoutes(page);
  const blocked = new Set();
  let hold;
  const failed = new Set();
  await routes.route(/\/(?:styles|tool-ledger)\.css(?:\?.*)?$/u, async route => {
    const path = new URL(route.request.url).pathname;
    if (hold && path === "/styles.css") {
      hold.requested.resolve();
      await hold.release.promise;
    }
    if (blocked.has(path)) {
      failed.add(path);
      await route.fulfill({ status: 503, contentType: "text/css", body: "" });
    } else await route.continue();
  });
  const summary = selector => page.locator(`${selector} > summary`);
  let device = "iphone-14";
  const read = () => measureToolLayout(page, terminal);
  const bounded = (key, reading, open) => defects.push(...toolLayoutDefects(key, reading, open));
  const load = async () => {
    await page.goto(app.url.href);
    if (await page.locator(terminal).count() === 0) {
      await omowright.emulate(page, "desktop-1440");
      await page.locator(".session-link").press("Enter");
    }
    await omowright.emulate(page, device);
    await waitFor(page, `${terminal} > summary`, "Bash");
  };

  for (const [width, preset] of [[390, "iphone-14"], [1440, "desktop-1440"]]) {
    device = preset;
    for (const theme of ["light", "dark"]) {
      await page.cdp.send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" },
      ] }, sid);
      const { identifier } = await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `localStorage.setItem("omo-web-language","en"); localStorage.setItem("omo-web-theme",${JSON.stringify(theme)});`,
      }, sid);
      for (const [name, paths] of Object.entries(cases)) {
        const key = `${width}-${theme}-${name}`;
        blocked.clear();
        failed.clear();
        for (const path of paths) blocked.add(path);
        await load();
        assert.deepEqual([...failed].sort(), [...paths].sort(), `${key}: stylesheet injection didn't happen`);
        await waitFor(page, `${partial} > summary`, "Unknown status");
        await waitFor(page, `${malformed} > summary`, "Incomplete result");
        await waitFor(page, `${absent} > summary`, "No result");
        const closed = await read();
        assert.equal(closed.window[1], width, `${key}: wrong emulated screen`);
        bounded(`${key}-closed`, closed, false);
        await capture(page, `${key}-closed`);
        await summary(terminal).press("Enter");
        await waitFor(page, `${terminal}[open] .tool-output`, "output-end");
        const open = await read();
        bounded(`${key}-open`, open, true);
        await capture(page, `${key}-open`);
        if (open.output[3] > open.output[2]) check(await scrollOutputByKey(page, `${terminal} .tool-output`),
          `${key}: cannot scroll output with the keyboard`);
        await summary(terminal).press("Enter");
        await waitFor(page, `${terminal}:not([open]) > summary`);
        observations[key] = { closed, open };
      }
      await page.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sid);
    }
  }

  // Hold a replacement stylesheet on the already rendered fallback, then let it settle
  // without remounting the tool, losing its disclosure, or replacing its result.
  device = "iphone-14";
  await omowright.emulate(page, device);
  await summary(terminal).press("Enter");
  await waitFor(page, `${terminal}[open] .tool-output`, "output-end");
  blocked.clear();
  hold = { requested: Promise.withResolvers(), release: Promise.withResolvers() };
  await page.evaluate(() => {
    const link = document.querySelector('link[href="/styles.css"]');
    const next = link.cloneNode();
    next.href = "/styles.css?held=1";
    link.replaceWith(next);
  });
  let holdTimeout;
  try {
    await Promise.race([hold.requested.promise, new Promise((_, reject) => {
      holdTimeout = setTimeout(() => reject(new Error("Stylesheet request was not held")), 5000);
    })]);
    observations.held = await read();
    bounded("held-open", observations.held, true);
    await capture(page, "held-open");
  } finally {
    clearTimeout(holdTimeout);
    hold.release.resolve();
  }
  await waitFor(page, `${terminal}[open] .tool-output`, "output-end");
  await page.evaluate(() => new Promise((done, fail) => {
    const link = document.querySelector('link[href="/styles.css?held=1"]');
    if (link.sheet) done(true);
    else { link.addEventListener("load", () => done(true), { once: true }); link.addEventListener("error", fail, { once: true }); }
  }));
  hold = undefined;
  observations.released = await read();
  bounded("released-open", observations.released, true);
  await capture(page, "released-open");

  blocked.add("/styles.css");
  blocked.add("/tool-ledger.css");
  await load();
  // No new user action is sent by opening partial evidence, raw arguments or missing output.
  for (const [name, selector, target, text] of [
    ["partial", partial, ".tool-output", "partial-evidence"],
    ["malformed", malformed, "pre", "raw-input"],
    ["missing", absent, ".tool-result", "No tool result is available."],
  ]) {
    await summary(selector).press("Enter");
    await waitFor(page, `${selector}[open] ${target}`, text);
    await capture(page, `${name}-open`, `${selector} > summary`);
    await summary(selector).press("Enter");
  }

  await verifyPolicy(page);
  await waitFor(page, '#connection[data-state="online"]');
  await action({ action: "prompt", message: "tool-lifecycle-approval please" });
  const live = '.tool-details[data-tool-kind="modify"]';
  await waitFor(page, `${live}[data-state="running"] > summary`, "Running");
  await summary(live).press("Enter");
  await waitFor(page, `${live}[open] .tool-result`, "Waiting for tool output");
  await capture(page, "running-open", `${live} > summary`);
  await action({ action: "answer", requestId: "approval-1", value: "Allow once" });
  await waitFor(page, `${live}[open][data-state="success"] .tool-output`, "Synthetic write output.");
  assert(await page.evaluate(live => document.activeElement?.matches(`${live} > summary`) &&
    !document.querySelector(`${live} .tool-result`).innerText.includes("Waiting for tool output"), live),
  "Settlement preserved open state and keyboard focus, and removed the waiting copy");
  await capture(page, "settled-open", `${live} > summary`);

  blocked.clear();
  await load();
  await waitFor(page, `${terminal}:not([open]) > summary`, "Succeeded");
  await summary(terminal).press("Enter");
  await waitFor(page, `${terminal}[open] .tool-output`, "terminal-evidence");
  observations.reload = await read();
  bounded("reload-open", observations.reload, true);
  await capture(page, "reload-open");
  assert.deepEqual(defects, [], defects.join("\n"));
  console.log("PASS: tool layout, native keyboard disclosure, lifecycle, reload, and CSP in Chromium");
} finally {
  if (evidence) await Bun.write(join(evidence, "geometry.json"), JSON.stringify({ observations, defects }, null, 2));
  await browser?.close();
  await app?.stop();
  await rm(directory, { recursive: true, force: true });
}
