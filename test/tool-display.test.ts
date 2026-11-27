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

async function withWorkbench(width: number, messages: readonly Wire[], run: (browser: Bun.WebView, emit: (event: Wire) => void) => Promise<void>, locale?: "en") {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not bundle the workbench browser fixture");
  let events: ReadableStreamDefaultController<string> | undefined;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": async () => {
        const html = await Bun.file("public/index.html").text();
        const page = locale ? html.replace("<head>", `<head><script>localStorage.setItem("omo-web-language", ${JSON.stringify(locale)})</script>`) : html;
        return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
      "/icons.svg": () => new Response(Bun.file("public/icons.svg")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/workbench.css": () => new Response(Bun.file("public/workbench.css")),
      "/tool-ledger.css": async () => {
        const stylesheet = Bun.file("public/tool-ledger.css");
        return await stylesheet.exists() ? new Response(stylesheet) : new Response(null, { status: 404 });
      },
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true } }),
      "/api/cli-history": Response.json({ available: true, sessions: [] }),
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
    const rows = await browser.evaluate<string[]>(`Array.from(document.querySelectorAll("#messages .tool-details > summary"), node => node.textContent)`);
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

browserTest("Loading the originating turn groups the same open, focused call in place", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查原始调用顺序。" },
    assistant(call("first", "read", { path: "src/first.ts" }), call("second", "read", { path: "src/second.ts" })),
    result("first", "read", false, "第一份读取结果"),
    result("second", "read", false, "第二份读取结果"),
    ...Array.from({ length: 77 }, (_, index) => ({ id: `tail-${index}`, role: "user", content: `合成历史 ${index}` })),
  ], async browser => {
    expect(await browser.evaluate(`document.querySelectorAll(".tool-group").length`)).toBe(0);
    await browser.evaluate(`(() => {
      document.querySelector("#transcript").scrollTop = 0;
      window.historicalCall = document.querySelectorAll(".tool-details")[1];
      window.historicalCall.querySelector("summary").focus({ preventScroll: true });
    })()`);
    await browser.press("Enter");
    const regrouped = await browser.evaluate<{ topDelta: number }>(`(() => {
      const call = window.historicalCall;
      const summary = call.querySelector("summary");
      const top = summary.getBoundingClientRect().top;
      document.querySelector(".transcript-load").click();
      const group = call.closest(".tool-group");
      return {
        original: group?.querySelectorAll(".tool-details")[1] === call,
        focused: document.activeElement === summary,
        disclosed: group?.open && call.open,
        output: call.querySelector(".tool-output").innerText,
        topDelta: summary.getBoundingClientRect().top - top,
      };
    })()`);
    expect(regrouped).toMatchObject({ original: true, focused: true, disclosed: true, output: "第二份读取结果" });
    expect(Math.abs(regrouped.topDelta)).toBeLessThanOrEqual(1);
  });
});

browserTest("The tool trace focuses a visible group summary, and Tab reaches each original call after opening", async () => {
  const members = [
    call("source", "read", { path: "src/web/transcript.ts" }),
    call("duplicate", "read", { path: "src/web/transcript.ts" }),
    call("unsafe-path", "read", { path: "../../ghp_private-path" }),
    call("tests", "find", { path: "test", pattern: "private-find-query" }),
    call("third-path", "grep", { path: "docs/third-path.md", pattern: "private-grep-query" }),
    call("script", "eval", { language: "js", code: "private-group-script" }),
    call("web", "webfetch", { url: "https://example.org/private-group-url" }),
  ];
  await withWorkbench(1440, [
    { role: "user", content: "检查源文件和测试。" },
    assistant(...members),
    ...members.map(member => result(String(member.id), String(member.name), false, `private-group-result-${member.id}`)),
  ], async browser => {
    const ledger = await browser.evaluate(`(() => {
      const group = document.querySelector(".tool-group");
      const head = group.firstElementChild;
      const list = group.querySelector(":scope > ol");
      return {
        summary: head.innerText, open: group.open,
        paths: [...head.querySelectorAll(".tool-group-path")].map(path => path.textContent),
        states: [...(list?.children ?? [])].map(row => row.querySelector(".tool-details").dataset.state),
        rows: [...(list?.children ?? [])].map(row => row.tagName),
      };
    })()`);
    expect(ledger).toMatchObject({
      open: false, paths: ["src/web/transcript.ts", "test"], states: Array(7).fill("success"), rows: Array(7).fill("LI"),
      summary: expect.not.stringMatching(/private-|third-path|example\.org|JavaScript/),
    });
    await browser.click("#trace-jump-tool");
    const groupFocused = await browser.evaluate(`document.activeElement.matches(".tool-group-summary")`);
    expect(groupFocused).toBe(true);
    await browser.press("Enter");
    await waitFor(browser, `!!document.querySelector(".tool-group[open]")`);
    await browser.press("Tab");
    const first = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    await browser.press("Enter");
    const opened = await browser.evaluate(`document.activeElement.parentElement.open`);
    await browser.press("Enter");
    await browser.press("Tab");
    const second = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    await browser.press("Tab");
    const third = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    await browser.press("Tab");
    const fourth = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    await browser.press("Enter");
    const fourthReceipt = await browser.evaluate(`document.activeElement.parentElement.querySelector(".tool-output").innerText`);
    await browser.evaluate(`document.querySelector(".tool-group-body .tool-summary").focus()`);
    await browser.press("Enter");
    const openRows = await browser.evaluate(`Array.from(document.querySelectorAll(".tool-group .tool-details[open] .tool-output"), row => row.innerText)`);
    expect([first, second, third, fourth]).toEqual(["src/web/transcript.ts", "src/web/transcript.ts", "", "test"]);
    expect(opened).toBe(true);
    expect(fourthReceipt).toBe("private-group-result-tests");
    expect(openRows).toEqual(["private-group-result-source", "private-group-result-tests"]);
  });
});

browserTest("Narrative before a read allows grouping, but narrative between reads keeps both separate", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查清单和工作区。" },
    { ...assistant(text("先核对检查清单。"), call("checklist", "read", { path: "release-checklist.md" })), stopReason: "toolUse" },
    result("checklist", "read", false, "检查清单输出"),
    { ...assistant(call("scope", "read", { path: "workspace-notes.md" })), id: "scope", stopReason: "toolUse" },
    result("scope", "read", false, "工作区输出"),
    { role: "user", content: "检查另外两个文件。" },
    { ...assistant(call("first", "read", { path: "first.md" }), text("第一份已核对。")), id: "first", stopReason: "toolUse" },
    result("first", "read", false, "第一份输出"),
    { ...assistant(call("next", "read", { path: "next.md" })), id: "next", stopReason: "toolUse" },
    result("next", "read", false, "下一份输出"),
  ], async browser => {
    const standalone = await browser.evaluate(`Array.from(document.querySelectorAll("#messages .tool-target"))
      .filter(target => !target.closest(".tool-group")).map(target => target.textContent)`);
    expect(standalone).toEqual(["first.md", "next.md"]);
    const groups = await browser.evaluate(`Array.from(document.querySelectorAll("#messages .tool-group"), group =>
      Array.from(group.querySelectorAll(".tool-summary .tool-target"), target => target.textContent))`);
    expect(groups).toEqual([["release-checklist.md", "workspace-notes.md"]]);
  });
});

