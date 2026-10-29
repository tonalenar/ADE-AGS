import type { ChatAccess } from "./chatModel";

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
  /** Abrir a conversa num worktree novo em vez do checkout atual. */
  worktree: boolean;
}

const KEY = "cc-chat-prefs";

export const DEFAULT_CHAT_PREFS: ChatPrefs = { cwd: null, agentId: null, model: null, effort: null, accountId: null, access: "safe", plan: false, worktree: false };

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
    worktree: o.worktree === true,
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
}
