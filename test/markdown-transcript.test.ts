import { expect, test } from "bun:test";
import type { Transcript } from "../src/web/transcript.ts";

const candidates = [
  process.env.OMO_HANDOFF_CHROMIUM,
  process.env.BUN_CHROME_PATH,
  Bun.which("chromium"),
  Bun.which("google-chrome-stable"),
  Bun.which("google-chrome"),
];
const chromium = candidates.find((path): path is string => typeof path === "string" && path.length > 0);
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
type Evaluate = <T>(run: (ctor: typeof Transcript) => T) => Promise<Awaited<T>>;

async function withMarkdown(run: (evaluate: Evaluate, browser: Bun.WebView) => Promise<void>) {
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

browserTest("assistant GFM renders tables, strikethrough, task lists, footnotes, safe links and literal code without remote fetch", async () => {
  await withMarkdown(async evaluate => {
    const actual = await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      const section = document.getElementById("active-session");
      const welcome = document.getElementById("welcome");
      if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
      section.hidden = false;
      welcome.hidden = true;
      const first = [
        "| Name | Value |",
        "| ---- | :---: |",
        "| alpha | 1 |",
        "",
        "Strike ~~removed~~ and **kept**.",
        "",
        "- [x] done item",
        "- [ ] open item",
        "",
        "Footnote here[^1].",
        "",
        "[^1]: footnote body",
        "",
        "Link [docs][ref] and bare https://example.invalid/auto please.",
        "",
        "[ref]: https://example.invalid/docs",
        "",
        "```js",
        "const url = \"https://example.invalid/inside-code\";",
        "```",
        "",
        "![remote logo](https://remote.example.invalid/logo.png)",
        "[![Thumbnail](https://remote.example.invalid/thumb.png)](https://example.invalid/gallery)",
        "",
        "Mail <contact@example.invalid> any time.",
        "[unsafe](javascript:alert%281%29) and [not a receipt](/api/sessions/a/attachments/b).",
        "",
        "<script>window.__injected = true;</script>",
      ].join("\n");
      const second = "Second note[^1].\n\n[^1]: other body\n";
      const transcript = new Transcript(root, scroller, empty);
      transcript.render([
        { key: "a1", message: { role: "assistant", content: first } },
        { key: "a2", message: { role: "assistant", content: second } },
        { key: "u1", message: { role: "user", content: "| User | Table |\n| - | - |\n| x | y |\n\n[raw](https://example.invalid/raw) $x^2$" } },
      ], "", new Map(), true);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const articles = [...root.querySelectorAll("article")];
      const [one, two, user] = articles;
      if (!one || !two || !user) throw new Error(`Expected 3 articles, saw ${articles.length}`);
      const link = one.querySelector('a[href="https://example.invalid/docs"]');
      const auto = one.querySelector('a[href="https://example.invalid/auto"]');
      const code = one.querySelector("pre code");
      const remoteImg = one.querySelector('img[src^="https"]');
      const remoteLink = one.querySelector('a[href="https://remote.example.invalid/logo.png"]');
      const boxes = [...one.querySelectorAll('input[type="checkbox"]')];
      const aligned = one.querySelector("table td:nth-child(2)");
      const backrefs = [...one.querySelectorAll('a[href^="#"]')];
      const dupes = (() => {
        const seen = new Set<string>();
        const repeated: string[] = [];
        for (const node of root.querySelectorAll("[id]")) {
          if (seen.has(node.id)) repeated.push(node.id);
          seen.add(node.id);
        }
        return repeated;
      })();
      const remoteFetches = performance.getEntriesByType("resource")
        .map(entry => entry.name)
        .filter(name => name.includes("remote.example.invalid"));
      return {
        tableCells: [...(one.querySelector("table")?.querySelectorAll("th, td") ?? [])].map(cell => cell.textContent?.trim()),
        centered: aligned && getComputedStyle(aligned).textAlign === "center" ? aligned.textContent?.trim() : null,
        strike: one.querySelector("del, s")?.textContent ?? null,
        boxes: boxes.map(box => ({ checked: (box as HTMLInputElement).checked, disabled: (box as HTMLInputElement).disabled })),
        noteBodies: [one, two].map(article => article.textContent?.includes("footnote body") || article.textContent?.includes("other body")),
        dupes,
        backrefsDangle: backrefs
          .map(a => (a as HTMLAnchorElement).getAttribute("href")?.slice(1) ?? "")
          .filter(id => !root.querySelector(`#${CSS.escape(id)}`)),
        backrefsEscapeArticle: backrefs.filter(a => {
          const target = root.querySelector(`#${CSS.escape((a as HTMLAnchorElement).getAttribute("href")?.slice(1) ?? "")}`);
          return target && !a.closest("article")?.contains(target);
        }).length,
        linkTarget: link?.getAttribute("target"),
        linkRel: link?.getAttribute("rel"),
        autoLinked: auto !== null,
        jsLink: one.querySelector('a[href^="javascript:"]') !== null,
        codeText: code?.textContent ?? null,
        codeClass: code?.className ?? "",
        codeHasLink: Boolean(code?.querySelector("a")),
        highlight: Boolean(code?.querySelector(".hljs-keyword")),
        remoteImg: remoteImg !== null,
        remoteLinkText: remoteLink?.textContent ?? null,
        linkedImage: one.querySelector('a[href="https://example.invalid/gallery"]')?.textContent,
        thumbLink: Boolean(one.querySelector('a[href="https://remote.example.invalid/thumb.png"]')),
        remoteFetches: remoteFetches.length,
        mailto: one.querySelector('a[href^="mailto:"]')?.getAttribute("href") ?? null,
        injected: (window as unknown as { __injected?: boolean }).__injected === true || root.querySelector("script") !== null,
        userLeaked: user.querySelector("table, a, math, del, input") !== null,
        userTextKept: user.textContent?.includes("| User | Table |") ?? false,
        forged: Boolean(one.querySelector('a[href^="/api/"]')),
      };
    });
    expect({ table: actual.tableCells, centered: actual.centered }).toEqual({
      table: ["Name", "Value", "alpha", "1"], centered: "1",
    });
    expect(actual.strike).toBe("removed");
    expect(actual.boxes).toEqual([{ checked: true, disabled: true }, { checked: false, disabled: true }]);
    expect(actual.noteBodies).toEqual([true, true]);
    expect({ dupes: actual.dupes, dangling: actual.backrefsDangle, escaping: actual.backrefsEscapeArticle }).toEqual({
      dupes: [], dangling: [], escaping: 0,
    });
    expect({ target: actual.linkTarget, rel: actual.linkRel, auto: actual.autoLinked, js: actual.jsLink }).toEqual({
      target: "_blank", rel: expect.stringContaining("noopener"), auto: true, js: false,
    });
    expect({ text: actual.codeText, literal: actual.codeHasLink }).toEqual({
      text: 'const url = "https://example.invalid/inside-code";\n', literal: false,
    });
    expect(actual.codeClass).toContain("hljs");
    expect(actual.highlight).toBe(true);
    expect(actual.forged).toBe(false);
    expect({ img: actual.remoteImg, linkText: actual.remoteLinkText, fetches: actual.remoteFetches }).toEqual({
      img: false, linkText: expect.stringContaining("remote logo"), fetches: 0,
    });
    expect({ text: actual.linkedImage, innerLink: actual.thumbLink }).toEqual({ text: "Thumbnail", innerLink: false });
    expect(actual.mailto).toBe("mailto:contact@example.invalid");
    expect(actual.injected).toBe(false);
    expect({ leaked: actual.userLeaked, kept: actual.userTextKept }).toEqual({ leaked: false, kept: true });
  });
});

