import { expect, test } from "bun:test";
import type { ToolTrace, Transcript, TranscriptEntry } from "../src/web/transcript.ts";

// Browser checks require a Bun with WebView support and an installed Chromium.
const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome") ??
  (await Bun.file("/opt/google/chrome/chrome").exists() ? "/opt/google/chrome/chrome" : undefined);
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
type Evaluate = <T>(run: (ctor: typeof Transcript) => T) => Promise<Awaited<T>>;

async function withTranscript(run: (evaluate: Evaluate, browser: Bun.WebView) => Promise<void>) {
  const bundle = await Bun.build({ entrypoints: ["src/web/transcript.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not bundle the transcript browser fixture");
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/app.js": () => new Response(script),
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium, url: false }, width: 1440, height: 900 });
  await browser.navigate(server.url.href);
  const evaluate: Evaluate = browserRun => browser.evaluate(`import("/app.js").then(({ Transcript }) => (${browserRun.toString()})(Transcript))`);
  await run(evaluate, browser);
}

browserTest("Chromium mounts only recent history and keeps the reading boundary on keyboard expansion", async () => {
  await withTranscript(async (evaluate, browser) => {
    const mounted = await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      const section = document.getElementById("active-session");
      const welcome = document.getElementById("welcome");
      if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
      section.hidden = false;
      welcome.hidden = true;
      const entries = Array.from({ length: 1000 }, (_, index) => ({
        key: `entry:${index}`, message: { role: "assistant", content: `Synthetic history message ${index}` },
      }));
      new Transcript(root, scroller, empty).render(entries, "", new Map(), true);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const count = root.querySelectorAll("article").length;
      if (count > 100 || count < 1) throw new Error(`Initial mounted articles: ${count}; expected 1–100`);
      if (!root.lastElementChild?.textContent?.includes("Synthetic history message 999")) throw new Error("Recent tail missing");
      scroller.scrollTop = 0;
      const boundary = root.querySelector("article");
      const load = root.querySelector("button");
      if (!boundary || !load || load.hidden) throw new Error("No accessible older history control");
      load.focus();
      boundary.dataset.anchorTop = String(boundary.getBoundingClientRect().top);
      return count;
    });
    await browser.press("Enter");
    const result = await evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const boundary = document.querySelector<HTMLElement>("#messages article[data-anchor-top]");
      if (!boundary) throw new Error("History expansion replaced the existing anchor node");
      return {
        delta: boundary.getBoundingClientRect().top - Number(boundary.dataset.anchorTop),
        focus: document.activeElement === boundary,
        ids: [...document.querySelectorAll("#messages article")].map(node => Number(node.textContent?.match(/\d+$/)?.[0])),
      };
    });
    expect(result.ids.length).toBeGreaterThan(mounted);
    expect(result.ids).toEqual(Array.from({ length: result.ids.length }, (_, index) => 1000 - result.ids.length + index));
    expect(Math.abs(result.delta)).toBeLessThanOrEqual(1);
    expect(result.focus).toBe(true);
    console.info(`Transcript: ${mounted} → ${result.ids.length} articles; keyboard expansion anchor Δ${result.delta}px`);
  });
});

