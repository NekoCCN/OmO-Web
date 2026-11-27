import { button, el, field, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";

type QuestionAnswer = { readonly selected: readonly string[]; readonly text?: string };
export type Answer = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true } |
  { readonly answers: Readonly<Record<string, QuestionAnswer>>; readonly comment?: string };
type Submit = (id: string, answer: Answer) => Promise<void>;
const supported = new Set(["select", "confirm", "input", "editor", "question"]);
export const requestId = (request: Wire): string => str(request.id) || str(request.requestId);
export const isRequest = (request: Wire): boolean => Boolean(requestId(request) && supported.has(str(request.method)));

function questionFields(body: HTMLElement, request: Wire): () => Answer | undefined {
  const inputs: Array<() => readonly [string, QuestionAnswer] | undefined> = [];
  for (const [index, raw] of list(request.questions).entries()) {
    const question = object(raw);
    const id = str(question.id);
    if (!id) continue;
    const block = el("fieldset", "stack stack--tight");
    const position = (index + 1).toLocaleString(uiLocale);
    block.append(el("legend", "", str(question.header) || tr(`问题 ${position}`, `Question ${position}`)));
    if (str(question.question)) block.append(el("p", "plain", str(question.question)));
    const controls: HTMLInputElement[] = [];
    for (const value of list(question.options)) {
      const choice = object(value);
      const label = str(choice.label);
      if (!label) continue;
      const input = el("input");
      input.name = `question-${index}`;
      input.type = question.multiSelect === true ? "checkbox" : "radio";
      input.value = label;
      const control = el("label", "interaction-option");
      const text = el("span", "break", label);
      if (str(choice.description)) text.append(el("small", "muted", ` · ${str(choice.description)}`));
      control.append(input, text);
      controls.push(input);
      block.append(control);
    }
    const custom = el("input");
    custom.type = "text";
    custom.maxLength = 12000;
    custom.autocomplete = "off";
    block.append(field(tr("自填回答（选填）", "Your own answer (optional)"), custom));
    body.append(block);
    inputs.push(() => {
      const selected = controls.filter(node => node.checked).map(node => node.value);
      const text = custom.value.trim();
      return selected.length || text ? [id, { selected, ...(text ? { text } : {}) }] : undefined;
    });
  }
  const comment = el("textarea");
  comment.rows = 2;
  comment.maxLength = 12000;
  body.append(field(tr("补充说明（选填）", "Comment (optional)"), comment));
  body.append(el("p", "small muted", tr("至少回答一题或填写补充说明。", "Answer at least one question or leave a comment.")));
  return () => {
    const pairs = inputs.flatMap(read => {
      const answer = read();
      return answer ? [answer] : [];
    });
    const extra = comment.value.trim();
    return pairs.length || extra ? { answers: Object.fromEntries(pairs), ...(extra ? { comment: extra } : {}) } : undefined;
  };
}

function updateQuestionMetadata(node: HTMLFormElement, request: Wire): void {
  const metadata = node.querySelector<HTMLElement>("[data-question-metadata]");
  if (!metadata) return;
  const parts: string[] = [];
  if (request.waitForAnswer === true) parts.push(tr("等待回答", "Waiting for your answer"));
  else if (request.waitForAnswer === false) parts.push(tr("异步提问", "Not waiting for an answer"));
  const raisedBy = str(request.raisedBy);
  if (raisedBy) parts.push(tr(`提问人：${raisedBy}`, `Asked by: ${raisedBy}`));
  const remaining = num(request.remainingMs);
  if (remaining !== undefined) {
    const seconds = Math.ceil(Math.max(0, remaining) / 1000);
    const amount = seconds.toLocaleString(uiLocale);
    parts.push(tr(`更新时剩余 ${amount} 秒`, `${amount} ${seconds === 1 ? "second" : "seconds"} left at last update`));
  }
  const deadline = num(request.deadlineAtMs);
  if (deadline !== undefined) {
    const date = new Date(deadline);
    if (!Number.isNaN(date.getTime())) {
      const time = date.toLocaleString(uiLocale);
      parts.push(tr(`截止：${time}`, `Deadline: ${time}`));
    }
  }
  metadata.textContent = parts.join(" · ");
  metadata.hidden = parts.length === 0;
}

const permissionOptions: Readonly<Record<string, string>> = {
  Allow: tr("允许", "Allow"), "Allow once": tr("仅允许这次", "Allow once"),
  "Allow always": tr("始终允许", "Always allow"), "Allow for session": tr("本会话始终允许", "Allow for this session"),
  Deny: tr("拒绝", "Deny"), Block: tr("阻止", "Block"), "Deny with feedback": tr("拒绝并说明原因", "Deny with feedback"),
};

