export function byId<T extends HTMLElement>(id: string, kind: { new (): T }): T {
  const node = document.getElementById(id);
  if (node instanceof kind) return node;
  throw new Error(`界面控件不存在：${id}`);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(label: string, run: () => void, variant = ""): HTMLButtonElement {
  const node = el("button", `button ${variant}`, label);
  node.type = "button";
  node.addEventListener("click", run);
  return node;
}

export function notice(node: HTMLElement, message = ""): void {
  if (node.textContent !== message) node.textContent = message;
  node.hidden = !message;
}

export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = el("label", "field");
  node.append(el("span", "", label), control);
  return node;
}

export function option(label: string, value: string): HTMLOptionElement {
  const node = el("option", "", label);
  node.value = value;
  return node;
}

export function fold(label: string, ...children: Node[]): HTMLDetailsElement {
  const node = el("details");
  const body = el("div", "fold-body stack stack--tight");
  body.append(...children);
  node.append(el("summary", "", label), body);
  return node;
}

export function codeBlock(text: string): HTMLPreElement {
  const node = el("pre");
  node.tabIndex = 0;
  node.append(el("code", "", text));
  return node;
}

export type Wire = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Wire => value !== null && typeof value === "object" && !Array.isArray(value);
export const object = (value: unknown): Wire => isObject(value) ? value : {};
export const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === "string" ? value : "";
export const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const pretty = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
export const errorText = (error: unknown): string => error instanceof Error ? error.message : "发生未知错误";
export const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof imageTypes)[number];
export const isImageType = (value: unknown): value is ImageType => imageTypes.some(type => type === value);