browserTest("Chromium coalesces live bursts, retains settled Markdown, and follows only when requested or near the end", async () => {
  await withTranscript(evaluate => evaluate(async Transcript => {
    const root = document.getElementById("messages");
    const scroller = document.getElementById("transcript");
    const empty = document.getElementById("no-messages");
    const section = document.getElementById("active-session");
    const welcome = document.getElementById("welcome");
    if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
    section.hidden = false;
    welcome.hidden = true;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const transcript = new Transcript(root, scroller, empty);
    const entries: TranscriptEntry[] = Array.from({ length: 60 }, (_, index) => ({
      key: `entry:${index}`, message: { role: "user", content: `Synthetic history message ${index}` },
    }));
    const tools = new Map<string, ToolTrace>();
    const update = (suffix: string, live = true, force = false) => {
      const entry = { key: "live", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Synthetic reasoning" },
        { type: "text", text: `**Settled paragraph**\n\n${suffix}` },
      ] } };
      if (entries.at(-1)?.key === "live") entries[entries.length - 1] = entry;
      else entries.push(entry);
      transcript.render(entries, live ? "live" : "", tools, force);
    };
    update("Live draft", true, true);
    await frame();
    const live = root.lastElementChild;
    const paragraph = live?.querySelector("strong");
    const details = live?.querySelector("details");
    if (!live || !paragraph || !details) throw new Error("Initial live content missing");
    details.open = true;
    scroller.scrollTop = 400;
    const reading = scroller.scrollTop;

    for (let index = 0; index < 40; index++) update(`Live draft ${index}`);
    const immediate = live.textContent;
    await frame();
    if (immediate?.includes("Live draft 39") || !live.textContent?.includes("Live draft 39")) {
      throw new Error("Live burst must commit the latest token on the next animation frame only");
    }
    if (live.querySelector("strong") !== paragraph || live.querySelector("details") !== details || !details.open) {
      throw new Error("Settled Markdown or open thinking fold was replaced by streaming");
    }
    if (scroller.scrollTop !== reading) throw new Error(`Scrolled away from the reader: ${reading} → ${scroller.scrollTop}`);

    const final = "Live draft 39\n\n`safe` <img src=x> [link](https://example.invalid) [unsafe](javascript:alert%281%29)";
    update(final, false, true);
    await frame();
    const remaining = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const links = [...live.querySelectorAll<HTMLAnchorElement>("a[href]")];
    if (remaining() > 1 || !live.textContent?.includes("<img src=x>") || live.querySelector("img") ||
      links.length !== 1 || links[0].href !== "https://example.invalid/" ||
      !links[0].relList.contains("noreferrer") || !live.querySelector("code")) {
      throw new Error("Forced follow or safe final Markdown rendering failed");
    }
    update(`${final}\n\nNew line`, false);
    await frame();
    if (remaining() > 1) throw new Error("Reader at the bottom did not follow new content");
    update("Queued before reset");
    transcript.reset();
    await frame();
    if (root.querySelector("article") || scroller.scrollTop !== 0) throw new Error("Reset left a stale frame or scroll position");
  }));
});

browserTest("Chromium keeps tool order, ignores traces for hidden results, and retains open state as tools finish", async () => {
  await withTranscript(evaluate => evaluate(async Transcript => {
    const root = document.getElementById("messages");
    const scroller = document.getElementById("transcript");
    const empty = document.getElementById("no-messages");
    const section = document.getElementById("active-session");
    const welcome = document.getElementById("welcome");
    if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
    section.hidden = false;
    welcome.hidden = true;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const transcript = new Transcript(root, scroller, empty);
    const entries: TranscriptEntry[] = [
      { key: "result:hidden", message: { role: "toolResult", toolCallId: "hidden", content: "Hidden historical result" } },
      ...Array.from({ length: 100 }, (_, index) => ({
        key: `entry:${index}`, message: { role: "assistant", content: `Synthetic history message ${index}` },
      })),
    ];
    const tools = new Map<string, ToolTrace>([
      ["hidden", { id: "hidden", name: "Hidden tool", stage: "done" }],
      ["active", { id: "active", name: "Synthetic tool", args: { input: "sample" }, stage: "running" }],
    ]);
    transcript.render(entries, "", tools, true);
    await frame();
    const tool = root.querySelector(".message--tool");
    const fold = tool?.querySelector("details");
    if (!tool || !fold || tool !== root.lastElementChild || root.textContent?.includes("Hidden tool")) {
      throw new Error("The visible tool trace must follow messages without duplicating hidden results");
    }
    fold.open = true;
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSmsAAAAASUVORK5CYII=";
    entries.push({ key: "result:active", message: { role: "toolResult", toolCallId: "active", content: [
      { type: "text", text: "Synthetic output <script>" },
      { type: "image", mimeType: "image/png", data: imageData },
      { type: "image", mimeType: "image/svg+xml", data: "eA==" },
    ] } });
    entries.push({ key: "after", message: { role: "user", content: "After the tool" } });
    transcript.render(entries, "", tools);
    await frame();
    const images = tool.querySelectorAll("img");
    if (root.querySelector(".message--tool") !== tool || !tool.querySelector("details")?.open ||
      !tool.nextElementSibling?.textContent?.includes("After the tool") || !tool.textContent?.includes("Synthetic output <script>") ||
      tool.querySelector("script") || images.length !== 1 || images[0]?.src !== `data:image/png;base64,${imageData}`) {
      throw new Error("Settled tool lost its position, fold, escaped text, or allowed image");
    }
  }));
});

