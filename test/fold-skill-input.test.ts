import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";
import { TRANSCRIPT_CONTENT_BYTES, TRANSCRIPT_PAGE_BYTES } from "../src/transcript-pages.ts";

const chromium = process.env.BUN_CHROME_PATH ?? process.env.OMO_HANDOFF_CHROMIUM;
const formatter = process.env.OMO_TEST_NATIVE_SKILL_FORMATTER;
const shots = process.env.OMO_TEST_SKILL_EVIDENCE;
const stage = process.env.OMO_TEST_SKILL_STAGE ?? "run";
const engine = fileURLToPath(new URL("./fold-skill-input-engine-fixture.ts", import.meta.url));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGm8AAAAASUVORK5CYII=";
const instruction = 'Instruction seed · 步骤\n<img src="/skill-test-probe"><a href="/skill-test-probe">HTML</a>\n[Link](/skill-test-probe)';
const request = "Inline caller · 用户原文 🦉\n  keep indentation  ";
const pagedRequest = "Paged caller · 保留尾部 🧪\n  second line  ";
const nearRequest = "Near-threshold caller, before the fold";
const legacy = '<skill name="legacy" location="/fixture/legacy/SKILL.md">\nLegacy instruction\n</skill>\n\nLegacy caller';
const plain = "Plain caller quotes <skill> literally.";
const longRequest = "r".repeat(198_000);
const text = (value: string) => ({ type: "text", text: value });
const image = { type: "image", mimeType: "image/png", data: png };
const user = (timestamp: number, content: unknown) => ({ role: "user", timestamp, content });
const inline = (value: string) => [text(value), image];

type Format = (skills: readonly { name: string; filePath: string; baseDir: string; body: string }[], request: string) => string;
const recordedFormat: Format = (skills, request) => {
  const records = skills.map(({ name, filePath, baseDir, body }) =>
    `The user explicitly invoked the "${name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill-instruction>`);
  return records.join("\n\n") + (/\S/u.test(request) ? `\n\n<user-request>\n${request}\n</user-request>` : "");
};

async function seeds() {
  const formatSkillInvocationPrompt: Format = formatter ? (await import(formatter)).formatSkillInvocationPrompt : recordedFormat;
  const skill = (name: string, body: string) => ({ name, body, baseDir: `/fixture/${name}`, filePath: `/fixture/${name}/SKILL.md` });
  const exact = formatSkillInvocationPrompt([skill("first", instruction), skill("second", "Second instruction")], request);
  const noRequest = formatSkillInvocationPrompt([skill("no-args", "")], "");
  const largeBody = `BIG INSTRUCTION START\n${"界".repeat(65_550)}\nBIG INSTRUCTION END`;
  const large = formatSkillInvocationPrompt([skill("large", largeBody)], pagedRequest);
  const near = formatSkillInvocationPrompt([skill("near", "界".repeat(65_350))], nearRequest);
  const malformed = [
    exact.replace('name="first"', 'name="mismatch"'),
    exact.replace('name="second"', 'name="mismatch"'),
    exact.slice(0, -1),
    `${exact}\ntrailing prose`,
    `prefixed ${noRequest}`,
  ];
  const fallback = formatSkillInvocationPrompt([skill("over-budget", "X".repeat(3_000))], longRequest);
  const rows = [
    user(1000, inline(exact)), user(1001, legacy), user(1002, noRequest), user(1003, plain),
    ...malformed.map((value, i) => user(1004 + i, value)),
    { role: "assistant", timestamp: 1010, content: noRequest }, user(1011, near), user(1012, inline(large)),
  ];
  const redraw = user(1000, inline(formatSkillInvocationPrompt([
    skill("first", `${instruction}\nRedrawn instruction`), skill("second", "Second instruction"),
  ], request)));
  return { rows, redraw, largeBody, malformed, noRequest, fallback, large, near };
}

