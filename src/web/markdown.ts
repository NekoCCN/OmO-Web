import MarkdownIt from "markdown-it";
import type { Env } from "markdown-it";
import { footnote } from "@mdit/plugin-footnote";
import { tasklist } from "@mdit/plugin-tasklist";
import { tex } from "@mdit/plugin-tex";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { el } from "./dom.ts";
import { tr } from "./locale.ts";

const languages = { bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(languages)) hljs.registerLanguage(name, grammar);
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases("tsx", { languageName: "typescript" });

export const markdownRichLimit = 256 * 1024;
const maxCodeHighlight = 24 * 1024;
const maxFormula = 4 * 1024;
const maxDecorated = 64 * 1024;
const markdownIt = new MarkdownIt({ html: false, linkify: true, maxNesting: 24 });
const escape = markdownIt.utils.escapeHtml;
let nextDocument = 0;
type MarkdownState = { readonly id: string; readonly text: string };
const state = new WeakMap<HTMLElement, MarkdownState>();
const markup = new WeakMap<Element, string>();

function spend(env: Env | undefined, length: number): boolean {
  if (!env || typeof env.remaining !== "number" || env.remaining < length) return false;
  env.remaining -= length;
  return true;
}

function externalLink(value: string): URL | undefined {
  // There is no source document URL for a chat message. Relative paths must
  // not implicitly target the authenticated Web API.
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return;
  const url = URL.parse(value);
  if (url && !url.username && !url.password && url.origin !== globalThis.location?.origin) return url;
}

function slug(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s+/g, "-");
}

markdownIt.validateLink = value => value.startsWith("#") || externalLink(value) !== undefined;
function mathBody(formula: string, displayMode: boolean, env: Env | undefined): string {
  if (formula.length <= maxFormula && spend(env, formula.length + 64)) {
    try {
      return katex.renderToString(formula, {
        displayMode, output: "mathml", trust: false, maxExpand: 128, maxSize: 20,
      });
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error;
    }
  }
  return `<code class="math-source">${escape(formula)}</code>`;
}

markdownIt.use(footnote).use(tasklist, { disabled: true, label: false })
  .use(tex, {
    delimiters: "all", mathFence: true,
    render(formula, displayMode, env) {
      const body = mathBody(formula, displayMode, env);
      return displayMode ? `<div class="markdown-math">${body}</div>\n` : body;
    },
  });

// Assistants also put \[...\] on the same line as surrounding prose. The
// block plugin handles stand-alone brackets; this rule precedes Markdown's
// normal escape handling only when both delimiters occur in one inline span.
markdownIt.inline.ruler.before("escape", "web_display_math", (state, silent) => {
  if (!state.src.startsWith("\\[", state.pos) || state.pos + 2 >= state.posMax) return false;
  const start = state.pos + 2;
  const tail = state.src.slice(start, Math.min(state.posMax, start + maxFormula + 2));
  const end = /(?<!\\)(?:\\\\)*\\\]/u.exec(tail);
  if (!end || /[\r\n]/u.test(tail.slice(0, end.index))) return false;
  const length = end.index + end[0].length - 2;
  const formula = tail.slice(0, length);
  if (!formula.trim()) return false;
  if (!silent) state.push("web_display_math", "span", 0).content = formula;
  state.pos = start + length + 2;
  return true;
});
markdownIt.renderer.rules.web_display_math = (tokens, index, _options, env) =>
  `<span class="markdown-math markdown-math-in-prose">${mathBody(tokens[index].content, true, env)}</span>`;

markdownIt.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  const href = String(token.attrGet("href") ?? "");
  if (href.startsWith("#")) {
    token.attrSet("data-markdown-fragment", href.slice(1));
    token.attrSet("href", "#");
  } else if (externalLink(href)?.protocol !== "mailto:") {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return renderer.renderToken(tokens, index, options);
};

