import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Wire } from "../src/web/dom.ts";

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const evidence = process.env.OMO_TOOL_DISPLAY_EVIDENCE;
const session = { id: "tool-display-fixture", name: "工具调用 · 合成验收", cwd: "/fixture/workbench", active: true };
const assistant = (...content: Wire[]): Wire => ({ id: "assistant-fixture", role: "assistant", content });
const text = (value: string): Wire => ({ type: "text", text: value });
const call = (id: string, name: string, args: Wire): Wire => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, isError: boolean | undefined, output: string): Wire =>
  ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [text(output)] });

async function waitFor(browser: Bun.WebView, expression: string): Promise<void> {
  await browser.evaluate(`new Promise((resolve, reject) => {
    const check = () => {
      if (!(${expression})) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(${JSON.stringify(`Fixture condition not reached: ${expression}`)}));
    }, 3000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  })`);
}

async function withWorkbench(width: number, messages: readonly Wire[], run: (browser: Bun.WebView, emit: (event: Wire) => void) => Promise<void>) {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not bundle the workbench browser fixture");
  let events: ReadableStreamDefaultController<string> | undefined;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true } }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { events = controller; controller.enqueue(": fixture\n\n"); },
        cancel() { events = undefined; },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`/api/sessions/${session.id}`]: () => Response.json({ session, messages, state: {} }),
      [`/api/sessions/${session.id}/options`]: Response.json({}),
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width, height: width < 760 ? 844 : 900 });
  await browser.navigate(server.url.href);
  await waitFor(browser, `document.querySelector("#connection")?.dataset.state === "online"`);
  if (width < 760) await browser.click("#open-navigation");
  await browser.click(".session-link");
  await waitFor(browser, `!!document.querySelector("#messages article")`);
  await run(browser, event => {
    if (!events) throw new Error("Synthetic event stream is not connected");
    events.enqueue(`event: omo\ndata: ${JSON.stringify({ ...event, sessionId: session.id })}\n\n`);
  });
}

async function capture(browser: Bun.WebView, name: string): Promise<void> {
  if (evidence) await Bun.write(join(evidence, `${name}.png`), await browser.screenshot());
}

browserTest("A live tool keeps its open disclosure and keyboard focus when it succeeds", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查工作台里工具调用的渲染。" },
    assistant(text("先读取对话渲染代码，再核对结果是否就地更新。")),
  ], async (browser, emit) => {
    const tool = { toolCallId: "live-read", toolName: "read", args: { path: "src/web/transcript.ts" } };
    emit({ type: "tool_execution_start", ...tool });
    await waitFor(browser, `!!document.querySelector(".message--tool summary")`);
    const running = await browser.evaluate(`document.querySelector(".message--tool summary").textContent`);
    await capture(browser, "desktop-light-running");
    await browser.evaluate(`document.querySelector(".message--tool summary").focus()`);
    await browser.press("Enter");
    await waitFor(browser, `!!document.querySelector(".message--tool details[open]")`);
    emit({ type: "tool_execution_end", ...tool, isError: false, result: { content: [text("合成输出：读取完成。")] } });
    await waitFor(browser, `document.querySelector("#messages").textContent.includes("合成输出：读取完成。")`);
    const done = await browser.evaluate(`(() => {
      const details = document.querySelector(".message--tool details");
      const summary = details.querySelector("summary");
      return { open: details.open, focused: document.activeElement === summary, label: summary.textContent };
    })()`);
    await capture(browser, "desktop-light");
    expect(done).toMatchObject({ open: true, focused: true, label: expect.stringContaining("成功") });
    expect(running).toEqual(expect.stringContaining("运行中"));
    expect(running).toEqual(expect.stringContaining("src/web/transcript.ts"));
  });
});