async function appFor(seed: Awaited<ReturnType<typeof seeds>>, rows: readonly unknown[] = seed.rows) {
  const cwd = await mkdtemp(join(tmpdir(), "omo-skill-input-fixture-"));
  await Promise.all([Bun.write(join(cwd, "seed.json"), JSON.stringify(rows)), Bun.write(join(cwd, "redraw.json"), JSON.stringify(seed.redraw))]);
  const app = await startApp({ dataDir: join(cwd, "web"), workspaces: [cwd], engineCommand: [process.execPath, engine],
    port: 0, cliAgentDir: join(cwd, "agent") });
  const get = (path: string, options?: RequestInit) => fetch(new URL(path, app.url), options);
  const { token } = await (await get("/api/bootstrap")).json();
  const post = (path: string, body: object) => get(path, { method: "POST", body: JSON.stringify(body),
    headers: { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": token } });
  const { session } = await (await post("/api/sessions", { cwd, name: "Skill input fixture" })).json();
  const path = `/api/sessions/${session.id}`;
  return { get, post, path, id: session.id, url: app.url.href, async [Symbol.asyncDispose]() {
    try { await app.stop(); } finally { await rm(cwd, { recursive: true, force: true }); }
  } };
}

test("oversized skill snapshot preserves bounded request and image before the first cursor read", async () => {
  const seed = await seeds();
  expect(Buffer.byteLength(seed.near)).toBeLessThan(192 * 1024);
  expect(Buffer.byteLength(JSON.stringify(seed.rows.at(-1)))).toBeGreaterThan(192 * 1024);
  await using app = await appFor(seed, [user(1011, seed.near), user(1012, inline(seed.large)), user(1013, seed.fallback)]);
  const initial = await (await app.get(app.path)).text();
  const { messages, page } = JSON.parse(initial);
  expect(Buffer.byteLength(initial)).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES);
  expect(messages.map((message: { timestamp: number }) => message.timestamp)).toEqual([1011, 1012, 1013]);
  expect(page.olderCursor).toBeUndefined();
  expect(messages[1].content).toEqual(inline(pagedRequest));
  expect(initial).not.toContain("BIG INSTRUCTION START");
  expect(messages[2].content).not.toContain(longRequest);
  let largestChunk = 0;
  for (const [message, expected] of [[messages[1], seed.largeBody], [messages[2], seed.fallback]] as const) {
    let cursor = message.historyContent.cursor;
    let loaded = "";
    while (cursor) {
      const response = await app.get(`${app.path}/transcript/content?${new URLSearchParams({ cursor })}`);
      expect(response.status).toBe(200);
      const wire = await response.text();
      largestChunk = Math.max(largestChunk, Buffer.byteLength(wire));
      expect(largestChunk).toBeLessThanOrEqual(TRANSCRIPT_CONTENT_BYTES);
      const data = JSON.parse(wire);
      loaded += data.text;
      cursor = data.nextCursor;
    }
    if (message.timestamp === 1012) {
      expect(loaded).toContain(expected);
      expect(loaded).not.toContain(pagedRequest);
    } else expect(loaded).toBe(expected);
  }
  console.info(`Skill snapshot: ${Buffer.byteLength(initial)} B / ${TRANSCRIPT_PAGE_BYTES} B; largest explicit content GET: ${largestChunk} B / ${TRANSCRIPT_CONTENT_BYTES} B`);
});

const inlineRow = "#messages .message--user:nth-of-type(1)";
const pagedRow = "#messages .message--user:nth-of-type(12)";
const ticks = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

async function waitFor(view: Bun.WebView, predicate: string) {
  await view.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 4500;
    const check = () => ${predicate} ? resolve(true) :
      performance.now() < deadline ? requestAnimationFrame(check) : reject(new Error(${JSON.stringify(predicate)}));
    check();
  })`);
}

async function screenshot(view: Bun.WebView, file: string, selector: string) {
  if (!shots) return;
  await view.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "start"})`);
  await view.evaluate(ticks);
  await Bun.write(join(shots, `${file}-${stage}.png`), await view.screenshot());
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test.skipIf(!chromium)(`Chromium ${width} ${theme}: requests stay visible and skill instructions stay inert and on demand`, async () => {
    const seed = await seeds();
    await using app = await appFor(seed);
    await using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width, height: width === 390 ? 844 : 900 });
    await view.navigate("about:blank");
    if (width === 390) {
      await view.cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
      await view.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    await view.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem("omo-web-theme", ${JSON.stringify(theme)});
      window.skillReads = [];
      const performFetch = window.fetch;
      window.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.pathname.startsWith(${JSON.stringify(app.path)})) window.skillReads.push(url.pathname);
        return performFetch(input, options);
      };` });
    await view.navigate(app.url);
    if (width === 390) await view.click("#open-navigation");
    const session = `#session-list button[data-session="${app.id}"]`;
    await waitFor(view, `document.querySelector(${JSON.stringify(session)})?.getClientRects().length`);
    await view.click(session);
    await waitFor(view, `document.querySelector(${JSON.stringify(pagedRow)})?.textContent.includes("large")`);
    const key = `${width}-${theme}`;
    await screenshot(view, `inline-${key}`, inlineRow);
    await screenshot(view, `paged-${key}`, pagedRow);
    const fold = `${inlineRow} details`;
    const pagedFold = `${pagedRow} details`;
    const summary = `${fold} > summary`;
    const btn = `${pagedFold} .transcript-content button`;
    expect(await view.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(inlineRow)});
      return {
        request: row.querySelector(".message-body > p")?.textContent, fold: row.querySelector("details")?.open,
        image: row.querySelector(".message-body > img")?.getAttribute("src"),
        visibleInstructions: row.innerText.includes("Instruction seed"),
        names: row.querySelector("summary")?.textContent
      };
    })()`)).toEqual({
      request, fold: false, image: `data:image/png;base64,${png}`, visibleInstructions: false,
      names: expect.stringMatching(/first.*second/),
    });
    expect(await view.evaluate(`(() => {
      const rows = [...document.querySelectorAll("#messages article")];
      const folds = rows.map(row => row.querySelector("details"));
      return {
        folds: folds.flatMap((fold, index) => fold ? [index] : []),
        noRequestText: rows[2].querySelector(".message-body").innerText,
        legacy: rows[1].querySelector(".message-body > p").textContent,
        plainAndMalformed: rows.slice(3, 9).map(row => row.querySelector(".message-body").textContent),
        near: rows[10].querySelector(".message-body > p").textContent,
        paged: rows[11].querySelector(".message-body > p").textContent,
        pagedImage: rows[11].querySelector(".message-body > img")?.getAttribute("src"),
      };
    })()`)).toEqual({
      folds: [0, 1, 2, 10, 11], noRequestText: expect.stringContaining("no-args"), legacy: "Legacy caller",
      plainAndMalformed: [plain, ...seed.malformed], near: nearRequest, paged: pagedRequest, pagedImage: `data:image/png;base64,${png}`,
    });
    const historyReads = () => view.evaluate(`window.skillReads.filter(path => path === ${JSON.stringify(app.path)} || path.includes("/transcript"))`);
    expect(await historyReads()).toEqual([app.path]);
    await view.evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await view.press("Enter");
    await waitFor(view, `document.querySelector(${JSON.stringify(fold)}).open`);
    await screenshot(view, `inline-open-${key}`, inlineRow);
    expect(await view.evaluate(`(() => {
      const fold = document.querySelector(${JSON.stringify(fold)});
      const rect = fold.firstElementChild.getBoundingClientRect();
      const css = getComputedStyle(fold.firstElementChild);
      const ink = css.color;
      const fill = getComputedStyle(fold.parentElement).backgroundColor;
      const luminance = rgb => rgb.match(/\\d+/g).slice(0, 3).map(Number).map(value => {
        const n = value / 255;
        return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
      }).reduce((sum, component, i) => sum + component * [.2126, .7152, .0722][i], 0);
      const [dark, light] = [luminance(ink), luminance(fill)].sort((a, b) => a - b);
      return {
        inert: fold.querySelectorAll("a, img, script").length === 0 && fold.innerText.includes(${JSON.stringify(instruction)}),
        second: fold.innerText.includes("Second instruction"),
        focused: document.activeElement === fold.firstElementChild,
        outline: css.outlineStyle,
        contrast: (light + .05) / (dark + .05) >= 4.5,
        theme: document.documentElement.dataset.theme,
        wide: document.documentElement.scrollWidth,
        hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === fold.firstElementChild,
        height: rect.height,
      };
    })()`)).toMatchObject({ inert: true, second: true, focused: true, outline: "solid", contrast: true, theme, wide: width, hit: true });
    expect(await view.evaluate(`document.querySelector(${JSON.stringify(summary)}).getBoundingClientRect().height`))
      .toBeGreaterThanOrEqual(width === 390 ? 44 : 24);
    expect((await app.post(`${app.path}/actions`, { action: "prompt", message: "Deliver fixture redraw" })).status).toBe(200);
    await waitFor(view, `document.querySelector(${JSON.stringify(fold)}).innerText.includes("Redrawn instruction")`);
    expect(await view.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(summary)})`)).toBe(true);
    expect(await historyReads()).toEqual([app.path]);
    await view.evaluate(`document.querySelector(${JSON.stringify(`${pagedFold} > summary`)}).focus()`);
    await view.press("Enter");
    await waitFor(view, `document.querySelector(${JSON.stringify(btn)})?.getClientRects().length`);
    await screenshot(view, `paged-open-${key}`, pagedRow);
    expect(await historyReads()).toEqual([app.path]);
    for (let i = 0; i < Math.ceil(seed.largeBody.length / (10 * 1024)); i++) {
      const chunks = `${pagedFold} .transcript-content .plain > span`;
      await view.evaluate(`document.querySelector(${JSON.stringify(btn)}).scrollIntoView({block: "center"})`);
      await view.click(btn);
      await waitFor(view, `document.querySelectorAll(${JSON.stringify(chunks)}).length === ${i + 1}`);
    }
    await screenshot(view, `paged-loaded-${key}`, pagedRow);
    expect(await historyReads()).toEqual([app.path, ...Array.from({ length: 7 }, () => `${app.path}/transcript/content`)]);
    expect(await view.evaluate(`(() => {
      const fold = document.querySelector(${JSON.stringify(pagedFold)});
      const row = fold.closest("article");
      return { first: fold.innerText.includes("BIG INSTRUCTION START"), end: fold.innerText.includes("BIG INSTRUCTION END"),
        caller: row.querySelector(".message-body > p").textContent,
        noDuplicate: !fold.textContent.includes("Paged caller"), noExternal: !performance.getEntriesByName(location.origin + "/skill-test-probe").length };
    })()`)).toEqual({ first: true, end: true, caller: pagedRequest, noDuplicate: true, noExternal: true });
  });
}