function requestForm(request: Wire, submit: Submit): HTMLFormElement {
  const method = str(request.method);
  const title = str(request.title);
  const permission = Boolean(request.toolCallId) && method !== "question";
  const node = el("form", "request-form");
  const label = method === "question" ? tr("待回答问题", "Pending question")
    : permission ? tr("工具批准", "Tool approval") : tr("等待你的决定", "Your response is needed");
  node.setAttribute("aria-label", label);
  node.dataset.method = method;
  const heading = el(title ? "p" : "h2", "request-kind", method === "question" ? tr("Agent 提问", "Agent question") : label);
  const copy = el("div", "request-copy");
  if (title) copy.append(el("h2", "plain request-title", title));
  if (str(request.message)) copy.append(el("p", "plain", str(request.message)));
  if (method === "question") {
    const metadata = el("p", "small muted");
    metadata.dataset.questionMetadata = "";
    copy.append(metadata);
  }
  const remote = object(request.remoteOrigin);
  const origin = str(remote.deviceName) || str(remote.deviceId);
  if (origin) copy.append(el("p", "small muted break", tr(`请求设备：${origin}`, `Requesting device: ${origin}`)));
  if (permission) {
    const toolCall = str(request.toolCallId);
    copy.append(el("p", "small muted path", tr(`工具调用：${toolCall}`, `Tool call: ${toolCall}`)));
  }

  const fields = el("div", "stack stack--tight request-fields");
  const status = el("p", "notice error small");
  status.setAttribute("role", "alert");
  status.hidden = true;
  const actions = el("div", "row request-actions");
  let sending = false;
  const send = async (answer: Answer) => {
    if (sending || node.dataset.offline === "true") return;
    sending = true;
    node.setAttribute("aria-busy", "true");
    notice(status);
    for (const control of actions.querySelectorAll("button")) control.disabled = true;
    try {
      await submit(requestId(request), answer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : tr("发生未知错误", "Unknown error");
      notice(status, tr(`未能提交：${reason}`, `Could not submit: ${reason}`));
    } finally {
      sending = false;
      node.removeAttribute("aria-busy");
      for (const control of actions.querySelectorAll("button")) control.disabled = node.dataset.offline === "true";
    }
  };
  let read: (() => Answer | undefined) | undefined;
  const isSecret = request.secret === true || Boolean(request.privateInput);
  switch (method) {
    case "question": read = questionFields(fields, request); break;
    case "confirm":
      actions.append(button(tr("不批准", permission ? "Deny" : "No"), () => void send({ confirmed: false })),
        button(tr("确认", "Confirm"), () => void send({ confirmed: true })));
      break;
    case "select": {
      const select = el("select");
      const placeholder = option(tr("请选择，不会自动批准", "Choose an option. Nothing is approved automatically."), "");
      placeholder.disabled = true;
      select.append(placeholder);
      for (const item of list(request.options)) {
        if (typeof item === "string" && item) select.append(option(Object.hasOwn(permissionOptions, item) ? permissionOptions[item] ?? item : item, item));
      }
      select.value = "";
      fields.append(field(tr("可选操作", "Options"), select));
      read = () => select.value ? { value: select.value } : undefined;
      break;
    }
    case "input":
    case "editor": {
      if (isSecret) {
        fields.append(el("p", "muted", tr("此输入需要在原生客户端中处理。", "Respond in the native client.")));
        break;
      }
      const control = method === "editor" ? el("textarea") : el("input");
      if (control instanceof HTMLTextAreaElement) {
        control.rows = 5;
        control.value = str(request.prefill);
      } else control.autocomplete = "off";
      control.placeholder = str(request.placeholder);
      fields.append(field(tr("输入内容", "Response"), control));
      read = () => ({ value: control.value });
      break;
    }
  }
  if (!isSecret) actions.append(button(tr("取消请求", "Cancel request"), () => void send({ cancelled: true }), "button--quiet"));
  if (read) {
    const submitButton = el("button", "button", tr("提交回答", "Submit response"));
    submitButton.type = "submit";
    actions.append(submitButton);
  }
  node.addEventListener("submit", event => {
    event.preventDefault();
    if (!read) return;
    const answer = read();
    if (answer) void send(answer);
    else notice(status, tr("请至少填写一项回答或选择一个操作。", "Enter a response or choose an option."));
  });
  const controls = el("div", method === "select" ? "request-controls request-controls--choice" : "request-controls");
  controls.append(fields, actions);
  const body = el("div", "request-body");
  body.append(copy, controls, status);
  node.append(heading, body);
  if (method === "question") updateQuestionMetadata(node, request);
  return node;
}

export class Interactions {
  private readonly nodes = new Map<string, HTMLFormElement>();

  constructor(private readonly root: HTMLElement) {}

  get first(): HTMLFormElement | undefined {
    return this.nodes.values().next().value;
  }

  get firstQuestion(): HTMLFormElement | undefined {
    return [...this.nodes.values()].find(node => node.dataset.method === "question");
  }

  render(requests: ReadonlyMap<string, Wire>, online: boolean, submit: Submit): void {
    for (const [id, node] of this.nodes) if (!requests.has(id)) {
      node.remove();
      this.nodes.delete(id);
    }
    for (const [id, request] of requests) {
      let node = this.nodes.get(id);
      if (!node) {
        node = requestForm(request, submit);
        this.nodes.set(id, node);
        this.root.append(node);
      }
      if (request.method === "question") updateQuestionMetadata(node, request);
      node.dataset.offline = String(!online);
      if (node.getAttribute("aria-busy") !== "true") {
        for (const control of node.querySelectorAll("button")) control.disabled = !online;
      }
    }
  }

  reset(): void {
    this.nodes.clear();
    this.root.replaceChildren();
  }
}
