import { useMemo } from "react";
import { create } from "zustand";

import { answerTerminalPrompt } from "@/features/canvas/useTerminalPrompts";
import type { TerminalPromptItem } from "@/features/canvas/teamFeedModel";
import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { getSetting, setSetting } from "@/shared/ipc/settings";

import { sendToConversation } from "../chatActions";
import { chatPermissionNotify } from "../ipc";
import { useChatLive } from "../liveStore";
import { EMPTY_LIVE } from "../structured/model";
import { answerRequest, sendToThread, useStructured } from "../structured/store";
import { teamVerdictForAsk } from "../team/teamPermissions";
import { useTeamStore } from "../team/teamStore";
import { fleetAsk, threadAsks, tuiAsk } from "./askSources";
import { parseRules, RULES_KEY, sortAsks, type AskFilter, type PendingAsk, type PermissionRule } from "./permissionModel";

/**
 * O store único dos pedidos de permissão (prancheta 14): o que cada fonte tem pendente vira um
 * `PendingAsk` (ver `askSources.ts`), e responder pela caixa ou pelo cartão do fio usa o caminho que
 * cada fonte já tinha (responder ao protocolo, a tecla da TUI, a decisão da frota). As regras
 * "Sempre permitir" ficam nos settings (`chat.permissions.rules`), sem tabela nova.
 */
interface PermissionsState {
  rules: PermissionRule[];
  rulesLoaded: boolean;
  inboxOpen: boolean;
  filter: AskFilter;
  /** O pedido em foco na caixa (J/K). */
  selected: string | null;
  /** Os diálogos que as TUIs mostram agora (lidos da tela pelo `PermissionsManager`). */
  tui: TerminalPromptItem[];
  /** Respondidos aqui e ainda na tela da TUI (somem já, antes da próxima leitura). */
  answered: Record<string, true>;
}

export const usePermissions = create<PermissionsState>(() => ({
  rules: [], rulesLoaded: false, inboxOpen: false, filter: "all", selected: null, tui: [], answered: {},
}));

export function setInboxOpen(open: boolean): void {
  usePermissions.setState({ inboxOpen: open });
}

export function toggleInbox(): void {
  usePermissions.setState((s) => ({ inboxOpen: !s.inboxOpen }));
}

export function setAskFilter(filter: AskFilter): void {
  usePermissions.setState({ filter });
}

export function selectAsk(id: string | null): void {
  usePermissions.setState({ selected: id });
}

/** Os diálogos das TUIs da última leitura. Esquece os "respondidos" que já saíram da tela. */
export function setTuiPrompts(tui: TerminalPromptItem[]): void {
  usePermissions.setState((s) => {
    const live = new Set(tui.map((p) => `tui:${p.tabId}:${p.prompt.signature}`));
    const answered = Object.fromEntries(Object.keys(s.answered).filter((id) => !id.startsWith("tui:") || live.has(id)).map((id) => [id, true as const]));
    return { tui, answered };
  });
}

export async function loadRules(): Promise<void> {
  const raw = await getSetting(RULES_KEY).catch(() => null);
  usePermissions.setState({ rules: parseRules(raw), rulesLoaded: true });
}

function saveRules(rules: PermissionRule[]): void {
  usePermissions.setState({ rules });
  setSetting(RULES_KEY, JSON.stringify(rules)).catch(console.error);
}

