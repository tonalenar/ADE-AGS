import type { PermissionPrompt } from "@/features/canvas/terminalPrompts";
import type { PendingApproval, Task } from "@/features/runs/types";

import type { RequestRow, ThreadRow } from "../structured/ipc";
import type { TimelineItem } from "../timeline/types";
import { isNetworkCommand, kindOfPrompt, kindOfTool, riskOf, touchesOf, type AskKind, type PendingAsk } from "./permissionModel";

/**
 * De cada fonte para o `PendingAsk` da caixa: as aprovações das conversas por protocolo
 * (`chat_request`), os diálogos que as TUIs mostram (`terminalPrompts`) e as aprovações da frota
 * (`runs`). Puro: recebe os dados já lidos dos stores.
 */

type Label = (agentId: string) => string;

function ask(base: Omit<PendingAsk, "risk" | "network"> & { network?: boolean }): PendingAsk {
  const network = base.network ?? (base.kind === "network" || (base.kind === "command" && isNetworkCommand(base.detail)));
  return { ...base, network, risk: riskOf(base) };
}

/** A ferramenta de um pedido do Claude (`options.tool`); o Codex não manda. */
function toolOf(request: RequestRow): string | undefined {
  const options = request.options;
  return options && !Array.isArray(options) ? options.tool : undefined;
}

/** Os pedidos de permissão de uma conversa por protocolo (perguntas e a saída do Plano ficam no composer). */
export function threadAsks(thread: ThreadRow, requests: RequestRow[], items: TimelineItem[], label: Label): PendingAsk[] {
  return requests.flatMap((r): PendingAsk[] => {
    const tool = toolOf(r);
    if (r.kind === "question" || tool === "ExitPlanMode" || tool === "AskUserQuestion") return [];
    const kind: AskKind = r.kind === "fileChange" ? "edit" : kindOfTool(tool, "command");
    // O Claude escreve "WebFetch: <url>" no título das ferramentas que não são comando.
    const title = tool && r.title.startsWith(`${tool}: `) ? r.title.slice(tool.length + 2) : r.title;
    // O Codex não manda os arquivos no pedido de edição: eles estão no item da edição (`<item>#<n>`).
    const edited = r.itemId ? items.filter((i) => i.id.startsWith(`${r.itemId}#`) && i.path).map((i) => i.path!) : [];
    const files = kind === "edit" ? (edited.length > 0 ? edited : [title].filter(Boolean)) : kind === "command" ? touchesOf(title) : [];
    const detail = kind === "edit" ? files.join(", ") || r.detail : title || r.detail;
    return [ask({
      id: `thread:${r.id}`,
      ref: { source: "thread", threadId: thread.id, requestId: r.id },
      agentId: thread.agentId,
      agentLabel: label(thread.agentId),
      conversation: `thread:${thread.id}`,
      where: thread.title,
      kind,
      detail,
      files,
      cwd: thread.cwd,
      canSession: true,
      atMs: r.createdAt < 1e12 ? r.createdAt * 1000 : r.createdAt,
    })];
  });
}

export interface TuiTab {
  id: string;
  title: string;
  cwd: string;
  agentId: string;
  agentLabel: string;
}

/** A primeira linha de verdade do detalhe que a TUI mostra (sem o `$ ` e as bordas). */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.replace(/^\$\s+/, "").trim()).find(Boolean) ?? "";
}

/**
 * O diálogo de uma TUI. A tela nem sempre traz o comando junto da pergunta (o Claude Code o
 * desenha acima): aí vale a ferramenta pendente que o canal leu do transcript (`pending`).
 */
export function tuiAsk(tab: TuiTab, prompt: PermissionPrompt, atMs: number, pending: { name: string; summary: string } | null): PendingAsk {
  const fromScreen = firstLine(prompt.detail);
  const kind = pending ? kindOfTool(pending.name, kindOfPrompt(prompt.kind, prompt.detail)) : kindOfPrompt(prompt.kind, prompt.detail);
  const detail = (pending?.summary || fromScreen || prompt.title).trim();
  const files = kind === "edit" ? [detail].filter(Boolean) : kind === "command" ? touchesOf(detail) : [];
  return ask({
    id: `tui:${tab.id}:${prompt.signature}`,
    ref: { source: "tui", tabId: tab.id, signature: prompt.signature },
    agentId: tab.agentId,
    agentLabel: tab.agentLabel,
    conversation: tab.id,
    where: tab.title,
    kind,
    detail,
    files,
    cwd: tab.cwd,
    canSession: prompt.choices.some((c) => c.id === "allowSession"),
    atMs,
  });
}

/** Uma aprovação da frota (o broker das tarefas headless). */
export function fleetAsk(approval: PendingApproval, task: Task | undefined, label: Label): PendingAsk {
  const input = approval.input ?? {};
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const kind = kindOfTool(approval.toolName, "command");
  const detail = kind === "edit" ? str("file_path") || str("notebook_path")
    : kind === "network" ? str("url") || str("query")
    : str("command") || approval.toolName;
  const files = kind === "edit" ? [detail].filter(Boolean) : kind === "command" ? touchesOf(detail) : [];
  const agentId = task?.agentId ?? "claude-code";
  return ask({
    id: `fleet:${approval.id}`,
    ref: { source: "fleet", approvalId: approval.id },
    agentId,
    agentLabel: label(agentId),
    conversation: null,
    where: task?.title ?? approval.toolName,
    kind,
    detail,
    files,
    cwd: task?.worktreePath ?? task?.cwd ?? null,
    canSession: false,
    atMs: approval.askedAt < 1e12 ? approval.askedAt * 1000 : approval.askedAt,
  });
}