browserTest("Persisted tools correlate at call position with safe recaps and bounded output on a phone", async () => {
  const long = Array.from({ length: 36 }, (_, i) => `${i + 1}  合成诊断 · ${"路径非常长".repeat(36)}`).join("\n");
  await withWorkbench(390, [
    { role: "user", content: "查找中文文档并查看失败原因。" },
    assistant(
      text("先搜索文档，再尝试更新。"),
      call("search", "grep", { path: "docs/工作台", pattern: "fixture-private-query" }),
      call("edit", "edit", { path: "docs/工作台/说明.md", newText: "fixture-private-edit" }),
      text("最后检查还有没有返回结果。"),
      call("unknown", "bash", { command: "echo fixture-private-argv" }),
    ),
    result("search", "grep", false, "过时的合成输出"),
    result("search", "grep", false, long),
    result("edit", "edit", true, "合成错误：<img src=x onerror=alert(1)>"),
  ], async browser => {
    await browser.evaluate(`document.documentElement.dataset.theme = "dark"`);
    await capture(browser, "phone-dark-collapsed");
    const rows = await browser.evaluate<string[]>(`Array.from(document.querySelectorAll("#messages details > summary"), node => node.textContent)`);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(expect.stringContaining("成功"));
    expect(rows[0]).toEqual(expect.stringContaining("docs/工作台"));
    expect(rows[1]).toEqual(expect.stringContaining("失败"));
    expect(rows[2]).toEqual(expect.stringContaining("未见结果"));
    expect(rows.join(" ")).not.toMatch(/fixture-private|合成诊断|合成错误/);
    await browser.click(".message--tool summary");
    const layout = await browser.evaluate<{
      pageWidth: number; transcriptWidth: number; outputHeight: number; outputScrollHeight: number;
      outputWidth: number; details: string; injected: boolean;
    }>(`(() => {
      const viewport = document.querySelector("#transcript");
      const output = document.querySelector(".tool-output");
      if (!output.hidden) output.scrollIntoView({ block: "end" });
      return {
        pageWidth: document.documentElement.scrollWidth,
        transcriptWidth: viewport.scrollWidth - viewport.clientWidth,
        outputHeight: output.clientHeight,
        outputScrollHeight: output.scrollHeight,
        outputWidth: output.scrollWidth - output.clientWidth,
        details: document.querySelector(".tool-details[open]").textContent,
        injected: !!document.querySelector("#messages img"),
      };
    })()`);
    await capture(browser, "phone-dark");
    expect(layout.pageWidth).toBe(390);
    expect(layout.transcriptWidth).toBe(0);
    expect(layout.injected).toBe(false);
    expect(layout.details).toContain("fixture-private-query");
    expect(layout.details).not.toContain("过时的合成输出");
    expect(layout.outputHeight).toBeLessThanOrEqual(352);
    expect(layout.outputScrollHeight).toBeGreaterThan(layout.outputHeight);
    expect(layout.outputWidth).toBeGreaterThan(0);
    console.info(`Tool output: viewport ${layout.pageWidth}px; ${layout.outputHeight}/${layout.outputScrollHeight}px visible/total; ${layout.outputWidth}px local horizontal overflow`);
  });
});

browserTest("Loading older calls moves the open tool back into source order without losing its reading anchor", async () => {
  await withWorkbench(1440, [
    assistant(text("从这个较早的助手消息开始。\n\n工具行应回到调用原位。"), call("older", "grep", { path: "src" })),
    result("older", "grep", undefined, "已记录输出，未记录状态。"),
    ...Array.from({ length: 79 }, (_, index) => ({ id: `tail-${index}`, role: "user", content: `合成历史 ${index}` })),
  ], async browser => {
    await browser.evaluate(`(() => {
      document.querySelector("#transcript").scrollTop = 0;
      document.querySelector(".message--tool summary").focus({ preventScroll: true });
    })()`);
    await browser.press("Enter");
    const history = await browser.evaluate<{
      count: number; inline: boolean; open: boolean; focused: boolean; topDelta: number; recap: string;
    }>(`(() => {
      const row = document.querySelector(".message--tool");
      const summary = row.querySelector("summary");
      const top = row.getBoundingClientRect().top;
      document.querySelector(".transcript-load").click();
      return {
        count: document.querySelectorAll(".message--tool").length,
        inline: !!row.closest(".message-body"),
        open: row.querySelector("details").open,
        focused: document.activeElement === summary,
        topDelta: row.getBoundingClientRect().top - top,
        recap: summary.textContent,
      };
    })()`);
    expect(history.count).toBe(1);
    expect(history.inline).toBe(true);
    expect(history.open).toBe(true);
    expect(history.focused).toBe(true);
    expect(Math.abs(history.topDelta)).toBeLessThanOrEqual(1);
    expect(history.recap).toContain("src");
    expect(history.recap).toContain("状态未知");
    console.info(`Tool history: one open, focused tool at the original call; anchor Δ${history.topDelta}px`);
  });
});