/** Acrescenta uma regra (sem repetir a mesma). */
export function addRule(rule: Omit<PermissionRule, "id" | "createdAt">): void {
  const { rules } = usePermissions.getState();
  if (rules.some((r) => r.kind === rule.kind && r.pattern === rule.pattern && r.agentId === rule.agentId)) return;
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now()}`;
  saveRules([...rules, { ...rule, id, createdAt: Date.now() }]);
}

export function updateRule(id: string, patch: Partial<Omit<PermissionRule, "id">>): void {
  saveRules(usePermissions.getState().rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export function removeRule(id: string): void {
  saveRules(usePermissions.getState().rules.filter((r) => r.id !== id));
}

export type AskDecision = "allow" | "allowSession" | "deny";

/** Quanto esperar depois do "negar" na TUI para colar a resposta (o diálogo precisa fechar). */
const REPLY_DELAY_MS = 400;

/**
 * Responde um pedido pelo caminho da fonte dele. `reply` = "Responder…": nega e manda o texto ao
 * agente (o que fazer em vez disso).
 */
export function answerAsk(ask: PendingAsk, decision: AskDecision, reply?: string): void {
  const text = reply?.trim();
  const ref = ask.ref;
  usePermissions.setState((s) => ({ answered: { ...s.answered, [ask.id]: true }, selected: s.selected === ask.id ? null : s.selected }));
  if (ref.source === "thread") {
    answerRequest(ref.threadId, ref.requestId, decision);
    if (text) sendToThread(ref.threadId, text);
    return;
  }
  if (ref.source === "tui") {
    const item = usePermissions.getState().tui.find((p) => p.tabId === ref.tabId && p.prompt.signature === ref.signature);
    const choices = item?.prompt.choices ?? [];
    const choice = choices.find((c) => c.id === decision) ?? (decision === "allowSession" ? choices.find((c) => c.id === "allow") : undefined);
    if (choice) answerTerminalPrompt(ref.tabId, choice);
    if (text) window.setTimeout(() => sendToConversation(ref.tabId, text), REPLY_DELAY_MS);
    return;
  }
  useRunsStore.getState().decideApproval(ref.approvalId, decision !== "deny", false).catch(console.error);
}

/**
 * O que a política do time decide sozinha para um pedido (ver `team/teamPermissions.ts`): `allow`,
 * `deny`, ou `null` = vai às regras e à pessoa (fora de time, o orquestrador, ou a política pergunta).
 * Risco alto nunca sai `allow`.
 */
export function teamDecision(ask: PendingAsk): "allow" | "deny" | null {
  const verdict = teamVerdictForAsk(useTeamStore.getState().teams, ask);
  return verdict === "allow" || verdict === "deny" ? verdict : null;
}

/** "Sempre permitir <padrão>": guarda a regra (para este agente) e permite este pedido. */
export function alwaysAllow(ask: PendingAsk, pattern: string): void {
  addRule({ kind: ask.kind, pattern, agentId: ask.agentId });
  answerAsk(ask, "allow");
}

/**
 * Todos os pedidos pendentes, de todas as fontes, o mais antigo primeiro. As abas de shell não
 * pedem nada; os respondidos aqui somem na hora.
 */
export function usePendingAsks(): PendingAsk[] {
  const threads = useStructured((s) => s.threads);
  const live = useStructured((s) => s.live);
  const tui = usePermissions((s) => s.tui);
  const answered = usePermissions((s) => s.answered);
  const tabs = useTabsStore((s) => s.tabs);
  const detected = useTabsStore((s) => s.detectedAgents);
  const turns = useChatLive((s) => s.turn);
  const awaiting = useChatLive((s) => s.awaiting);
  const approvals = useRunsStore((s) => s.approvals);
  const tasks = useRunsStore((s) => s.tasks);
  return useMemo(() => {
    const label = (id: string) => detected.find((a) => a.id === id)?.label ?? id;
    const fromThreads = threads.filter((th) => th.state === "active").flatMap((th) => {
      const l = live[th.id] ?? EMPTY_LIVE;
      return threadAsks(th, l.requests, l.items, label);
    });
    const fromTui = tui.flatMap((item) => {
      const tab = tabs.find((t) => t.id === item.tabId);
      if (!tab || tab.agentId === SHELL_AGENT_ID) return [];
      const tools = turns[tab.id]?.tools ?? [];
      const pending = tools[tools.length - 1] ?? (awaiting[tab.id] ? { name: "", summary: awaiting[tab.id]! } : null);
      return [tuiAsk({ id: tab.id, title: tab.title, cwd: tab.cwd, agentId: tab.agentId, agentLabel: tab.agentLabel }, item.prompt, item.atMs, pending)];
    });
    const fromFleet = approvals.map((a) => fleetAsk(a, tasks.find((t) => t.id === a.taskId), label));
    return sortAsks([...fromThreads, ...fromTui, ...fromFleet].filter((a) => !answered[a.id]));
  }, [threads, live, tui, answered, tabs, detected, turns, awaiting, approvals, tasks]);
}

/** O aviso do sistema de um pedido novo (só aparece com o app sem foco; ver `notifier.rs`). */
export function notifyAsk(title: string, body: string): void {
  chatPermissionNotify(title, body).catch(() => undefined);
}