browserTest("Chromium keeps only adjacent, proven reads in one disclosure and removes pure-tool headers", async () => {
  await withTranscript(async evaluate => {
    const actual = await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      if (!root || !scroller || !empty) throw new Error("Missing transcript markup");
      const call = (id: string, name = "read") => ({ type: "toolCall", id, name, arguments: { path: `${id}.ts` } });
      const assistant = (key: string, ...content: object[]) => ({ key, message: { role: "assistant", timestamp: 1, content } });
      const result = (id: string, isError: boolean | undefined = false, truncated = false) => ({
        key: `result:${id}`, message: { role: "toolResult", toolCallId: id, isError, truncated, content: `Output ${id}` },
      });
      const user = (key: string) => ({ key, message: { role: "user", content: key } });
      const transcript = new Transcript(root, scroller, empty);
      transcript.render([
        assistant("no-user", call("prior-a"), call("prior-b")), result("prior-a"), result("prior-b"),
        user("first"), assistant("reads", call("a"), call("b", "grep")), result("a"), result("b"),
        assistant("lists", call("c", "ls")), result("c"),
        assistant("notice", { type: "thinking", thinking: "Reasoning" }, call("d")), result("d"),
        assistant("blocked", call("e"), call("write", "write"), call("f"), call("failed"), call("g"),
          call("clipped"), call("h"), call("unknown"), call("i"), call("running"), call("j")),
        result("e"), result("write"), result("f"), result("failed", true), result("g"), result("clipped", false, true),
        result("h"), { ...result("unknown"), message: { ...result("unknown").message, isError: undefined } },
        result("i"), result("j"),
        user("second"), assistant("single", call("k")), result("k"),
        { key: "approval", message: { role: "custom", content: "Approval required" } },
        assistant("after-approval", call("l")), result("l"),
      ], "", new Map([["running", { id: "running", name: "read", stage: "running" }]]));
      await new Promise(resolve => requestAnimationFrame(resolve));
      return {
        groups: [...root.querySelectorAll(".tool-group")].map(group =>
          [...group.querySelectorAll(".tool-target")].map(target => target.textContent)),
        calls: [...root.querySelectorAll(".tool-target")].map(target => target.textContent),
        headers: [...root.querySelectorAll("article > header .speaker")].map(header => header.textContent),
        times: root.querySelectorAll("time").length,
      };
    });
    expect(actual.groups).toEqual([["a.ts", "b.ts", "c.ts"], ["d.ts", "e.ts"]]);
    expect(actual.calls).toEqual([
      "prior-a", "prior-b", "a", "b", "c", "d", "e", "write", "f", "failed", "g", "clipped", "h", "unknown", "i", "running", "j", "k", "l",
    ].map(id => `${id}.ts`));
    expect(actual.headers).toEqual(["你", "助手", "你", "会话记录"]);
    expect(actual.times).toBe(1);
  });
});

browserTest("Loading a clipped user turn groups its calls without hiding the open, focused call", async () => {
  await withTranscript(async evaluate => {
    const outcome = await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      const section = document.getElementById("active-session");
      if (!root || !scroller || !empty || !section) throw new Error("Missing transcript markup");
      section.hidden = false;
      const ids = ["a", "b"];
      new Transcript(root, scroller, empty).render([
        { key: "user", message: { role: "user", content: "Read both files" } },
        { key: "read", message: { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "read" })) } },
        ...ids.map(id => ({ key: `result:${id}`, message: { role: "toolResult", toolCallId: id, isError: false, content: id } })),
        ...Array.from({ length: 77 }, (_, index) => ({ key: `tail:${index}`, message: { role: "user", content: String(index) } })),
      ], "", new Map());
      await new Promise(resolve => requestAnimationFrame(resolve));
      const summary = root.querySelector<HTMLElement>(".tool-summary");
      const details = summary?.closest("details");
      const older = root.querySelector("button");
      if (!summary || !details || !older || older.hidden || root.querySelector(".tool-group")) throw new Error("Missing clipped-turn setup");
      details.open = true;
      scroller.scrollTop = 0;
      summary.focus({ preventScroll: true });
      const top = summary.getBoundingClientRect().top;
      older.click();
      return { open: details.open, visible: !!summary.closest(".tool-group[open]"), focused: document.activeElement === summary,
        reading: Math.abs(summary.getBoundingClientRect().top - top) <= 1 };
    });
    expect(outcome).toEqual({ open: true, visible: true, focused: true, reading: true });
  });
});
