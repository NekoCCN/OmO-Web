import { el, object, str } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const bytes = new Intl.NumberFormat(uiLocale, { style: "unit", unit: "byte" });
const scaled = new Intl.NumberFormat(uiLocale, { maximumFractionDigits: 1 });
const units = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export function attachmentLink(sessionId: string | undefined, output: unknown): HTMLAnchorElement | undefined {
  if (!sessionId || !idPattern.test(sessionId) || !Array.isArray(output) || output.length !== 1) return;
  const part = object(output[0]);
  const text = str(part.text);
  if (part.type !== "text" || !text || text.length > 2048) return;
  let receipt;
  try { receipt = object(JSON.parse(text)); }
  catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const { omoWebAttachment, id, name, size } = receipt;
  if (Object.keys(receipt).length !== 4 || omoWebAttachment !== 1 || typeof id !== "string" || !idPattern.test(id) ||
    typeof name !== "string" || !name || name.length > 255 || /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ||
    typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return;
  let value = size;
  let unit: (typeof units)[number] | undefined;
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const suffix = unit ? `${scaled.format(value)} ${unit}` : bytes.format(value);
  const anchor = el("a", "tool-attachment");
  anchor.href = `/api/sessions/${sessionId}/attachments/${id}`;
  anchor.download = name;
  anchor.append(`${tr("下载", "Download")} `, el("bdi", "tool-attachment-name", name), ` · ${suffix}`);
  return anchor;
}