browserTest("assistant math renders browser-native MathML for dollar and bracket delimiters", async () => {
  await withMarkdown(async evaluate => {
    const actual = await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      const section = document.getElementById("active-session");
      const welcome = document.getElementById("welcome");
      if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
      section.hidden = false;
      welcome.hidden = true;
      const source = [
        "Inline $E = mc^2$ stays in the sentence.",
        "",
        "$$\\int_0^1 x\\,dx$$",
        "",
        "Paren \\(a^2 + b^2\\) and bracket \\[c^2\\] forms.",
      ].join("\n");
      new Transcript(root, scroller, empty).render([
        { key: "math", message: { role: "assistant", content: source } },
      ], "", new Map(), true);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const article = root.querySelector("article");
      const maths = [...(article?.querySelectorAll("math") ?? [])];
      return {
        count: maths.length,
        withContent: maths.filter(math => math.querySelector("mi, mn, mo, mrow")).length,
        rawLeft: ["$E = mc^2$", "$$", "\\(", "\\["].filter(token => article?.textContent?.includes(token)),
      };
    });
    expect({ count: actual.count, withContent: actual.withContent, raw: actual.rawLeft }).toEqual({
      count: 4, withContent: 4, raw: [],
    });
  });
});

browserTest("live stream across a chunk boundary keeps math, reference and code context", async () => {
  await withMarkdown(async evaluate => {
    await evaluate(async Transcript => {
      const root = document.getElementById("messages");
      const scroller = document.getElementById("transcript");
      const empty = document.getElementById("no-messages");
      const section = document.getElementById("active-session");
      const welcome = document.getElementById("welcome");
      if (!root || !scroller || !empty || !section || !welcome) throw new Error("Missing transcript markup");
      section.hidden = false;
      welcome.hidden = true;
      const transcript = new Transcript(root, scroller, empty);
      const tools = new Map();
      const full = "Claim [see][r].\n\n$$E = mc^2$$\n\n```py\nprint(\"https://example.invalid/x\")\n```\n\n[r]: https://example.invalid/ref\n";
      const head = full.slice(0, full.indexOf("^2$$") + 1);
      const show = (text: string, live: string) => {
        transcript.render([{ key: "live", message: { role: "assistant", content: text } }], live, tools);
      };
      show(head, "live");
      await new Promise(resolve => requestAnimationFrame(resolve));
      const partialMath = root.querySelector("math") !== null;
      show(full, "live");
      await new Promise(resolve => requestAnimationFrame(resolve));
      const maths = root.querySelectorAll("math").length;
      const link = root.querySelector('a[href="https://example.invalid/ref"]');
      const code = root.querySelector("pre code")?.textContent ?? null;
      const codeLink = root.querySelector("pre a") !== null;
      if (maths < 1) throw new Error(`Streamed math missing after the chunk boundary (partial render had math: ${partialMath})`);
      if (!link) throw new Error("Reference defined after the chunk boundary did not resolve to a link");
      if (codeLink || code !== 'print("https://example.invalid/x")\n') {
        throw new Error(`Streamed code block lost bytes or linkified its body: ${JSON.stringify(code)}`);
      }
    });
  });
});