browserTest("Mixed execution results group by outer tool and keep their focused original disclosure on stream updates", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "执行上下文检查" },
    { ...assistant(call("ctx", "ctx_execute", { code: "private-script" })), stopReason: "toolUse" },
    result("ctx", "ctx_execute", false, "private-context-output"),
    { ...assistant(call("eval", "eval", { language: "js", summary: "private-summary", code: "tool.memory({command:'view'})" })),
      id: "eval-assistant", stopReason: "toolUse" },
    result("eval", "eval", false, "private-eval-output"),
  ], async (browser, emit) => {
    const groups = await browser.evaluate(`Array.from(document.querySelectorAll(".tool-group"), group => ({
      open: group.open,
      label: group.querySelector(".tool-group-summary").textContent.trim(),
      chips: Array.from(group.querySelectorAll(".tool-group-kind"), chip => chip.textContent),
    }))`);
    expect(groups).toEqual([{ open: false, label: "工具调用 · 2 项成功 Ctx Execute ×1 Eval ×1",
      chips: ["Ctx Execute ×1", "Eval ×1"] }]);
    await capture(browser, "desktop-light-mixed-ledger");
    await browser.click("#trace-jump-tool");
    await browser.press("Enter");
    await browser.press("Tab");
    await browser.press("Enter");
    await browser.evaluate(`(() => {
      window.ledgerGroup = document.querySelector(".tool-group[open]");
      window.ledgerFold = window.ledgerGroup.querySelector(".tool-details[open]");
    })()`);
    emit({ type: "tool_execution_start", toolCallId: "next-live", toolName: "eval", args: { code: "private-next" } });
    await waitFor(browser, `!!document.querySelector('.tool-details[data-state="running"]')`);
    const settled = await browser.evaluate<{ summaries: string }>(`({
      same: window.ledgerGroup === document.querySelector(".tool-group[open]") &&
        window.ledgerFold === document.querySelector(".tool-group .tool-details[open]"),
      focused: document.activeElement === window.ledgerFold.querySelector(".tool-summary"),
      oldArgs: window.ledgerFold.querySelector("pre").textContent.includes("private-script"),
      oldOutput: window.ledgerFold.querySelector(".tool-output").textContent.includes("private-context-output"),
      order: Array.from(window.ledgerGroup.querySelectorAll(".tool-label"), label => label.textContent),
      summaries: Array.from(document.querySelectorAll("#messages summary"), node => node.textContent).join(" "),
    })`);
    expect(settled).toMatchObject({ same: true, focused: true, oldArgs: true, oldOutput: true, order: ["Ctx Execute", "Eval"] });
    expect(settled.summaries).not.toMatch(/private-|Memory/);
  });
});

browserTest("Category rows expose only recognized operations and reserve the Bash command for the open terminal", async () => {
  const payloads = [
    ["memory", { command: "str_replace", file_path: "private-memory-path", new_string: "private-memory-data" }],
    ["bash", { command: "printf private-command" }],
    ["todowrite", { op: "init", list: [{ phase: "private-phase", items: ["核对渲染", "保留草稿"] }] }],
    ["todo", { op: "private-unknown-op", items: ["private-don't-count"] }],
    ["read", { path: "src" }],
    ["apply_patch", { patch: "private-edit" }],
    ["task", { subagent_type: "delivery-worker", run_in_background: false, task_id: "private-task-identity",
      task_summary: "private-agent-prompt" }],
    ["web_search", { query: "private-query" }],
    ["mcp_plugin:custom", { command: "private-plugin-value" }],
    ["shell", { command: "private-shell-command" }],
    ["powershell", { command: "private-powershell-command" }],
    ["todowrite", { todos: [{ content: "private-alternate-title", status: "completed" }] }],
  ] as const;
  await withWorkbench(390, [
    { role: "user", content: "检查工具类别" },
    assistant(...payloads.map(([name, args], i) => call(String(i), name, args))),
    ...payloads.map(([name], i) => ({ ...result(String(i), name, i === 1 ? true : false, "private-result"),
      details: { command: "private-opaque-details" } })),
  ], async browser => {
    if (evidence) {
      await browser.evaluate(`document.documentElement.dataset.theme = "light"`);
      await capture(browser, "phone-light-tool-hud");
      await browser.evaluate(`document.documentElement.dataset.theme = "dark"`);
      await capture(browser, "phone-dark-tool-hud");
      await browser.evaluate(`delete document.documentElement.dataset.theme`);
    }
    await browser.cdp("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    const view = await browser.evaluate<{
      categories: string[]; operations: string[]; glyphs: string[]; summaries: string[]; forced: boolean; folded: boolean;
    }>(`(() => {
      const rows = Array.from(document.querySelectorAll("#messages .tool-details"));
      return {
        categories: rows.map(row => row.dataset.toolKind),
        operations: rows.map(row => row.querySelector(".tool-operation")?.textContent ?? ""),
        glyphs: rows.map(row => row.querySelector(".tool-kind-icon path")?.getAttribute("d")),
        summaries: rows.map(row => row.querySelector("summary").innerText),
        forced: matchMedia("(forced-colors: active)").matches,
        folded: rows.every(row => !row.open),
      };
    })()`);
    expect(view.categories).toEqual(["memory", "terminal", "todo", "todo", "inspect", "modify", "agent", "web", "unknown", "terminal", "terminal", "todo"]);
    expect(view.operations.slice(0, 4)).toEqual(["替换", "运行命令", "初始化 · 2 项", ""]);
    expect(view.operations.slice(-3)).toEqual(["运行命令", "运行命令", ""]);
    expect(new Set(view.glyphs).size).toBe(8);
    expect(view.glyphs.every(Boolean)).toBe(true);
    expect(view.forced && view.folded).toBe(true);
    expect(view.summaries.join(" ")).not.toMatch(/private-/);
    expect(view.summaries[2]).toContain("核对渲染");
    expect(view.summaries[2]).not.toContain("保留草稿");
    expect(view.summaries[6]).toMatch(/delivery-worker.*前台/s);
    expect(view.summaries[1]).toContain("失败");
    expect(view.summaries[1]).toContain("Bash");
    expect(view.summaries[8]).toContain("mcp_plugin:custom");
    expect(view.summaries[9]).toContain("Shell");
    expect(view.summaries[10]).toContain("PowerShell");
    expect(view.summaries[11]).toMatch(/^Todo\s*成功$/u);
    await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="terminal"][data-state="error"] > summary').focus()`);
    await browser.press("Enter");
    await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="terminal"][open] .tool-raw-args > summary').focus()`);
    await browser.press("Enter");
    const terminal = await browser.evaluate(`(() => {
      const fold = document.querySelector('.tool-details[data-tool-kind="terminal"][open]');
      const command = fold.querySelector(".tool-command-preview");
      const transcript = document.querySelector("#transcript");
      return { text: command?.innerText, font: command && getComputedStyle(command.querySelector("code")).fontFamily,
        inside: !!command?.closest(".fold-body"), rawCommand: JSON.parse(fold.querySelector(".tool-raw-args[open] pre").textContent).command,
        output: fold.querySelector(".tool-output").textContent,
        overflow: transcript.scrollWidth - transcript.clientWidth };
    })()`);
    expect(terminal).toMatchObject({ text: expect.stringContaining("printf private-command"),
      font: expect.stringContaining("monospace"), inside: true, rawCommand: "printf private-command", output: "private-result", overflow: 0 });
    await browser.press("Enter");
    await capture(browser, "phone-forced-colors-terminal");
    await browser.evaluate(`Array.from(document.querySelectorAll(".tool-summary")).at(-1).focus()`);
    await browser.press("Enter");
    await browser.press("Tab");
    expect(await browser.evaluate(`document.activeElement.matches(".tool-todo-receipt > summary")`)).toBe(true);
    await browser.press("Enter");
    const alternate = await browser.evaluate(`(() => {
      const card = document.activeElement.closest(".tool-details");
      return { receipt: card.querySelector(".tool-output").innerText, shows: card.innerText,
        items: card.querySelectorAll(".tool-todo-board li").length };
    })()`);
    expect(alternate).toMatchObject({ receipt: "private-result", items: 0,
      shows: expect.not.stringMatching(/private-alternate-title|completed/) });
  });
});

