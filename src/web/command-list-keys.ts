export function isPlainCommandKey(event: KeyboardEvent): boolean {
  return !(event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    event.ctrlKey || event.metaKey || event.altKey || event.shiftKey);
}

export function commandListIndex(
  key: string, index: number, rows: ArrayLike<Element>, viewport: HTMLElement,
): number | undefined {
  const last = rows.length - 1;
  if (last < 0) return;
  switch (key) {
    case "ArrowDown": return index === last ? 0 : index + 1;
    case "ArrowUp": return index <= 0 ? last : index - 1;
    case "PageUp":
    case "PageDown": {
      const direction = key === "PageUp" ? -1 : 1;
      if (index < 0) return direction < 0 ? last : 0;
      const edge = direction < 0 ? 0 : last;
      if (index === edge) return index;
      const top = rows[index].getBoundingClientRect().top;
      let next = index + direction;
      while (next !== edge &&
        Math.abs(rows[next + direction].getBoundingClientRect().top - top) <= viewport.clientHeight) {
        next += direction;
      }
      return next;
    }
  }
}

export function scrollCommandRow(viewport: HTMLElement, row: Element): void {
  // scrollIntoView can also move the composer, dialog ancestors, or the page.
  const top = viewport.getBoundingClientRect().top + viewport.clientTop;
  const bottom = top + viewport.clientHeight;
  const rect = row.getBoundingClientRect();
  if (rect.top < top) viewport.scrollTop -= top - rect.top;
  else if (rect.bottom > bottom) viewport.scrollTop += Math.min(rect.bottom - bottom, rect.top - top);
}

/** Bind once; result buttons can be replaced by the filter or an options refresh. */
export function bindCommandListKeys(dialog: HTMLDialogElement, filter: HTMLInputElement, list: HTMLElement): void {
  let composing = false;
  filter.addEventListener("compositionstart", () => { composing = true; });
  filter.addEventListener("compositionend", () => { composing = false; });
  filter.addEventListener("blur", () => { composing = false; });
  dialog.addEventListener("keydown", event => {
    if (!dialog.open || composing || !isPlainCommandKey(event) || list.hidden) return;
    const fromFilter = event.target === filter;
    if (!fromFilter && !(event.target instanceof Element && list.contains(event.target))) return;
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-invocation]:enabled"));
    const index = rows.findIndex(row => row === event.target);
    if (!fromFilter && index < 0) return;
    if (fromFilter && event.key === "Enter" && rows[0]) {
      event.preventDefault();
      rows[0].click();
      return;
    }
    // Enter on a row uses the existing native button activation and insertion.
    const next = commandListIndex(event.key, index, rows, dialog);
    if (next === undefined) return;
    event.preventDefault();
    rows[next].focus({ preventScroll: true });
    scrollCommandRow(dialog, rows[next]);
  });
}
