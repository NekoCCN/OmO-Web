import { expect, test } from "bun:test";
import { actions, browserEvent, dialog, state } from "../src/protocol.ts";

const question = {
  type: "extension_ui_request", method: "question", id: "native-1", requestId: "request-1",
  waitForAnswer: true, raisedBy: "agent", askedAtMs: 1000, deadlineAtMs: 11000, remainingMs: 10000, timeout: 10000,
  remoteOrigin: { deviceName: "PRIVATE_ORIGIN" }, answers: { private: "PRIVATE_RECEIPT" },
  questions: [
    { id: "one", header: "First", question: "Pick one", multiSelect: false, unknown: { text: "PRIVATE_NESTED" },
      options: [{ label: "A", description: "Choice A", internal: "PRIVATE_OPTION" }, { label: "B" }] },
    { id: "two", header: "Second", question: "Pick several", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
  ],
};

test("native questions project only safe rows and preserve mode and timing", () => {
  const projected = dialog(question);
  expect(projected).toEqual({
    type: "extension_ui_request", method: "question", id: "native-1", requestId: "request-1",
    waitForAnswer: true, raisedBy: "agent", askedAtMs: 1000, deadlineAtMs: 11000, remainingMs: 10000, timeout: 10000,
    questions: [
      { id: "one", header: "First", question: "Pick one", multiSelect: false,
        options: [{ label: "A", description: "Choice A" }, { label: "B" }] },
      { id: "two", header: "Second", question: "Pick several", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
    ],
  });
  expect(dialog({ ...question, private: true })).toBeUndefined();
  expect(dialog({ ...question, secret: true })).toBeUndefined();
  expect(dialog({ ...question, privateInput: { value: "secret" } })).toBeUndefined();
  const unsafe = dialog({ ...question, raisedBy: { name: "PRIVATE_OBJECT" },
    questions: [{ id: "hidden", secret: true, question: "PRIVATE_QUESTION", options: [] }] });
  expect(JSON.stringify(unsafe)).not.toContain("PRIVATE_");
  expect(browserEvent({ type: "question_resolved", id: "native-1", answers: { one: "PRIVATE_RECEIPT" } }))
    .toEqual({ type: "question_resolved", id: "native-1" });
  expect(browserEvent({ type: "question_updated", id: "native-1", deadlineAtMs: { private: "PRIVATE_TIME" }, remainingMs: 0 }))
    .toEqual({ type: "question_updated", id: "native-1", remainingMs: 0 });
});

test("native question projection drops fields outside its wire contract", () => {
  const projected = dialog({ ...question, placeholder: "PRIVATE_PLACEHOLDER", prefill: "PRIVATE_PREFILL",
    defaultValue: "PRIVATE_DEFAULT", title: "PRIVATE_TITLE", message: "PRIVATE_MESSAGE",
    parentToolCallId: "PRIVATE_PARENT", options: ["PRIVATE_OPTIONS"] });
  expect(projected).toEqual(dialog(question));
});

test("private question updates never expose timing or identity", () => {
  for (const marker of [{ private: true }, { secret: true }, { privateInput: { value: "PRIVATE" } }]) {
    expect(browserEvent({ type: "question_updated", id: "native-1", deadlineAtMs: 123, remainingMs: 0, ...marker }))
      .toBeUndefined();
    expect(browserEvent({ ...question, type: "question_updated", ...marker })).toBeUndefined();
  }
  expect(browserEvent({ type: "question_updated", id: "native-1", deadlineAtMs: 123, remainingMs: 0 }))
    .toEqual({ type: "question_updated", id: "native-1", deadlineAtMs: 123, remainingMs: 0 });
});

test("state safely preserves the native thinking level source", () => {
  expect(state({ thinkingLevel: "high", thinkingLevelSource: "session" }).thinkingLevelSource).toBe("session");
  expect(state({ thinkingLevelSource: { private: "PRIVATE_SOURCE" } }).thinkingLevelSource).toBeUndefined();
});

test("native standalone and additional comments use the existing answer contract", () => {
  expect(actions.safeParse({ action: "answer", requestId: "native-1", answers: {}, comment: "Only comment" }).success).toBe(true);
  expect(actions.safeParse({ action: "answer", requestId: "native-1",
    answers: { one: { selected: ["A"] } }, comment: "Extra" }).success).toBe(true);
});

const chrome = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome") ??
  (await Bun.file("/opt/google/chrome/chrome").exists() ? "/opt/google/chrome/chrome" : undefined);
const browserTest = test.skipIf(!chrome || typeof Bun.WebView !== "function");

browserTest("browser preserves drafts and identity on timing updates and submits native question answers", async () => {
  const bundle = await Bun.build({ entrypoints: ["src/web/interactions.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not build interaction fixture");
  using server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: {
    "/": () => new Response("<!doctype html><html><body><main id='root'></main></body></html>", { headers: { "Content-Type": "text/html" } }),
    "/interactions.js": () => new Response(script, { headers: { "Content-Type": "text/javascript" } }),
  } });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chrome, url: false }, width: 1000, height: 900 });
  await browser.navigate(server.url.href);
  const result = await browser.evaluate(`(async () => {
    const { Interactions } = await import("/interactions.js");
    const root = document.querySelector("#root");
    const interactions = new Interactions(root);
    const request = ${JSON.stringify(question)};
    const approval = { id: "approval", method: "confirm", toolCallId: "tool" };
    const sent = [];
    let failNext = false;
    const submit = async (id, answer) => {
      sent.push({ id, answer });
      if (failNext) { failNext = false; throw new Error("rejected"); }
    };
    const render = (q) => interactions.render(new Map([["approval", approval], ["native-1", q]]), true, submit);
    render(request);
    const form = interactions.firstQuestion;
    if (!form) return { missingQuestion: true };
    const selected = form.querySelector('input[value="A"]');
    const text = form.querySelector('input[type="text"]');
    const comment = form.querySelector("textarea");
    if (!selected || !text || !comment) return { missingControls: true };
    selected.click();
    text.value = "draft";
    comment.value = "note";
    text.focus();
    const before = form.textContent;
    render({ ...request, deadlineAtMs: 21000, remainingMs: 20000 });
    const unchanged = interactions.firstQuestion === form && document.activeElement === text && selected.checked && text.value === "draft" && comment.value === "note";
    const after = form.textContent;
    form.requestSubmit();
    await Promise.resolve();
    const retained = form.isConnected;
    form.reset();
    comment.value = "note";
    form.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
    form.reset();
    form.requestSubmit();
    const invalid = sent.length === 2 && !form.querySelector('[role="alert"]').hidden;
    const multi = [...form.querySelectorAll('input[type="checkbox"]')];
    multi.forEach(input => input.click());
    const textInputs = form.querySelectorAll('input[type="text"]');
    textInputs[1].value = "other";
    form.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
    form.reset();
    textInputs[1].value = "free text";
    failNext = true;
    form.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
    const failedDraft = form.isConnected && textInputs[1].value === "free text" && !form.querySelector('[role="alert"]').hidden;
    render({ ...request, waitForAnswer: false, deadlineAtMs: 21000, remainingMs: 20000 });
    const asyncMode = form.textContent.includes("异步");
    interactions.render(new Map([["approval", approval], ["native-1", request]]), false, submit);
    const offline = [...form.querySelectorAll("button")].every(button => button.disabled);
    render(request);
    root.querySelector('form[aria-label="工具批准"] button').click();
    await Promise.resolve();
    const first = interactions.first === root.querySelector('form[aria-label="工具批准"]');
    interactions.render(new Map([["approval", approval]]), true, submit);
    const settled = !form.isConnected && !interactions.firstQuestion;
    return { before, after, timingChanged: before !== after, unchanged, retained, sent, first, settled, invalid, asyncMode, offline, failedDraft,
      approval: root.querySelector('form[aria-label="工具批准"]')?.textContent };
  })()`);
  expect(result).toMatchObject({
    before: expect.stringContaining("Agent 提问"), timingChanged: true,
    unchanged: true, retained: true, first: true, settled: true, invalid: true, asyncMode: true, offline: true, failedDraft: true,
    sent: [
      { id: "native-1", answer: { answers: { one: { selected: ["A"], text: "draft" } }, comment: "note" } },
      { id: "native-1", answer: { answers: {}, comment: "note" } },
      { id: "native-1", answer: { answers: { two: { selected: ["C", "D"], text: "other" } } } },
      { id: "native-1", answer: { answers: { two: { selected: [], text: "free text" } } } },
      { id: "approval", answer: { confirmed: false } },
    ],
  });
});