browserTest("Todo separates the submitted list from the receipt; Memory disclosures stay opt-in", async () => {
  await withWorkbench(390, [
    { role: "user", content: "检查工具回执" },
    assistant(call("todo-detail", "todo", { op: "init", list: [{ phase: "检查", items: ["核对渲染", "保留草稿"] },
      { phase: "验收", items: ["记录检查结论"] }] }),
      call("memory-detail", "memory", { command: "update_description", file_path: "private-project.md", description: "private-description" })),
    result("todo-detail", "todo", false, "原生待办回执"),
    result("memory-detail", "memory", false, "原生记忆回执"),
  ], async browser => {
    const read = (kind: string) => browser.evaluate<{ submitted: string[]; starts: number[]; hasReceipt: boolean; rawVisible: boolean; shown: string }>(`(() => {
      const fold = document.querySelector('.tool-details[data-tool-kind="${kind}"]');
      const args = fold.querySelector('.tool-raw-args');
      return { submitted: [...fold.querySelectorAll('.tool-todo-list li')].map(item => item.innerText),
        starts: [...fold.querySelectorAll('.tool-todo-list ol')].map(list => list.start),
        hasReceipt: fold.innerText.includes("原生"),
        rawVisible: !!args?.querySelector('pre').getClientRects().length,
        shown: fold.innerText };
    })()`);
    for (const kind of ["todo", "memory"] as const) {
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="${kind}"] > summary').focus()`);
      await browser.press("Enter");
      const opened = await read(kind);
      expect(opened).toMatchObject({
        submitted: kind === "todo" ? ["核对渲染", "保留草稿", "记录检查结论"] : [],
        starts: kind === "todo" ? [1, 3] : [], hasReceipt: false, rawVisible: false,
      });
      expect(opened.shown).not.toMatch(/private-|\"items\"/);
      await browser.press("Tab");
      expect(await browser.evaluate(`document.activeElement.matches('.tool-${kind}-receipt > summary') &&
        document.activeElement.innerText.includes('原始回执')`)).toBe(true);
      await browser.press("Enter");
      const receipt = await read(kind);
      expect(receipt).toMatchObject({ hasReceipt: true, rawVisible: false });
      expect(receipt.shown).toContain(kind === "todo" ? "原生待办回执" : "原生记忆回执");
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="${kind}"] .tool-raw-args > summary').focus()`);
      await browser.press("Enter");
      expect(await read(kind)).toMatchObject({ rawVisible: true });
    }
  });
});

