export type UiLocale = "zh-CN" | "en";

const localeKey = "omo-web-language";

function readUiLocale(): UiLocale {
  if (typeof window === "undefined") return "zh-CN";
  try { return window.localStorage.getItem(localeKey) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}

export const uiLocale = readUiLocale();

export function tr(zh: string, en: string): string {
  return uiLocale === "en" ? en : zh;
}

export function saveUiLocale(next: UiLocale): boolean {
  try { window.localStorage.setItem(localeKey, next); return true; }
  catch { return false; }
}

export function applyStaticLocale(root: Document = document): void {
  root.documentElement.lang = uiLocale;
  if (uiLocale !== "en") return;
  for (const node of root.querySelectorAll("[data-en]")) {
    node.textContent = node.getAttribute("data-en");
  }
  for (const key of ["title", "aria-label", "placeholder", "alt"] as const) {
    const attribute = `data-en-${key}`;
    for (const node of root.querySelectorAll(`[${attribute}]`)) {
      const value = node.getAttribute(attribute);
      if (value !== null) node.setAttribute(key, value);
    }
  }
}
