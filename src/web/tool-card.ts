import { el, list, object } from "./dom.ts";
import { textLines } from "./tool-semantics.ts";
import type { ToolFact, ToolRecap } from "./tool-semantics.ts";

type ToolCard = {
  readonly heading: string;
  readonly note?: string;
  readonly prompts?: { readonly previews: readonly string[]; readonly count: number };
} & ({ readonly rows: readonly string[] } | { readonly facts: readonly ToolFact[] });

const cardLimit = 4;

function rowCard(heading: string, rows: readonly string[], total = rows.length, note?: string): ToolCard {
  const items = rows.slice(0, cardLimit);
  const remaining = total - items.length;
  return { heading, rows: items, note: [note, remaining > 0 && `其余 ${remaining} 项见详情`].filter(Boolean).join(" · ") };
}

function lineFact(label: string, value: string | undefined): readonly ToolFact[] {
  if (!value) return [];
  const count = textLines(value);
  return [[label, count === undefined ? "已附" : `${count} 行`]];
}

function outputFacts(output: unknown): readonly ToolFact[] {
  if (typeof output === "string") {
    const lines = textLines(output);
    return output.length ? [["可见输出", lines === undefined ? "已收到文本" : `${lines} 行文本`]] : [];
  }
  let lines = 0;
  let images = 0;
  for (const entry of list(output)) {
    const part = object(entry);
    if (part.type === "text" && typeof part.text === "string") {
      const count = textLines(part.text);
      if (count === undefined) return [["可见输出", "已收到文本"]];
      lines += count;
    } else if (part.type === "image" || part.type === "image_placeholder" || part.type === "imagePlaceholder") images++;
  }
  const summary = [lines && `${lines} 行文本`, images && `${images} 项图片`].filter(Boolean).join(" · ");
  return summary ? [["可见输出", summary]] : [];
}

function factCard(heading: string, facts: readonly ToolFact[], note?: string): ToolCard | undefined {
  if (facts.length) return { heading, facts, note };
}

function promptPreview(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/gu, " ");
  const excerpt = /^[\s\S]{1,140}/u.exec(compact)?.[0] ?? "";
  return excerpt.length < compact.length ? `${excerpt}…` : excerpt;
}

export function projectToolCard(recap: ToolRecap, output: unknown): ToolCard | undefined {
  const facts = recap.facts ?? [];
  switch (recap.kind) {
    case "todo": {
      const card = recap.todo?.card;
      if (card) return rowCard(recap.todo?.requested ? "请求的变更" : "提交的待办", card.titles, card.total, "非当前进度");
      return;
    }
    case "agent": {
      const routes = recap.dispatchRoutes ?? recap.agentRouting;
      if (routes?.length) {
        const prompts = recap.agentPrompts;
        return { ...rowCard("派发配置", routes),
          prompts: prompts && { previews: prompts.slice(0, 2).map(promptPreview), count: prompts.length } };
      }
      if (recap.scope) return factCard("任务读取", [["范围", recap.scope]]);
      return;
    }
    case "terminal":
      return factCard("终端记录", [...lineFact("命令", recap.command), ...outputFacts(output)]);
    case "execution":
    case "context":
      return factCard(recap.kind === "execution" ? "脚本记录" : "上下文请求",
        [...facts, ...lineFact("源码", recap.source), ...outputFacts(output)]);
    case "modify":
      return factCard("提交内容", facts);
    case "memory":
      return factCard("记忆变更", facts, "路径与内容按需查看");
    case "web":
      return factCard("网页请求", [...facts, ...outputFacts(output)]);
    case "inspect":
    case "unknown":
      return;
    default: {
      const unreachable: never = recap.kind;
      return unreachable;
    }
  }
}

export function toolCardRows(items: readonly string[]): HTMLUListElement {
  const list = el("ul", "tool-card-rows");
  list.append(...items.map(item => el("li", "", item)));
  return list;
}

export const agentPromptLabel = (index: number, total: number): string =>
  total > 1 ? `任务 ${index + 1} · 提示词` : "提示词";

export function renderToolCard(card: ToolCard): HTMLElement {
  const node = el("div", "tool-card-content");
  node.append(el("p", "tool-card-heading", card.heading));
  if ("rows" in card) node.append(toolCardRows(card.rows));
  else {
    const facts = el("dl", "tool-card-facts");
    for (const [label, value] of card.facts) {
      const pair = el("div", "tool-card-fact");
      pair.append(el("dt", "", label), el("dd", "", value));
      facts.append(pair);
    }
    node.append(facts);
  }
  if (card.prompts) {
    const { previews, count } = card.prompts;
    const section = el("div", "tool-card-prompts");
    previews.forEach((prompt, index) => {
      const item = el("div");
      item.append(el("p", "tool-card-note", agentPromptLabel(index, count)), el("p", "tool-card-prompt", prompt));
      section.append(item);
    });
    if (count > previews.length) section.append(el("p", "tool-card-note", `其余 ${count - previews.length} 条提示词见详情`));
    node.append(section);
  }
  if (card.note) node.append(el("p", "tool-card-note", card.note));
  return node;
}
