import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import { agentKey } from "@/features/tabs/layout/layoutTree";

import { openConversation } from "./chatActions";
import { moveVisibleByOne, toggleIn } from "./sidebar/sessionsModel";

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
  /** Horário local convertido para epoch; ausente/null representa o adiamento legado sem prazo. */
  snoozedUntil?: Record<string, number | null>;
  settled: SettledConversation[];
  /** As conversas fixadas na barra (no alto, na ordem em que foram fixadas). */
  pinned: string[];
  /** Ordem manual das conversas ativas, por projeto. */
  orderBySection: Record<string, string[]>;
  /** As marcadas como não lidas. */
  unread: string[];
  /** As seções da barra recolhidas (`pinned` ou `project:<nome>`). */
  collapsed: string[];
}

const EMPTY: ShelfState = { snoozed: [], settled: [], pinned: [], orderBySection: {}, unread: [], collapsed: [] };

const KEY = "cc-chat-shelf";

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Lê o que veio e devolve só o que serve. Pura. */
export function parseShelf(raw: unknown): ShelfState {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const o = raw as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const snoozedUntilRaw = o.snoozedUntil && typeof o.snoozedUntil === "object" && !Array.isArray(o.snoozedUntil)
    ? o.snoozedUntil as Record<string, unknown>
    : null;
  const snoozedUntil = snoozedUntilRaw
    ? Object.fromEntries(Object.entries(snoozedUntilRaw).flatMap(([id, value]) =>
      value === null || (typeof value === "number" && Number.isFinite(value) && value > 0) ? [[id, value]] : [])) as Record<string, number | null>
    : undefined;
  const snoozed = strings(o.snoozed).filter((id) => {
    const until = snoozedUntil?.[id];
    return until === undefined || until === null || until > Date.now();
  });
  if (snoozedUntil) for (const id of Object.keys(snoozedUntil)) if (!snoozed.includes(id)) delete snoozedUntil[id];
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
  const orderBySection = o.orderBySection && typeof o.orderBySection === "object" && !Array.isArray(o.orderBySection)
    ? Object.fromEntries(Object.entries(o.orderBySection).flatMap(([key, value]) => {
      const ids = strings(value);
      return key.startsWith("project:") && ids.length > 0 ? [[key, [...new Set(ids)]]] : [];
    }))
    : {};
  return {
    snoozed,
    ...(snoozedUntil ? { snoozedUntil } : {}),
    settled: settled.slice(0, SETTLED_MAX), pinned: strings(o.pinned), orderBySection, unread: strings(o.unread), collapsed: strings(o.collapsed),
  };
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

interface ArchiveState { ids: string[] }

const ARCHIVE_KEY = "cc-chat-archive";

function loadArchive(): ArchiveState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ids?: unknown }).ids)) return { ids: [] };
    return { ids: [...new Set((raw as { ids: unknown[] }).ids.filter((id): id is string => typeof id === "string"))] };
  } catch {
    return { ids: [] };
  }
}

/** Arquivar esconde a conversa da lista ativa, mas não fecha a aba nem interrompe o agente. */
export const useArchived = create<ArchiveState>(() => loadArchive());

useArchived.subscribe((state) => {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(state));
  } catch {
    /* sem lembrar, o arquivo só vale até fechar a janela */
  }
});

export function archiveConversation(id: string): void {
  useArchived.setState((s) => s.ids.includes(id) ? s : { ids: [...s.ids, id] });
}

export function restoreArchivedConversation(id: string): void {
  useArchived.setState((s) => s.ids.includes(id) ? { ids: s.ids.filter((value) => value !== id) } : s);
}

/** Fixa ou desafixa uma conversa. */
export function togglePinned(id: string): void {
  useShelf.setState((s) => ({ ...s, pinned: toggleIn(s.pinned, id) }));
}

