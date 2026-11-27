import { object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";

type Batch = { readonly phase?: string; readonly items: readonly string[] };
export type TodoChange = {
  readonly operation?: string;
  readonly preview?: string;
  readonly batches: readonly Batch[];
  readonly card?: { readonly heading: string; readonly titles: readonly string[]; readonly total: number };
};

const operations = new Map([
  ["init", tr("初始化", "Set up list")], ["start", tr("请求开始", "Request to start")],
  ["done", tr("请求完成", "Request to complete")], ["drop", tr("请求放弃", "Request to drop")],
  ["rm", tr("请求移除", "Request to remove")], ["append", tr("追加", "Append")], ["view", tr("查看", "View")],
]);
const itemLimit = 24;
const validLabel = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit && Boolean(value.trim()) && !/[\p{Cc}\p{Cf}]/u.test(value);

function submittedBatches(input: Wire): readonly Batch[] | undefined {
  if (input.op !== "init" && input.op !== "append") return;
  const phased = input.list !== undefined;
  if (phased && (input.op !== "init" || input.items !== undefined)) return;
  const batches = phased ? input.list : [{ items: input.items, phase: input.op === "append" ? input.phase : undefined }];
  if (!Array.isArray(batches) || batches.length > itemLimit) return;
  const submitted: Batch[] = [];
  let count = 0;
  for (const value of batches) {
    const { phase, items } = object(value);
    if ((phased || phase !== undefined) && !validLabel(phase, 96)) return;
    if (!Array.isArray(items) || count + items.length > itemLimit ||
      !items.every((item: unknown): item is string => validLabel(item, 240))) return;
    count += items.length;
    if (items.length) submitted.push({ phase: str(phase) || undefined, items });
  }
  return submitted;
}

function recognizableTitle(value: string): boolean {
  // The summary is for short natural-language titles, not a sanitised view of every submitted value.
  return value.length <= 48 && /^[\p{L}][\p{L}\p{M}\p{N}]*(?: [\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u.test(value) &&
    (value.includes(" ") || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) &&
    !/[a-z0-9]{21,}|\d{6,}|\b(?:password|passwd|secret|credential|token|authorization|bearer|api key|private key)\b|凭据|密钥|口令|令牌|密码/iu.test(value) &&
    !/^(?:bash|sh|zsh|fish|pwsh|powershell|sudo|env|git|cd|ls|cat|printf|echo|rm|cp|mv|mkdir|touch|curl|wget|ssh|scp|chmod|chown|find|grep|rg|node|bun|npm|npx|python3?|pip|uv|docker|kubectl|kubectx|systemctl|make|sed|awk|head|tail|dd|export|set)\b/iu.test(value);
}

export function todoChange(input: Wire): TodoChange {
  const op = str(input.op);
  const operation = operations.get(op);
  const batches = submittedBatches(input);
  const submitted = batches?.flatMap(batch => batch.items) ?? [];
  const titles = submitted.map(item => item.trim()).filter(recognizableTitle);
  const requested = op === "start" || op === "done" || op === "drop" || op === "rm";
  const task = requested && input.phase === undefined && input.list === undefined && input.items === undefined &&
    validLabel(input.task, 240) ? input.task.trim() : undefined;
  const requestTitle = task && recognizableTitle(task) ? task : undefined;
  const preview = requestTitle ?? titles[0];
  const count = submitted.length.toLocaleString(uiLocale);
  const remaining = (submitted.length - 1).toLocaleString(uiLocale);
  return {
    operation: operation && batches !== undefined
      ? tr(`${operation} · ${count} 项`, `${operation} · ${count} ${submitted.length === 1 ? "task" : "tasks"}`) : operation,
    preview: preview && submitted.length > 1 ? tr(`${preview} · 另 ${remaining} 项`, `${preview} · ${remaining} more`) : preview,
    batches: batches ?? [],
    card: requestTitle ? { heading: tr("待办变更", "Task changes"), titles: [requestTitle], total: 1 }
      : titles.length ? { heading: op === "append" ? tr("新增待办", "Add tasks") : tr("提交的待办", "Tasks submitted"),
        titles, total: submitted.length } : undefined,
  };
}
