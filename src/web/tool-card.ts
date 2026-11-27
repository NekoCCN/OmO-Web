import { el, list, object } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";
import { textLines, toolLineCount } from "./tool-semantics.ts";
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
  const count = remaining.toLocaleString(uiLocale);
  return { heading, rows: items, note: [note, remaining > 0 && tr(`其余 ${count} 项见详情`, `${count} more in details`)].filter(Boolean).join(" · ") };
}

function lineFact(label: string, value: string | undefined): readonly ToolFact[] {
  if (!value) return [];
  const count = textLines(value);
  return [[label, count === undefined ? tr("已附", "Included") : toolLineCount(count)]];
}

function textLineCount(lines: number): string {
  const count = lines.toLocaleString(uiLocale);
  return tr(`${count} 行文本`, `${count} ${lines === 1 ? "line" : "lines"} of text`);
}

function outputFacts(output: unknown): readonly ToolFact[] {
  const label = tr("可见输出", "Visible output");
  const received = tr("已收到文本", "Text received");
  if (typeof output === "string") {
    const lines = textLines(output);
    return output.length ? [[label, lines === undefined ? received : textLineCount(lines)]] : [];
  }
  let lines = 0;
  let images = 0;
  for (const entry of list(output)) {
    const part = object(entry);
    if (part.type === "text" && typeof part.text === "string") {
      const count = textLines(part.text);
      if (count === undefined) return [[label, received]];
      lines += count;
    } else if (part.type === "image" || part.type === "image_placeholder" || part.type === "imagePlaceholder") images++;
  }
  const count = images.toLocaleString(uiLocale);
  const summary = [lines && textLineCount(lines), images && tr(`${count} 项图片`, `${count} ${images === 1 ? "image" : "images"}`)].filter(Boolean).join(" · ");
  return summary ? [[label, summary]] : [];
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
      if (card) return rowCard(card.heading, card.titles, card.total);
      return;
    }
    case "agent": {
      const routes = recap.dispatchRoutes ?? recap.agentRouting;
      if (routes?.length) {
        const prompts = recap.agentPrompts;
        return { ...rowCard(tr("派发配置", "Dispatch settings"), routes),
          prompts: prompts && { previews: prompts.slice(0, 2).map(promptPreview), count: prompts.length } };
      }
      if (recap.scope) return factCard(tr("任务读取", "Task lookup"), [[tr("范围", "Scope"), recap.scope]]);
      return;
    }
    case "terminal":
      return factCard(tr("终端记录", "Terminal log"), [...lineFact(tr("命令", "Command"), recap.command), ...outputFacts(output)]);
    case "execution":
    case "context":
      return factCard(recap.kind === "execution" ? tr("脚本记录", "Script run") : tr("上下文请求", "Context request"),
        [...facts, ...lineFact(tr("源码", "Source code"), recap.source), ...outputFacts(output)]);
    case "modify":
      return factCard(tr("提交内容", "Submitted changes"), facts);
    case "memory":
      return factCard(tr("记忆变更", "Memory changes"), facts, tr("路径与内容按需查看", "Open details to inspect paths and content"));
    case "web":
      return factCard(tr("网页请求", "Web request"), [...facts, ...outputFacts(output)]);
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

export function agentPromptLabel(index: number, total: number): string {
  const position = (index + 1).toLocaleString(uiLocale);
  return total > 1 ? tr(`任务 ${position} · 提示词`, `Task ${position} prompt`) : tr("提示词", "Prompt");
}

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
    if (count > previews.length) {
      const remaining = count - previews.length;
      const amount = remaining.toLocaleString(uiLocale);
      section.append(el("p", "tool-card-note", tr(`其余 ${amount} 条提示词见详情`, `${amount} more ${remaining === 1 ? "prompt" : "prompts"} in details`)));
    }
    node.append(section);
  }
  if (card.note) node.append(el("p", "tool-card-note", card.note));
  return node;
}
