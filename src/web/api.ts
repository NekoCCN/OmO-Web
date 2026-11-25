import { list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import type { Answer } from "./interactions.ts";

export type Session = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly settled: boolean;
  readonly active: boolean;
  readonly running: boolean;
};

export function parseSession(value: unknown): Session | undefined {
  const raw = object(value);
  const id = str(raw.id);
  if (!id) return;
  return {
    id, name: str(raw.name) || "未命名会话", cwd: str(raw.cwd), updatedAt: num(raw.updatedAt) ?? 0,
    archived: raw.archived === true, settled: raw.settled === true, active: raw.active === true, running: raw.running === true,
  };
}

export const parseSessions = (data: Wire): Session[] => list(data.sessions).flatMap(value => {
  const session = parseSession(value);
  return session ? [session] : [];
});

export type Mode = "prompt" | "steer" | "follow_up";
export type CliLiveAction =
  | { readonly action: "connect" }
  | { readonly action: "disconnect" }
  | { readonly action: "input"; readonly mode: "prompt"; readonly message: string; readonly clientMessageId: string }
  | { readonly action: "stop"; readonly expectedTurnId: string };
export type BranchSource = { readonly kind: "web" | "history" | "live"; readonly id: string; readonly name: string };
export type BranchChoice = { readonly kind: "fork"; readonly entryId: string } | { readonly kind: "clone" };
export type Image = { readonly type: "image"; readonly data: string; readonly mimeType: string };
export type Action =
  | { readonly action: "resume" | "abort" | "clearQueue" }
  | { readonly action: "prompt"; readonly message: string; readonly mode: Mode; readonly expectedTurnId?: string; readonly clientMessageId: string; readonly images?: readonly Image[] }
  | { readonly action: "command"; readonly invocation: string; readonly arguments?: string; readonly clientMessageId?: string }
  | { readonly action: "rename"; readonly name: string }
  | { readonly action: "archive" | "settle" | "fast" | "autoCompaction"; readonly enabled: boolean }
  | { readonly action: "model"; readonly provider: string; readonly modelId: string }
  | { readonly action: "thinking"; readonly level: string }
  | { readonly action: "compact"; readonly instructions?: string }
  | { readonly action: "navigate"; readonly targetId: string | null }
  | ({ readonly action: "answer"; readonly requestId: string } & Answer);

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export const sessionPath = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;
export const cliHistoryPath = (id: string): string => `/api/cli-history/${encodeURIComponent(id)}`;
export const cliLivePath = (id: string): string => `/api/cli-live/${encodeURIComponent(id)}`;
export const branchPath = ({ kind, id }: BranchSource): string => {
  switch (kind) {
    case "web": return sessionPath(id);
    case "history": return cliHistoryPath(id);
    case "live": return cliLivePath(id);
  }
};

export class Api {
  token = "";

  async request(path: string, body?: object, signal?: AbortSignal): Promise<Wire> {
    const post = body !== undefined;
    const response = await fetch(path, {
      method: post ? "POST" : "GET",
      signal,
      cache: "no-store",
      ...(post ? { headers: { "Content-Type": "application/json", "X-OmO-Token": this.token }, body: JSON.stringify(body) } : {}),
    });
    let data: Wire;
    try {
      const raw: unknown = await response.json();
      data = object(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RequestError(`本机 Web 服务返回了无效响应（HTTP ${response.status}）`, response.status, "");
    }
    if (!response.ok) throw new RequestError(str(data.error) || `请求失败（HTTP ${response.status}）`, response.status, str(data.code));
    return data;
  }

  action(id: string, action: Action): Promise<Wire> {
    return this.request(`${sessionPath(id)}/actions`, action);
  }

  cliLiveAction(id: string, action: CliLiveAction): Promise<Wire> {
    return this.request(`${cliLivePath(id)}/actions`, action);
  }

  async resumeHistory(id: string): Promise<Session> {
    const data = await this.request(`${cliHistoryPath(id)}/resume`, {});
    const session = parseSession(data.session);
    if (!session?.active) throw new RequestError("没有收到可继续的 Web 会话。请检查会话列表。", 502, "");
    return session;
  }

  async handoff(id: string): Promise<{ session: Session; command: string }> {
    const data = await this.request(`${sessionPath(id)}/handoff`, {});
    const session = parseSession(data.session);
    const command = str(data.command);
    if (!session || session.id !== id || object(data.session).active !== false || !command.trim()) {
      throw new RequestError("无法确认会话已释放，未显示启动命令。", 502, "");
    }
    return { session, command };
  }
}