markdownIt.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
  const source = externalLink(String(token.attrGet("src") ?? ""));
  if (!source || source.protocol === "mailto:") return escape(alt);
  // A linked thumbnail must not create an anchor inside the surrounding link.
  for (let i = index - 1; token.level > 0 && i >= 0; i--) {
    if (tokens[i].type === "link_open") return escape(alt || source.hostname);
    if (tokens[i].type === "link_close") break;
  }
  const label = tr(`打开图片：${alt || source.hostname}`, `Open image: ${alt || source.hostname}`);
  return `<a class="markdown-image" href="${escape(source.href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
};

function renderCode(source: string, language: string, env: Env | undefined): string {
  const name = /^[a-z0-9][a-z0-9_+#.-]{0,23}$/i.test(language) ? language.toLowerCase() : "";
  const highlighted = name && source.length <= maxCodeHighlight && hljs.getLanguage(name) && spend(env, source.length + 64);
  const code = highlighted ? hljs.highlight(source, { language: name, ignoreIllegals: true }).value : escape(source);
  return `<div class="markdown-code"><div class="markdown-code-bar"><span>${escape(name || tr("代码", "Code"))}</span>`
    + `<button type="button" class="button button--quiet markdown-copy">${tr("复制代码", "Copy code")}</button></div>`
    + `<pre tabindex="0"><code${name ? ` class="${highlighted ? "hljs " : ""}language-${escape(name)}"` : ""}>${code}</code></pre></div>\n`;
}

const originalFence = markdownIt.renderer.rules.fence;
markdownIt.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const name = token.info.trim().split(/\s+/, 1)[0] ?? "";
  return name === "math" && originalFence
    ? originalFence(tokens, index, options, env, renderer) : renderCode(token.content, name, env);
};
markdownIt.renderer.rules.code_block = (tokens, index, _options, env) => renderCode(tokens[index].content, "", env);
markdownIt.renderer.rules.table_open = () => '<div class="markdown-table" tabindex="0" role="region" aria-label="'
  + tr("表格", "Table") + '"><table>\n';
markdownIt.renderer.rules.table_close = () => "</table></div>\n";
for (const tag of ["th", "td"]) {
  markdownIt.renderer.rules[`${tag}_open`] = (tokens, index) => {
    const alignment = String(tokens[index].attrGet("style") ?? "").match(/^text-align:(left|center|right)$/)?.[1];
    return alignment ? `<${tag} class="markdown-align-${alignment}">` : `<${tag}>`;
  };
}

function scopeHeadings(fragment: DocumentFragment, id: string): void {
  const headings = new Map<string, string>();
  const duplicates = new Map<string, number>();
  for (const heading of fragment.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = slug(heading.textContent);
    if (!base) continue;
    let suffix = base;
    let counter = duplicates.get(base) ?? 1;
    while (headings.has(suffix)) suffix = `${base}-${counter++}`;
    duplicates.set(base, counter);
    heading.id = `${id}-${suffix}`;
    headings.set(suffix, heading.id);
  }
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[data-markdown-fragment]")) {
    const requested = link.dataset.markdownFragment ?? "";
    let decoded: string;
    try { decoded = decodeURIComponent(requested); } catch (error) {
      if (!(error instanceof URIError)) throw error;
      decoded = requested;
    }
    const destination = headings.get(slug(decoded));
    if (destination) link.setAttribute("href", `#${encodeURIComponent(destination)}`);
    else link.removeAttribute("href");
    delete link.dataset.markdownFragment;
  }
}

function addCopyHandler(node: HTMLElement): void {
  node.addEventListener("click", async event => {
    const button = event.target;
    if (!(button instanceof HTMLButtonElement) || !button.matches(".markdown-copy")) return;
    const code = button.closest(".markdown-code")?.querySelector("pre > code");
    if (!code || button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = tr("已复制", "Copied");
    } catch (error) {
      if (!(error instanceof DOMException || error instanceof TypeError)) throw error;
      button.textContent = tr("复制失败", "Copy failed");
    } finally {
      button.removeAttribute("aria-busy");
    }
  });
}

function updateBlock(node: HTMLElement, child: Element, index: number): void {
  const current = node.children[index];
  const html = child.outerHTML;
  if (current && markup.get(current) === html) return;
  markup.set(child, html);
  if (!current) { node.append(child); return; }
  const active = document.activeElement;
  const href = active instanceof HTMLAnchorElement && current.contains(active) ? active.getAttribute("href") : null;
  current.replaceWith(child);
  if (href) [...child.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .find(link => link.getAttribute("href") === href)?.focus({ preventScroll: true });
}

export function prose(text: string, node: HTMLElement = el("div", "prose")): HTMLElement {
  const before = state.get(node);
  if (before?.text === text) return node;
  const id = before?.id ?? `omo-markdown-${++nextDocument}`;
  if (!before) addCopyHandler(node);
  const fragment = document.createDocumentFragment();
  if (text.length > markdownRichLimit) {
    fragment.append(el("p", "small muted", tr("正文过长，已按纯文本显示。", "This long message is displayed as plain text.")),
      el("div", "plain break", text));
  } else {
    const template = el("template");
    // Raw HTML is disabled. Only Markdown-it's escaped output and the
    // fixed, bounded highlighter/MathML renderers enter the template.
    template.innerHTML = markdownIt.render(text, { docId: id, remaining: maxDecorated });
    scopeHeadings(template.content, id);
    fragment.append(template.content);
  }
  // Compare top-level blocks (ignoring parser-inserted whitespace). Unchanged
  // links, code scroll positions, and selected text survive live appends.
  const children = [...fragment.children];
  for (const [index, child] of children.entries()) updateBlock(node, child, index);
  while (node.childElementCount > children.length) node.lastElementChild?.remove();
  state.set(node, { id, text });
  return node;
}
