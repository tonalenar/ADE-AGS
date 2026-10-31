import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import { requestCloseItem } from "@/features/tabs/tabActions";
import { agentKey } from "@/features/tabs/layout/layoutTree";

import { openConversation } from "./chatActions";
import { toggleIn } from "./sidebar/sessionsModel";

/**
 * As seções "Adiadas" e "Concluídas" da sidebar (o snooze e o settle do T3 Code).
 *
 * - **Adiar** só tira a conversa das Ativas: o agente continua aberto.
 * - **Concluir** fecha o agente pelo caminho de sempre (`requestCloseItem`) e guarda o que basta
 *   para reabrir a MESMA conversa depois (`sessionId` + comando: a TUI retoma com `--resume`).
 *
 * Preferência desta máquina, como os painéis: vai para o `localStorage`, tolerando lixo.
 */
export interface SettledConversation {
  /** O id da aba quando foi concluída (identifica a entrada). */
  id: string;
  title: string;
  cwd: string;
  agentId: string;
  agentLabel: string;
  command: string;
  sessionId: string | null;
  accountId: string | null;
  settledAt: number;
}

/** Quantas concluídas se guardam (as mais novas). */
export const SETTLED_MAX = 30;

interface ShelfState {
  snoozed: string[];
  settled: SettledConversation[];
  /** As conversas fixadas na barra (no alto, na ordem em que foram fixadas). */
  pinned: string[];
  /** As marcadas como não lidas. */
  unread: string[];
  /** As seções da barra recolhidas (`pinned` ou `project:<nome>`). */
  collapsed: string[];
}

const EMPTY: ShelfState = { snoozed: [], settled: [], pinned: [], unread: [], collapsed: [] };

const KEY = "cc-chat-shelf";

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Lê o que veio e devolve só o que serve. Pura. */
export function parseShelf(raw: unknown): ShelfState {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const o = raw as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const snoozed = strings(o.snoozed);
  const settled = Array.isArray(o.settled)
    ? o.settled.flatMap((x): SettledConversation[] => {
      if (!x || typeof x !== "object") return [];
      const e = x as Record<string, unknown>;
      const id = str(e.id), title = str(e.title), cwd = str(e.cwd), agentId = str(e.agentId), command = str(e.command);
      if (!id || !title || !cwd || !agentId || !command) return [];
      return [{
        id, title, cwd, agentId, command,
        agentLabel: str(e.agentLabel) ?? agentId,
        sessionId: str(e.sessionId),
        accountId: str(e.accountId),
        settledAt: typeof e.settledAt === "number" ? e.settledAt : 0,
      }];
    })
    : [];
  return { snoozed, settled: settled.slice(0, SETTLED_MAX), pinned: strings(o.pinned), unread: strings(o.unread), collapsed: strings(o.collapsed) };
}

/** Acrescenta uma concluída no topo, sem repetir e com teto. Pura. */
export function addSettled(list: SettledConversation[], entry: SettledConversation): SettledConversation[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, SETTLED_MAX);
}

function load(): ShelfState {
  try {
    const raw = localStorage.getItem(KEY);
    return parseShelf(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...EMPTY };
  }
}

export const useShelf = create<ShelfState>(() => load());

useShelf.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* sem lembrar, as seções só valem nesta abertura */
  }
});

/** Fixa ou desafixa uma conversa. */
export function togglePinned(id: string): void {
  useShelf.setState((s) => ({ ...s, pinned: toggleIn(s.pinned, id) }));
}

/** Marca como não lida (`true`) ou lida (`false`). */
export function setUnread(id: string, unread: boolean): void {
  useShelf.setState((s) => (s.unread.includes(id) === unread ? s : { ...s, unread: unread ? [...s.unread, id] : s.unread.filter((x) => x !== id) }));
}

/** Troca a lista de seções recolhidas de uma vez (expandir/recolher todos). */
export function setCollapsed(ids: string[]): void {
  useShelf.setState((s) => ({ ...s, collapsed: ids }));
}

/** Recolhe ou abre uma seção da barra. */
export function toggleSection(id: string): void {
  useShelf.setState((s) => ({ ...s, collapsed: toggleIn(s.collapsed, id) }));
}

export function snoozeConversation(tabId: string): void {
  useShelf.setState((s) => (s.snoozed.includes(tabId) ? s : { ...s, snoozed: [...s.snoozed, tabId] }));
}

export function unsnoozeConversation(tabId: string): void {
  useShelf.setState((s) => ({ ...s, snoozed: s.snoozed.filter((id) => id !== tabId) }));
}

/** Conclui: guarda para reabrir e fecha o agente. */
export async function settleConversation(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  await requestCloseItem(agentKey(tabId));
  // O título pode ter sido atualizado ao fechar (ver `requestCloseItem`).
  const title = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.title ?? tab.title;
  const entry: SettledConversation = {
    id: tab.id, title, cwd: tab.cwd, agentId: tab.agentId, agentLabel: tab.agentLabel, command: tab.command,
    sessionId: tab.sessionId ?? null, accountId: tab.accountId ?? null, settledAt: Date.now(),
  };
  useShelf.setState((s) => ({ snoozed: s.snoozed.filter((id) => id !== tabId), settled: addSettled(s.settled, entry) }));
}

/** Reabre uma concluída: o agente volta retomando a mesma sessão. */
export function reopenSettled(id: string): void {
  const entry = useShelf.getState().settled.find((e) => e.id === id);
  if (!entry) return;
  const tabId = useTabsStore.getState().addTab({
    cwd: entry.cwd,
    agent: { id: entry.agentId, label: entry.agentLabel, command: entry.command, available: true },
    title: entry.title,
    titleIsCustom: true,
    sessionId: entry.sessionId ?? undefined,
    accountId: entry.accountId ?? undefined,
  });
  useShelf.setState((s) => ({ ...s, settled: s.settled.filter((e) => e.id !== id) }));
  openConversation(tabId);
}