browserTest("Featured cards show Todo changes and Agent prompt previews without opening source data", async () => {
  const changes = ["检查发布路由", "ghp_PrivateTodoTitle", "核对导航状态", "确认移动端主题", "验证键盘操作", "记录发布结论"];
  const prompt = `核对发布路由和主题。\n${"长说明".repeat(90)}\n<em>逐字保留这行</em>`;
  const tasks = [{ category: "quick", prompt },
    { subagent_type: "delivery-worker", prompt: "在手机宽度下复查导航和键盘焦点。" }];
  for (const width of evidence ? [1440, 390, 320] : [390]) {
    await withWorkbench(width, [
      { role: "user", content: "准备发布预览，列出本次验收待办，并派发独立检查。" },
      assistant(text("先列待办，再把两项检查分别派发。"),
        call("plan", "todo", { op: "append", phase: "发布验收", items: changes }),
        call("dispatch", "task", { tasks, run_in_background: true }),
        call("inspect", "read", { path: "src/web/app.ts" })),
      result("plan", "todo", false, "private-todo-receipt"),
      result("dispatch", "task", false, "private-dispatch-receipt"),
      result("inspect", "read", false, "private-file-output"),
      { role: "assistant", content: [text("验收任务已派发。合并检查结论前，先保留发布预览。")] },
    ], async (browser, emit) => {
      const read = (kind: string) => browser.evaluate<string>(
        `document.querySelector('.tool-details[data-tool-kind="${kind}"]').parentElement.innerText`);
      const todo = await read("todo");
      expect(todo).toContain("检查发布路由");
      expect(todo).toContain("核对导航状态");
      expect(todo).toContain("确认移动端主题");
      expect(todo).toContain("验证键盘操作");
      expect(todo).not.toMatch(/记录发布结论|PrivateTodoTitle|private-todo-receipt|发布验收/);
      expect(todo).toContain("其余 2 项");
      const agent = await read("agent");
      expect(agent).toMatch(/提交 2 项任务[\s\S]*类别 quick[\s\S]*角色 delivery-worker/);
      expect(agent).toContain("核对发布路由和主题。");
      expect(agent).toContain(tasks[1]?.prompt ?? "");
      expect(agent).not.toMatch(/逐字保留这行|private-dispatch-receipt/);
      expect(await read("inspect")).not.toContain("private-file-output");

      if (evidence) {
        if (await browser.evaluate(`!!document.querySelector("#details-dialog[open]")`)) {
          await browser.click("#details-dialog [data-close]");
        }
        for (const theme of ["light", "dark"]) {
          await browser.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
          for (const kind of ["todo", "agent"]) {
            expect(await browser.evaluate(`(async () => {
              const card = document.querySelector('.tool-details[data-tool-kind="${kind}"]').parentElement;
              const transcript = document.querySelector("#transcript");
              const viewport = transcript.getBoundingClientRect();
              transcript.scrollTop += card.getBoundingClientRect().top - viewport.top - 16;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const box = card.getBoundingClientRect();
              const headerHeight = card.querySelector(".tool-summary").getBoundingClientRect().height;
              const emblem = card.querySelector(".tool-card-emblem");
              return { overflow: [card.scrollWidth - card.clientWidth, transcript.scrollWidth - transcript.clientWidth],
                fits: box.top >= viewport.top && box.bottom <= viewport.bottom,
                reachable: headerHeight >= (${width} <= 760 ? 44 : 24),
                decorative: emblem.getAttribute("aria-hidden") === "true" && getComputedStyle(emblem).pointerEvents === "none" };
            })()`)).toEqual({ overflow: [0, 0], fits: true, reachable: true, decorative: true });
            await capture(browser, `featured-${width}-${theme}-${kind}`);
          }
        }
      }

      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="agent"] > summary').focus()`);
      await browser.press("Enter");
      const opened = await browser.evaluate(`(() => {
        const scene = document.querySelector(".tool-agent");
        return { prompts: [...scene.querySelectorAll("pre.tool-agent-prompt")].map(node => node.textContent),
          markup: !!scene.querySelector("em"), rawOpen: scene.parentElement.querySelector(".tool-raw-args").open };
      })()`);
      expect(opened).toEqual({ prompts: tasks.map(task => task.prompt), markup: false, rawOpen: false });
      if (evidence) await capture(browser, `featured-${width}-agent-prompts`);
      await browser.press("Enter");

      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="todo"] > summary').focus()`);
      await browser.press("Enter");
      expect(await read("todo")).toContain("记录发布结论");
      expect(await read("todo")).not.toContain("private-todo-receipt");
      await browser.press("Tab");
      await browser.press("Enter");
      expect(await read("todo")).toContain("private-todo-receipt");
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="todo"] .tool-raw-args > summary').focus()`);
      await browser.press("Enter");
      expect(await read("todo")).toContain('"op": "append"');
      await capture(browser, `featured-${width}-todo-source`);

      const live = { toolCallId: "finish", toolName: "todo", args: { op: "done", task: "核对发布清单" } };
      emit({ type: "tool_execution_start", ...live });
      await waitFor(browser, `!!document.querySelector('.tool-details[data-tool-kind="todo"][data-state="running"]')`);
      const selector = '.tool-details[data-tool-kind="todo"][data-state="running"]';
      const running = await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).parentElement.innerText`);
      expect(running).toMatch(/请求完成[\s\S]*运行中[\s\S]*核对发布清单/);
      await browser.evaluate(`document.querySelector(${JSON.stringify(selector + " > summary")}).focus()`);
      await browser.press("Enter");
      await browser.press("Tab");
      await browser.press("Enter");
      emit({ type: "tool_execution_end", ...live, isError: true, result: { content: [text("原生拒绝：未更新清单")] } });
      await waitFor(browser, `document.querySelector('.tool-details[data-tool-kind="todo"][data-state="error"]')?.innerText.includes("未更新清单")`);
      expect(await browser.evaluate(`document.activeElement.matches(".tool-todo-receipt[open] > summary")`)).toBe(true);
      await browser.press("Enter");
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="todo"][data-state="error"] > summary').focus()`);
      await browser.press("Enter");
      const failed = await browser.evaluate(`document.activeElement.parentElement.parentElement.innerText`);
      expect(failed).toMatch(/请求完成[\s\S]*失败[\s\S]*核对发布清单/);
      expect(failed).not.toContain("未更新清单");
      if (evidence) {
        await browser.cdp("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
        expect(await browser.evaluate(`(() => {
          const header = document.activeElement;
          return [getComputedStyle(header).outlineStyle, getComputedStyle(header.closest("article")
            .querySelector(".tool-card-emblem")).display];
        })()`)).toEqual(["solid", "none"]);
        await capture(browser, `featured-${width}-forced-failure`);
      }
    });
  }
}, 20000);

browserTest("Specialized tools show safe facts, but grouped tools stay compact", async () => {
  const specimens = [
    ["terminal", "bash", { command: "private-command\nprivate-command-two\n" }, /命令\s*2 行.*可见输出\s*3 行文本/s],
    ["execution", "eval", { language: "js", code: "private-code\nprivate-code-two" }, /语言\s*JavaScript.*源码\s*2 行/s],
    ["context", "ctx_batch", { commands: ["private-query"], queries: ["private-first", "private-second"] }, /命令\s*1 条.*查询\s*2 条/s],
    ["modify", "edit", { path: "src/workbench.ts", oldText: "private-before", newText: "private-after\nprivate-next" },
      /替换前\s*1 行.*替换后\s*2 行/s],
    ["memory", "memory", { command: "update_description", file_path: "private-path.md", description: "private-memory" }, /变更对象\s*描述/],
    ["web", "webfetch", { url: "https://example.org/private-url?q=private-query" }, /主机\s*example\.org/],
    ["agent", "task", { category: "quick", prompt: "核对交付说明", run_in_background: true }, /类别 quick.*后台.*核对交付说明/s],
  ] as const;
  const grouped = [call("group-a", "read", { path: "src/one.ts" }),
    call("group-b", "eval", { language: "py", code: "private-group-code" }),
    call("group-c", "webfetch", { url: "https://example.net/private-group-url" })];
  for (const width of evidence ? [1440, 390, 320] : [390]) {
    await withWorkbench(width, [
      { role: "user", content: "检查发布预览中的工具调用和可见证据。" },
      assistant(...specimens.flatMap(([, name, args], i) => [text("接着核对下一项。"), call(`card-${i}`, name, args)]),
        text("顺带验证分组探查。"), ...grouped, text("再打开一条独立的读取记录。"),
        call("single-read", "read", { path: "docs/usage.md" }), text("保留未知插件的原始证据。"),
        call("extension", "mcp_fixture:custom", { query: "private-extension" })),
      ...specimens.map(([, name], i) => result(`card-${i}`, name, false, "private-output-1\nprivate-output-2\nprivate-output-3")),
      ...grouped.map(row => result(String(row.id), String(row.name), false, "private-group-output")),
      result("single-read", "read", false, "private-file-output"),
      result("extension", "mcp_fixture:custom", false, "private-extension-output"),
      { role: "assistant", content: [text("检查结束，可以打开各条回执核对细节。")] },
    ], async browser => {
      const rows = await browser.evaluate<string[]>(`[...document.querySelectorAll("#messages .tool-details:not(.tool-group *)")]
        .map(entry => entry.parentElement.innerText)`);
      expect(rows.slice(0, specimens.length)).toEqual(specimens.map(([, , , summary]) => expect.stringMatching(summary)));
      expect(rows.join(" ")).not.toMatch(/private-/);
      expect(await browser.evaluate(`(() => {
        const group = document.querySelector(".tool-group");
        group.open = true;
        return [...group.querySelectorAll(".tool-details")].map(row =>
          [row.dataset.toolKind, !!row.parentElement.querySelector(".tool-card-content")?.getClientRects().length]);
      })()`)).toEqual([["inspect", false], ["execution", false], ["web", false]]);
      const compact = await browser.evaluate(`["inspect", "unknown"].map(kind => {
        const row = document.querySelector('.tool-details:not(.tool-group *)[data-tool-kind="' + kind + '"]');
        return { text: row.parentElement.innerText, card: !!row.parentElement.querySelector(".tool-card-content")?.getClientRects().length };
      })`);
      expect(compact).toEqual([
        { text: expect.stringContaining("docs/usage.md"), card: false },
        { text: expect.stringContaining("mcp_fixture:custom"), card: false },
      ]);
      if (evidence) {
        if (await browser.evaluate(`!!document.querySelector("#details-dialog[open]")`)) await browser.click("#details-dialog [data-close]");
        for (const theme of ["light", "dark"]) {
          await browser.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
          for (const selector of [...specimens.map(([kind]) => `.tool-details:not(.tool-group *)[data-tool-kind="${kind}"]`),
            '.tool-details:not(.tool-group *)[data-tool-kind="inspect"]', ".tool-group"]) {
            const captureName = await browser.evaluate(`(async () => {
              const entry = document.querySelector(${JSON.stringify(selector)});
              const card = entry.matches(".tool-group") ? entry : entry.parentElement;
              const viewport = document.querySelector("#transcript");
              const bounds = viewport.getBoundingClientRect();
              viewport.scrollTop += card.getBoundingClientRect().top - bounds.top - 16;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const frame = card.getBoundingClientRect();
              if (card.scrollWidth > card.clientWidth || viewport.scrollWidth > viewport.clientWidth ||
                frame.top < bounds.top || frame.bottom > bounds.bottom) throw Error("Card does not fit its viewport");
              return entry.dataset.toolKind ?? "group";
            })()`);
            await capture(browser, `all-cards-${width}-${theme}-${captureName}`);
          }
        }
      }
    });
  }
}, 30000);