/** Salva a ordem do menu para cima/baixo, sem descartar ids temporariamente ocultos. */
export function moveConversation(tabId: string, sectionId: string, visibleIds: string[], delta: -1 | 1): void {
  useShelf.setState((s) => {
    if (sectionId === "pinned") {
      const pinned = moveVisibleByOne(s.pinned, visibleIds, tabId, delta);
      return pinned === s.pinned ? s : { ...s, pinned };
    }
    const current = s.orderBySection[sectionId] ?? visibleIds;
    const order = moveVisibleByOne(current, visibleIds, tabId, delta);
    return order === current ? s : { ...s, orderBySection: { ...s.orderBySection, [sectionId]: order } };
  });
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function insertInVisibleOrder(allIds: string[], visibleIds: string[], tabId: string, requestedIndex: number): string[] {
  const all = allIds.filter((id) => id !== tabId);
  const visible = visibleIds.filter((id) => id !== tabId);
  const sourceIndex = visibleIds.indexOf(tabId);
  const index = Math.max(0, Math.min(visible.length, requestedIndex - (sourceIndex >= 0 && sourceIndex < requestedIndex ? 1 : 0)));
  const nextVisible = visible[index];
  const before = nextVisible ? all.indexOf(nextVisible) : -1;
  let insertAt = before;
  if (insertAt < 0) {
    const visiblePositions = visible.map((id) => all.indexOf(id)).filter((position) => position >= 0);
    insertAt = visiblePositions.length > 0 ? Math.max(...visiblePositions) + 1 : all.length;
  }
  return [...all.slice(0, insertAt), tabId, ...all.slice(insertAt)];
}

/** Move uma conversa por arraste sem alterar sua pasta ou desmontar a aba. */
export function moveConversationToSection(tabId: string, sectionId: string, visibleIds: string[], index: number): boolean {
  let changed = false;
  useShelf.setState((s) => {
    const pinned = s.pinned.filter((id) => id !== tabId);
    const orderBySection = Object.fromEntries(Object.entries(s.orderBySection)
      .flatMap(([key, ids]) => {
        const remaining = ids.filter((id) => id !== tabId);
        return remaining.length > 0 ? [[key, remaining]] : [];
      }));

    if (sectionId === "pinned") {
      const nextPinned = insertInVisibleOrder(s.pinned, visibleIds, tabId, index);
      const samePinned = sameIds(nextPinned, s.pinned);
      const sameOrders = Object.keys(orderBySection).length === Object.keys(s.orderBySection).length
        && Object.entries(orderBySection).every(([key, ids]) => ids.length === s.orderBySection[key]?.length && ids.every((id, at) => id === s.orderBySection[key]?.[at]));
      if (samePinned && sameOrders) return s;
      changed = true;
      return { ...s, pinned: nextPinned, orderBySection };
    }

    const currentTarget = orderBySection[sectionId] ?? visibleIds;
    const nextTarget = insertInVisibleOrder(currentTarget, visibleIds, tabId, index);
    const sameTarget = sameIds(nextTarget, currentTarget);
    const sameOrders = Object.keys(orderBySection).length === Object.keys(s.orderBySection).length
      && Object.entries(orderBySection).every(([key, ids]) => ids.length === s.orderBySection[key]?.length && ids.every((id, at) => id === s.orderBySection[key]?.[at]));
    const samePinned = sameIds(pinned, s.pinned);
    if (sameTarget && sameOrders && samePinned) return s;
    changed = true;
    return { ...s, pinned, orderBySection: { ...orderBySection, [sectionId]: nextTarget } };
  });
  return changed;
}

/** Desfaz uma troca de posição se o par ainda estiver adjacente na ordem visível. */
export function undoMoveConversation(tabId: string, sectionId: string, neighborId: string, visibleIds: string[]): void {
  useShelf.setState((s) => {
    const current = sectionId === "pinned" ? s.pinned : s.orderBySection[sectionId] ?? [];
    const visible = new Set(visibleIds);
    const currentVisible = current.filter((id) => visible.has(id));
    const from = currentVisible.indexOf(tabId);
    const neighbor = currentVisible.indexOf(neighborId);
    if (from < 0 || neighbor < 0 || Math.abs(from - neighbor) !== 1) return s;

    const reorderedVisible = [...currentVisible];
    [reorderedVisible[from], reorderedVisible[neighbor]] = [reorderedVisible[neighbor]!, reorderedVisible[from]!];
    let visibleIndex = 0;
    const order = current.map((id) => visible.has(id) ? reorderedVisible[visibleIndex++]! : id);
    if (sectionId === "pinned") return { ...s, pinned: order };
    return { ...s, orderBySection: { ...s.orderBySection, [sectionId]: order } };
  });
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

export function snoozeConversation(tabId: string, until: number | null = null): void {
  useShelf.setState((s) => {
    const snoozedUntil = { ...(s.snoozedUntil ?? {}) };
    if (s.snoozed.includes(tabId) && snoozedUntil[tabId] === until) return s;
    snoozedUntil[tabId] = until;
    return { ...s, snoozed: s.snoozed.includes(tabId) ? s.snoozed : [...s.snoozed, tabId], snoozedUntil };
  });
}

export function unsnoozeConversation(tabId: string): void {
  useShelf.setState((s) => {
    if (!s.snoozed.includes(tabId)) return s;
    const snoozedUntil = { ...(s.snoozedUntil ?? {}) };
    delete snoozedUntil[tabId];
    return { ...s, snoozed: s.snoozed.filter((id) => id !== tabId), snoozedUntil };
  });
}

/** Acorda adiamentos vencidos numa única passada, inclusive depois de retomar o app. */
export function expireSnoozed(now = Date.now()): void {
  useShelf.setState((s) => {
    const expired = Object.entries(s.snoozedUntil ?? {})
      .filter(([, until]) => typeof until === "number" && until <= now)
      .map(([id]) => id);
    if (expired.length === 0) return s;
    const expiredIds = new Set(expired);
    const snoozedUntil = { ...(s.snoozedUntil ?? {}) };
    for (const id of expired) delete snoozedUntil[id];
    return { ...s, snoozed: s.snoozed.filter((id) => !expiredIds.has(id)), snoozedUntil };
  });
}

/** Conclui: guarda para reabrir e fecha o agente. */
export async function settleConversation(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  // Import tardio: `tabActions` puxa a UI inteira (diálogos, i18n) e, importado por aqui, entrava em ciclo com
  // `structured/store` (que só precisa do snooze) e carregava tudo isso em quem só lê o store.
  const { requestCloseItem } = await import("@/features/tabs/tabActions");
  await requestCloseItem(agentKey(tabId));
  // O título pode ter sido atualizado ao fechar (ver `requestCloseItem`).
  const title = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.title ?? tab.title;
  const entry: SettledConversation = {
    id: tab.id, title, cwd: tab.cwd, agentId: tab.agentId, agentLabel: tab.agentLabel, command: tab.command,
    sessionId: tab.sessionId ?? null, accountId: tab.accountId ?? null, settledAt: Date.now(),
  };
  useShelf.setState((s) => {
    const snoozedUntil = { ...(s.snoozedUntil ?? {}) };
    delete snoozedUntil[tabId];
    return { ...s, snoozed: s.snoozed.filter((id) => id !== tabId), snoozedUntil, settled: addSettled(s.settled, entry) };
  });
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
