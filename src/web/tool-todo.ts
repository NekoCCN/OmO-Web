import { object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

type Batch = { readonly phase?: string; readonly items: readonly string[] };
export type TodoChange = {
  readonly operation?: string;
  readonly preview?: string;
  readonly batches: readonly Batch[];
  readonly requested: boolean;
};

const operations = new Map([
  ["init", "初始化"], ["start", "请求开始"], ["done", "请求完成"], ["drop", "请求放弃"],
  ["rm", "请求移除"], ["append", "追加"], ["view", "查看"],
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
  const title = submitted.map(item => item.trim()).find(recognizableTitle);
  const requested = op === "start" || op === "done" || op === "drop" || op === "rm";
  const task = requested && input.phase === undefined && input.list === undefined && input.items === undefined &&
    validLabel(input.task, 240) ? input.task.trim() : undefined;
  const preview = task && recognizableTitle(task) ? task : title;
  return {
    operation: operation && batches !== undefined ? `${operation} · ${submitted.length} 项` : operation,
    preview: preview && submitted.length > 1 ? `${preview} · 另 ${submitted.length - 1} 项` : preview,
    batches: batches ?? [],
    requested,
  };
}