browserTest("Todo recap projects one recognizable title, never a private payload or inferred progress", async () => {
  const privateTitles = [
    "ghp_ExampleCredential", "API token CedarValue", "/home/demo/notes.md",
    "cat secrets", "printf hidden", "echo attic", "aVeryLongUngroupedOpaqueCredential123", "l".repeat(72),
  ];
  const invalidTitles = ["路径\u202e伪装", "核对\n隐私", 42];
  const batches: readonly (readonly [Wire, RegExp])[] = [
    [{ op: "init", list: [{ phase: "未公开阶段", items: ["核对主题配色", "记录验收结果"] }, { phase: "交付", items: ["整理截图"] }] },
      /初始化.*3 项.*核对主题配色.*另 2 项/s],
    [{ op: "append", items: ["Audit mobile spacing", "记录宽屏结果"] }, /追加.*2 项.*Audit mobile spacing.*另 1 项/s],
    [{ op: "init", items: privateTitles }, /^Todo\s*初始化 · 8 项\s*未见结果$/u],
    [{ op: "init", items: [] }, /^Todo\s*初始化 · 0 项\s*未见结果$/u],
    ...privateTitles.map(item => [{ op: "append", items: [item] }, /^Todo\s*追加 · 1 项\s*未见结果$/u] as const),
    ...invalidTitles.map(item => [{ op: "append", items: [item] }, /^Todo\s*追加\s*未见结果$/u] as const),
  ];
  const requests: readonly (readonly [Wire, RegExp])[] = [
    [{ op: "start", task: "核对测试结果" }, /^Todo\s*请求开始\s*核对测试结果\s*成功$/u],
    [{ op: "done", task: "整理交付清单" }, /^Todo\s*请求完成\s*整理交付清单\s*成功$/u],
    [{ op: "drop", task: "Review temporary drafts" }, /^Todo\s*请求放弃\s*Review temporary drafts\s*成功$/u],
    [{ op: "rm", task: "核对旧版说明" }, /^Todo\s*请求移除\s*核对旧版说明\s*成功$/u],
    [{ op: "start", phase: "切换阶段" }, /^Todo\s*请求开始\s*成功$/u],
    [{ op: "done", task: privateTitles[0] }, /^Todo\s*请求完成\s*成功$/u],
    [{ op: "drop", task: "\nAudit mobile spacing" }, /^Todo\s*请求放弃\s*成功$/u],
    [{ op: "rm", task: { title: "查看所有档案" } }, /^Todo\s*请求移除\s*成功$/u],
    [{ op: "start", task: "记录项目改动", phase: "切换阶段" }, /^Todo\s*请求开始\s*成功$/u],
  ];
  const cases = [...batches, ...requests];
  await withWorkbench(390, [
    { role: "user", content: "检查待办投影。" },
    assistant(...cases.map(([args], index) => call(`todo-${index}`, "todo", args))),
    ...requests.map((_, index) => result(`todo-${batches.length + index}`, "todo", false, "回执中的文字不代表进度")),
  ], async browser => {
    const summaries = await browser.evaluate<string[]>(`Array.from(document.querySelectorAll(".tool-summary"), row => row.innerText)`);
    expect(summaries).toEqual(cases.map(([, recap]) => expect.stringMatching(recap)));
    expect(summaries.join(" ")).not.toMatch(/未公开阶段|记录验收结果|整理截图|记录宽屏结果|切换阶段|回执中的文字/);
    const requested = await browser.evaluate<{ text: string; items: number; caption: string }[]>(`Array.from(document.querySelectorAll(".tool-details")).slice(${batches.length}).map(row => {
      row.open = true;
      return { text: row.querySelector(".fold-body").innerText, items: row.querySelectorAll(".tool-todo-board li, input[type=checkbox]").length,
        caption: row.parentElement.querySelector(".tool-card-heading")?.textContent ?? "" };
    })`);
    expect(requested.map(({ items, caption }) => [items, caption])).toEqual(
      requests.map((_, index) => [0, index < 4 ? "待办变更" : ""]));
    expect(requested.map(({ text }) => text).join(" ")).not.toMatch(/非当前进度|这是请求的变更|回执中的文字/);
  });
});

browserTest("English tool copy at 320px keeps a pending Todo request and native evidence distinct", async () => {
  await withWorkbench(320, [
    { role: "user", content: "验证待办与输出" },
    assistant(call("read-a", "read", { path: "docs/说明.md" }), call("read-b", "read", { path: "docs/计划.md" })),
    result("read-a", "read", false, "原生回执"),
    result("read-b", "read", false, "第二份原生回执"),
  ], async (browser, emit) => {
    emit({ type: "tool_execution_start", toolCallId: "pending-add", toolName: "todo", args: { op: "append", items: ["检查版面", "保留回执"] } });
    await waitFor(browser, `!!document.querySelector('[data-tool-kind=todo][data-state=running]')`);
    const shown = await browser.evaluate(`(() => {
      const group = document.querySelector(".tool-group");
      const groupText = group.querySelector(".tool-group-count").textContent;
      group.open = true;
      const read = group.querySelector(".tool-details");
      read.open = true;
      const output = read.querySelector(".tool-output");
      const todo = document.querySelector("[data-tool-kind=todo]");
      todo.open = true;
      const transcript = document.querySelector("#transcript");
      return {
        speaker: document.querySelector(".message--user .speaker").textContent,
        groupText, output: [output.getAttribute("aria-label"), output.textContent],
        state: todo.querySelector(".tool-state-text").textContent,
        caption: todo.parentElement.querySelector(".tool-card-heading").textContent,
        items: [...todo.querySelectorAll(".tool-todo-board li")].map(item => item.textContent),
        overflow: [document.documentElement.scrollWidth, transcript.scrollWidth - transcript.clientWidth],
      };
    })()`);
    expect(shown).toEqual({
      speaker: "You", groupText: "File and tool lookups · 2 succeeded", output: ["Inspection results", "原生回执"],
      state: "Running", caption: "Add tasks", items: ["检查版面", "保留回执"], overflow: [320, 0],
    });
  }, "en");
});

