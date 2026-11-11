import { useSyncExternalStore } from "react";

import type { ChatAccess } from "./chatModel";
import { isSendShortcut, type SendShortcut } from "./composerSendKey";
import type { ChatWorktreeSubmodules } from "./chatWorkspacePrefs";
import { isToolCallVisibility, type ToolCallVisibility } from "./timeline/toolCallVisibility";

/**
 * A última escolha do composer: pasta, agente, modelo, esforço, conta e permissão. Preferência
 * desta máquina, então vai para o `localStorage` (como os painéis), tolerando lixo.
 */
export interface ChatPrefs {
  cwd: string | null;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  /** `undefined` = a conta principal do sistema (como no `AccountPickerStep`). */
  accountId: string | null;
  access: ChatAccess;
  /** Começar no modo Plano. */
  plan: boolean;
  /** Modo Fast para conversas TUI novas (ignorado se a matriz ou o modelo não oferecerem suporte). */
  fastMode: boolean;
  /** Abrir a conversa num worktree novo em vez do checkout atual. */
  worktree: boolean;
  /** Submódulos em novos worktrees; null herda do projeto/t3.json e depois usa none. */
  worktreeSubmodules: ChatWorktreeSubmodules | null;
  /** Os agentes que falam por protocolo (o Codex) conversam sem TUI. Desligado = sempre pela TUI. */
  structured: boolean;
  /** A largura da conversa: 736 px como no T3, larga ou a área inteira. */
  width: ChatWidth;
  /** Ação padrão para mensagens enviadas enquanto o agente está trabalhando. */
  followUpBehavior: FollowUpBehavior;
  /** Mostrar skills no autocomplete do comando `/`; o seletor `$` continua disponível. */
  showSkillsInSlashMenu: boolean;
  /** Quando o Enter envia (ou quebra a linha): "Enviar com" no T3 Code. */
  sendShortcut: SendShortcut;
  /** Quais chamadas de ferramenta aparecem no fold "Trabalhou por …" da conversa. */
  toolCallVisibility: ToolCallVisibility;
}

export type ChatWidth = "normal" | "wide" | "full";
export type FollowUpBehavior = "steer" | "queue";

const KEY = "cc-chat-prefs";

export const DEFAULT_CHAT_PREFS: ChatPrefs = { cwd: null, agentId: null, model: null, effort: null, accountId: null, access: "safe", plan: false, fastMode: false, worktree: false, worktreeSubmodules: null, structured: true, width: "normal", followUpBehavior: "steer", showSkillsInSlashMenu: true, sendShortcut: "enter", toolCallVisibility: "showAll" };

const listeners = new Set<() => void>();
let snapshot: ChatPrefs | null = null;

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** Lê o que veio (de onde for) e devolve só o que serve. Pura. */
export function parseChatPrefs(raw: unknown): ChatPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHAT_PREFS };
  const o = raw as Record<string, unknown>;
  return {
    cwd: str(o.cwd),
    agentId: str(o.agentId),
    model: str(o.model),
    effort: str(o.effort),
    accountId: str(o.accountId),
    access: o.access === "ask" || o.access === "edits" || o.access === "full" ? o.access : "safe",
    plan: o.plan === true,
    fastMode: o.fastMode === true,
    worktree: o.worktree === true,
    worktreeSubmodules: o.worktreeSubmodules === "recursive" || o.worktreeSubmodules === "top-level" || o.worktreeSubmodules === "none" ? o.worktreeSubmodules : null,
    structured: o.structured !== false,
    width: o.width === "wide" || o.width === "full" ? o.width : "normal",
    followUpBehavior: o.followUpBehavior === "queue" ? "queue" : "steer",
    showSkillsInSlashMenu: o.showSkillsInSlashMenu !== false,
    sendShortcut: isSendShortcut(o.sendShortcut) ? o.sendShortcut : "enter",
    toolCallVisibility: isToolCallVisibility(o.toolCallVisibility) ? o.toolCallVisibility : "showAll",
  };
}

export function loadChatPrefs(): ChatPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return parseChatPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_CHAT_PREFS };
  }
}

export function saveChatPrefs(prefs: ChatPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* não lembrar a escolha não impede usar */
  }
  snapshot = parseChatPrefs(prefs);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ChatPrefs {
  return snapshot ??= loadChatPrefs();
}

/** Preferências do chat reativas, para mudanças nas Configurações refletirem em conversas abertas. */
export function useChatPrefs(): ChatPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