browserTest("Batch recaps only show validated counts and Agent routes, independently of the receipt", async () => {
  const commands = ["printf private-command-one", "printf private-command-two"];
  const queries = ["private-query-one", "private-query-two", "private-query-three"];
  const task = { prompt: "private-task-prompt", name: "private-task-name", task_summary: "private-task-caption" };
  const tasks = [{ ...task, category: "quick" }, { ...task, subagent_type: "delivery-worker" }];
  const cases: readonly (readonly [string, Wire, string, string, (readonly string[])?])[] = [
    ["ctx_batch", { commands, queries }, "批量查询", "提交 2 条命令 · 3 条查询"],
    ["ctx_batch", { commands, queries: [{ query: "private-query-object" }] }, "批量查询", ""],
    ["ctx_batch", { commands: [], queries }, "批量查询", ""],
    ["ctx_batch", { commands: Array(25).fill(commands[0]), queries }, "批量查询", ""],
    ["ctx_batch", { input: { commands, queries } }, "批量查询", ""],
    ["task", { tasks, run_in_background: true }, "派发任务", "提交 2 项任务", ["类别 quick", "角色 delivery-worker"]],
    ["task", { tasks: [task], category: "quick" }, "派发任务", "提交 1 项任务", ["类别 quick"]],
    ["task", { tasks, prompt: "private-mixed-prompt", category: "quick" }, "派发任务", ""],
    ["task", { tasks: [{ category: "quick" }] }, "派发任务", ""],
    ["task", { tasks: [{ ...task, category: "quick", subagent_type: "delivery-worker" }] }, "派发任务", ""],
    ["task", { tasks: Array(25).fill(tasks[0]) }, "派发任务", ""],
    ["task", { input: { tasks } }, "派发任务", ""],
  ];
  await withWorkbench(1440, [
    { role: "user", content: "查看提交批次和实际工具回执。" },
    assistant(...cases.flatMap(([name, args], index) => [call(`batch-${index}`, name, args), text("下一条记录。")])),
    ...cases.map(([name], index) => result(`batch-${index}`, name, false, `批次回执 ${index}：未报告子项状态`)),
  ], async browser => {
    const shown = await browser.evaluate<{ inputs: string[][]; details: string[]; routes: readonly (readonly string[])[]; prompts: string[][]; receipts: string[] }>(`(() => {
      const rows = [...document.querySelectorAll(".tool-details")];
      const inputs = rows.map(row => [row.querySelector(".tool-operation").innerText, row.querySelector(".tool-preview").textContent]);
      rows.forEach(row => row.open = true);
      return { inputs, details: rows.map(row => row.innerText),
        routes: rows.map(row => [...row.querySelectorAll(".tool-agent li")].map(route => route.innerText)),
        prompts: rows.map(row => [...row.querySelectorAll(".tool-agent-prompt")].map(prompt => prompt.textContent)),
        receipts: rows.map(row => row.querySelector(".tool-output").innerText) };
    })()`);
    expect(shown.inputs).toEqual(cases.map(([, , operation, preview]) => [operation, preview]));
    expect(shown.details.join(" ")).not.toMatch(/private-(?!task-prompt)|后台/);
    expect(shown.prompts).toEqual(cases.map(([, , , , routes]) => routes?.map(() => task.prompt) ?? []));
    expect(shown.routes).toEqual(cases.map(([, , , , routes]) => routes ?? []));
    expect(shown.details.filter((_, index) => !cases[index]?.[4]).join(" ")).not.toMatch(/quick|delivery-worker/);
    expect(shown.receipts).toEqual(cases.map((_, index) => `批次回执 ${index}：未报告子项状态`));
  });
});

browserTest("Opaque or markup-shaped plugin names do not replace the generic evidence label", async () => {
  const names = ["mcp_addon:inspect", "mcp_addon:ghp_ExampleCredential", "<img src=x onerror=alert(1)>"];
  await withWorkbench(390, [
    { role: "user", content: "检查扩展证据。" },
    assistant(...names.map((name, index) => call(`plugin-${index}`, name, { value: `plugin evidence ${index}` }))),
    ...names.map((name, index) => result(`plugin-${index}`, name, false, `plugin output ${index}`)),
  ], async browser => {
    const recaps = await browser.evaluate(`Array.from(document.querySelectorAll(".tool-summary"), row => row.innerText)`);
    expect(recaps).toEqual([
      expect.stringMatching(/mcp_addon:inspect.*成功/s),
      expect.stringMatching(/工具调用.*成功/s),
      expect.stringMatching(/工具调用.*成功/s),
    ]);
    const opened = await browser.evaluate<{ text: string; injected: boolean; customScene: boolean }[]>(`Array.from(document.querySelectorAll(".tool-details"), row => {
      row.open = true;
      return { text: row.innerText, injected: !!row.querySelector("img, a"), customScene: !!row.querySelector(".tool-scene") };
    })`);
    expect(opened).toEqual(names.map((_, index) => ({
      text: expect.stringMatching(new RegExp("plugin evidence " + index + ".*plugin output " + index, "s")),
      injected: false, customScene: false,
    })));
    expect(opened.map(row => row.text).join(" ")).not.toMatch(/ExampleCredential|<img/);
  });
});

browserTest("Web read exposes a validated hostname as text and keeps URLs and queries in evidence", async () => {
  const addresses = [
    "HTTPS://Docs.Example.org:8443/private-address?token=hidden#private-fragment",
    "https://owner:password@private-credentials.example/",
    "https://@private-empty-user.example/",
    "file://private-local.example/read",
    "//private-relative.example/path",
    "https:private-repaired.example/path",
    "https://private-ambiguous.example\\route",
    "https://private-control.example/\nfragment",
  ];
  await withWorkbench(1440, [
    { role: "user", content: "核对网页证据。" },
    assistant(...addresses.map((url, index) => call(`web-${index}`, "webfetch", { url })),
      call("search-web", "web_search", { query: "private-search-query" })),
    result("web-0", "webfetch", false, "网页读取原文"),
    result("search-web", "web_search", false, "网页查询原文"),
  ], async browser => {
    const recap = await browser.evaluate(`Array.from(document.querySelectorAll(".tool-summary"), row => row.innerText)`);
    expect(recap).toEqual([
      expect.stringMatching(/读取网页.*docs\.example\.org.*成功/s),
      ...addresses.slice(1).map(() => expect.stringMatching(/^Web\s*读取网页\s*未见结果$/u)),
      expect.stringMatching(/^Web\s*网页搜索\s*成功$/u),
    ]);
    const before = await browser.evaluate(`location.href`);
    await browser.evaluate(`document.querySelector(".tool-summary").focus()`);
    await browser.press("Enter");
    const opened = await browser.evaluate(`(() => {
      const card = document.querySelector(".tool-details[open]");
      return { link: !!card.querySelector("a"), scene: card.querySelector(".tool-web")?.innerText,
        rawVisible: !!card.querySelector(".tool-raw-args pre")?.getClientRects().length, address: location.href };
    })()`);
    expect(opened).toEqual({ link: false, scene: expect.stringContaining("网页读取原文"), rawVisible: false, address: before });
    await browser.evaluate(`document.querySelector(".tool-details[open] .tool-raw-args > summary").focus()`);
    await browser.press("Enter");
    expect(await browser.evaluate(`JSON.parse(document.querySelector(".tool-raw-args[open] pre").innerText).url`)).toBe(addresses[0]);
  });
});

browserTest("Unproven results and approval, user, or native Bash records split execution runs", async () => {
  const exec = (id: string) => call(id, "ctx_execute", {});
  const done = (id: string) => result(id, "ctx_execute", false, id);
  await withWorkbench(1440, [
    { role: "user", content: "检查分组边界" },
    assistant(exec("a"), exec("b"), exec("fail"), exec("c"), exec("clip"), exec("d"), exec("no-status"), exec("e"),
      exec("no-content"), exec("f"), call("unknown", "plugin", {}), exec("g"), exec("pending"), exec("h")),
    done("a"), done("b"), result("fail", "ctx_execute", true, "failure"), done("c"), { ...done("clip"), truncated: true },
    done("d"), result("no-status", "ctx_execute", undefined, "unknown"), done("e"), { ...done("no-content"), content: undefined },
    done("f"), result("unknown", "plugin", false, "plugin"), done("g"), done("h"),
    { role: "custom", content: [text("审批边界")] },
    { ...assistant(exec("i")), id: "after-approval" }, done("i"),
    { role: "bashExecution", output: "原生命令输出" },
    { ...assistant(exec("j")), id: "after-bash" }, done("j"),
    { role: "user", content: "新回合" },
    { ...assistant(exec("k")), id: "new-turn" }, done("k"),
  ], async browser => {
    const layout = await browser.evaluate(`({
      groups: Array.from(document.querySelectorAll(".tool-group-body"), body =>
        Array.from(body.querySelectorAll(".tool-output"), output => output.textContent)),
      rows: Array.from(document.querySelectorAll(".tool-details:not(.tool-group *)"), row =>
        [row.querySelector(".tool-output").textContent, row.querySelector(".tool-state-text").textContent]),
    })`);
    expect(layout).toEqual({ groups: [["a", "b"]], rows: [
      ["failure", "失败"], ["c", "成功"], ["clip", "结果不完整"], ["d", "成功"], ["unknown", "状态未知"],
      ["e", "成功"], ["", "结果不完整"], ["f", "成功"], ["plugin", "成功"], ["g", "成功"], ["", "未见结果"],
      ["h", "成功"], ["i", "成功"], ["j", "成功"], ["k", "成功"],
    ] });
  });
});

browserTest("Tool scenes render the connected wire as distinct workspaces without revealing folded data", async () => {
  const fixtures = [
    ["bash", { command: "printf first\nprintf second" }],
    ["powershell", { command: "Write-Output fixture-shell" }],
    ["todo", { op: "init", list: [{ phase: "验收", items: ["核对主题", "核对输出"] }, { phase: "交付", items: ["记录截图"] }] }],
    ["memory", { command: "str_replace", file_path: "/fixture/private-memory.md", new_string: "private-memory-source" }],
    ["eval", { language: "js", summary: "private-eval-summary", code: "print('private-eval-source')" }],
    ["ctx_execute", { language: "python", code: "print('private-ctx-source')", file: "/fixture/private-context.txt" }],
    ["write", { path: "src/界面/工具.ts", content: "private-file-source" }],
    ["task", { category: "quick", run_in_background: true, task_summary: "private-agent-summary", prompt: "private-agent-prompt" }],
    ["mcp_fixture:plugin", { args: "generic-call-args" }],
  ] as const;
  for (const width of evidence ? [1440, 390, 320] : [390]) {
    await withWorkbench(width, [
      { role: "user", content: "请检查工具界面与回执。" },
      assistant(...fixtures.map(([name, args], i) => call(String(i), name, args))),
      ...fixtures.map(([name], i) => ({ ...result(String(i), name, false, `${i} · ${i === 3 ? "private-memory-output" : "原生工具输出"}`),
        details: { internal: "private-opaque-details" } })),
    ], async browser => {
      if (width === 390) {
        const shown = await browser.evaluate(`(() => {
          const rows = [...document.querySelectorAll(".tool-details")];
          const summaries = rows.map(row => row.querySelector("summary").innerText);
          document.querySelectorAll(".tool-group").forEach(group => group.open = true);
          rows.forEach(row => row.open = true);
          const [bash, ps, todo, memory, evaluate, ctx, file, agent, plugin] = rows;
          const visible = (row, token) => row.innerText.includes(token);
          const attached = (row, selector) => !!row.querySelector(selector)?.getClientRects().length;
          return {
            summaries: summaries.join(" "),
            commands: [bash, ps].map(row => row.querySelector(".tool-command-preview code")?.textContent),
            terminalOutput: [bash, ps].map(row => attached(row, ".tool-terminal .tool-output")),
            phases: [...todo.querySelectorAll(".tool-todo-board ol")].map(lane => [...lane.children].map(item => item.innerText)),
            todoReceipt: !visible(todo, "2 · 原生工具输出") && attached(todo, ".tool-todo-receipt > summary"),
            memoryAudit: attached(memory, ".tool-memory-audit") && attached(memory, ".tool-memory-receipt > summary"),
            memoryHidden: !visible(memory, "private-memory") && !attached(memory, ".tool-output"),
            execution: [evaluate, ctx].map(row => row.querySelector(".tool-summary").innerText),
            codeHidden: [evaluate, ctx].every(row => !visible(row, "-source") && !attached(row, ".tool-source pre")),
            file: [file.querySelector(".tool-target")?.innerText, file.querySelector(".tool-result > p")?.innerText],
            agent: agent.querySelector(".tool-summary")?.innerText,
            agentOutput: visible(agent, "7 · 原生工具输出"),
            repeatedLabels: [bash, ps, todo, memory, evaluate, ctx, file, agent].some(row => {
              const scene = row.querySelector(".tool-scene");
              return [".tool-label", ".tool-operation", ".tool-target", ".tool-preview"].some(selector => {
                const title = row.querySelector(".tool-summary " + selector)?.textContent;
                return title && scene.innerText.includes(title);
              });
            }),
            extraHidden: ![evaluate, ctx, file, plugin].some(row => /private-/.test(row.innerText)) &&
              !visible(agent, "private-agent-summary"),
            agentPrompt: agent.querySelector(".tool-agent-prompt")?.innerText,
            generic: !plugin.querySelector(".tool-scene") && visible(plugin, "generic-call-args") && visible(plugin, "8 · 原生工具输出"),
          };
        })()`);
        expect(shown).toMatchObject({
          summaries: expect.not.stringMatching(/private-|printf|Write-Output|核对输出|记录截图|原生工具输出/),
          commands: ["printf first\nprintf second", "Write-Output fixture-shell"],
          terminalOutput: [true, true], phases: [["核对主题", "核对输出"], ["记录截图"]],
          todoReceipt: true, memoryAudit: true, memoryHidden: true,
          execution: [expect.stringContaining("JavaScript"), expect.stringContaining("Python")], codeHidden: true,
          file: ["src/界面/工具.ts", "文件变更回执"], agent: expect.stringMatching(/quick.*后台/s), agentOutput: true,
          repeatedLabels: false, extraHidden: true, generic: true, agentPrompt: "private-agent-prompt",
        });
        for (const [selector, token] of [
          ['[data-tool-kind="memory"] .tool-memory-receipt > summary', "private-memory-output"],
          ['[data-tool-kind="execution"] .tool-source > summary', "private-eval-source"],
          ['[data-tool-kind="context"] .tool-source > summary', "private-ctx-source"],
          ['[data-tool-kind="agent"] .tool-raw-args > summary', "private-agent-prompt"],
        ]) {
          await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
          await browser.press("Enter");
          expect(await browser.evaluate(`document.activeElement.parentElement.innerText.includes(${JSON.stringify(token)})`)).toBe(true);
          await browser.press("Enter");
        }
      }
      if (evidence) for (const theme of ["light", "dark"]) {
        await browser.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
        for (const [i, [name]] of fixtures.entries()) {
          const sizing = await browser.evaluate(`(() => {
            const rows = [...document.querySelectorAll(".tool-details")];
            document.querySelectorAll(".tool-group").forEach(group => group.open = group.contains(rows[${i}]));
            rows.forEach((row, index) => row.open = index === ${i});
            rows[${i}].querySelectorAll(".tool-source").forEach(source => source.open = false);
            rows[${i}].scrollIntoView({ block: "center" });
            const transcript = document.querySelector("#transcript");
            return [document.documentElement.scrollWidth, transcript.scrollWidth - transcript.clientWidth];
          })()`);
          expect(sizing).toEqual([width, 0]);
          await capture(browser, `scene-${width}-${theme}-${name.replace(":", "-")}`);
          if (i === 4 || i === 5) {
            await browser.evaluate(`document.querySelector(".tool-details[open] .tool-source > summary").focus()`);
            await browser.press("Enter");
            await capture(browser, `scene-${width}-${theme}-${name}-source`);
          }
        }
      }
    });
  }
}, 20000);

browserTest("Malformed metadata and oversized Todo submissions still leave raw detail reachable", async () => {
  await withWorkbench(390, [
    { role: "user", content: "检查投影边界。" },
    assistant(call("unsafe-file", "read", { path: "../../ghp_private-path" }),
      call("unsafe-agent", "task", { category: "private category with spaces", prompt: "private-task-source" }),
      call("unsafe-eval", "eval", { action: "private-action", language: "private-lang", code: "private-script" }),
      call("large-todo", "todo", { op: "init", items: ["过长".repeat(400)] })),
  ], async browser => {
    const found = await browser.evaluate(`(() => {
      const [file, agent, execution, todo] = [...document.querySelectorAll(".tool-details")];
      const rows = [file, agent, execution, todo];
      rows.forEach(row => row.open = true);
      return {
        untrusted: rows.map(row => /private-|过长/.test(row.innerText)),
        boardItems: todo.querySelectorAll(".tool-todo-board li").length,
        raw: rows.map(row => !!row.querySelector(".tool-raw-args > summary")?.getClientRects().length),
      };
    })()`);
    expect(found).toEqual({ untrusted: [false, false, false, false], boardItems: 0, raw: [true, true, true, true] });
  });
});

browserTest("Streaming terminal retains its viewport and finite signals respect reduced motion and forced colors", async () => {
  const output = Array.from({ length: 48 }, (_, i) => `${i} ${"stream-text ".repeat(55)}`).join("\n");
  await withWorkbench(390, [
    { role: "user", content: "检查流式输出和辅助显示模式。" },
    assistant(text("读取回执。")),
  ], async (browser, emit) => {
    const shell = { toolCallId: "live-terminal", toolName: "bash", args: { command: "printf fixture" } };
    emit({ type: "tool_execution_start", ...shell });
    await waitFor(browser, `!!document.querySelector(".tool-details[data-state=running]")`);
    const motion = () => browser.evaluate<string>(`getComputedStyle(document.querySelector(".tool-summary"), "::after").animationName`);
    const entry = await motion();
    expect(entry).not.toBe("none");
    await browser.evaluate(`document.querySelector(".tool-summary").focus()`);
    await browser.press("Enter");
    emit({ type: "tool_execution_update", ...shell, partialResult: { content: [text(output)] } });
    await waitFor(browser, `document.querySelector(".tool-output").textContent.includes("47 stream-text")`);
    await browser.evaluate(`(() => {
      const viewport = document.querySelector(".tool-output");
      viewport.focus();
      viewport.scrollTo(52, 96);
    })()`);
    emit({ type: "tool_execution_end", ...shell, result: { content: [text(`${output}\nfinal receipt`)] }, isError: true });
    await waitFor(browser, `document.querySelector(".tool-output").textContent.includes("final receipt")`);
    const settlement = await motion();
    expect(settlement).not.toBe(entry);
    expect(settlement).not.toBe("none");
    const retained = await browser.evaluate(`(() => {
      const viewport = document.querySelector(".tool-terminal .tool-output");
      return { focused: document.activeElement === viewport, scroll: [viewport?.scrollLeft, viewport?.scrollTop],
        state: viewport?.closest(".tool-details").dataset.state,
        iterations: getComputedStyle(document.querySelector(".tool-summary"), "::after").animationIterationCount };
    })()`);
    expect(retained).toEqual({ focused: true, scroll: [52, 96], state: "error", iterations: "1" });
    for (const feature of [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "forced-colors", value: "active" }]) {
      await browser.cdp("Emulation.setEmulatedMedia", { features: [feature] });
      expect(await motion()).toBe("none");
      expect(await browser.evaluate(`document.activeElement.matches(".tool-terminal .tool-output") &&
        document.activeElement.getClientRects().length > 0 &&
        getComputedStyle(document.activeElement).outlineStyle === "solid"`)).toBe(true);
      if (evidence) {
        await browser.evaluate(`document.querySelector(".tool-details").scrollIntoView({ block: "start" })`);
        await capture(browser, `scene-${feature.name}`);
      }
    }
    await browser.evaluate(`document.querySelector(".tool-summary").focus()`);
    await browser.press("Enter");
    const preview = await browser.evaluate(`document.querySelector(".tool-details").parentElement.innerText`);
    expect(preview).toContain("49 行文本");
    expect(preview).not.toContain("final receipt");
  });
});
