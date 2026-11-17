import { useMemo } from "react";
import { create } from "zustand";

import { answerTerminalPrompt } from "@/features/canvas/useTerminalPrompts";
import type { TerminalPromptItem } from "@/features/canvas/teamFeedModel";
import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

import { sendToConversation } from "../chatActions";
import { chatPermissionNotify } from "../ipc";
import { useChatLive } from "../liveStore";
import { unsnoozeConversation } from "../shelf";
import { EMPTY_LIVE, type ThreadLive } from "../structured/model";
import type { ThreadRow } from "../structured/ipc";
import { answerRequest, sendToThread, useStructured } from "../structured/store";
import { teamVerdictForAsk } from "../team/teamPermissions";
import { useTeamStore } from "../team/teamStore";
import { fleetAsk, threadAsks, tuiAsk } from "./askSources";
import { chatPermissionRuleAdd, chatPermissionRuleRemove, chatPermissionRuleUpdate, chatPermissionRules, ruleOf } from "./ipc";
import { sortAsks, waitingAgents, type AskFilter, type PendingAsk, type PermissionRule } from "./permissionModel";

/**
 * O store único dos pedidos de permissão (prancheta 14): o que cada fonte tem pendente vira um
 * `PendingAsk` (ver `askSources.ts`), e responder pela caixa ou pelo cartão do fio usa o caminho que
 * cada fonte já tinha (responder ao protocolo, a tecla da TUI, a decisão da frota). As regras
 * "Sempre permitir" ficam no banco (`chat_permission_rule`, lidas também pelo backend, que decide os pedidos das conversas por protocolo).
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

/** A primeira leitura da TUI define o baseline; só um prompt novo depois dela acorda a conversa. */
let tuiPromptsInitialized = false;

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
  const previous = usePermissions.getState().tui;
  const known = new Set(previous.map((p) => `tui:${p.tabId}:${p.prompt.signature}`));
  const current = new Set(tui.map((p) => `tui:${p.tabId}:${p.prompt.signature}`));
  const isInitialSnapshot = !tuiPromptsInitialized;
  tuiPromptsInitialized = true;
  const newlyRequested = isInitialSnapshot ? [] : tui.filter((p) => !known.has(`tui:${p.tabId}:${p.prompt.signature}`));
  const answeredInTui = previous.filter((p) => !current.has(`tui:${p.tabId}:${p.prompt.signature}`));
  usePermissions.setState((s) => {
    const live = new Set(tui.map((p) => `tui:${p.tabId}:${p.prompt.signature}`));
    const answered = Object.fromEntries(Object.keys(s.answered).filter((id) => !id.startsWith("tui:") || live.has(id)).map((id) => [id, true as const]));
    return { tui, answered };
  });
  for (const prompt of newlyRequested) unsnoozeConversation(prompt.tabId);
  for (const prompt of answeredInTui) unsnoozeConversation(prompt.tabId);
}

/** Lê as regras do banco (a fonte da verdade, também do backend). */
export async function loadRules(): Promise<void> {
  const rows = await chatPermissionRules().catch(() => null);
  usePermissions.setState({ rules: (rows ?? []).map(ruleOf), rulesLoaded: true });
}

/** Acrescenta uma regra (sem repetir a mesma): só a pessoa, pela tela. */
export function addRule(rule: Omit<PermissionRule, "id" | "createdAt">): void {
  const { rules } = usePermissions.getState();
  if (rules.some((r) => r.kind === rule.kind && r.pattern === rule.pattern && r.agentId === rule.agentId)) return;
  chatPermissionRuleAdd({ kind: rule.kind, pattern: rule.pattern, agentId: rule.agentId }).then(() => loadRules(), console.error);
}

export function updateRule(id: string, patch: Partial<Omit<PermissionRule, "id">>): void {
  const body: { pattern?: string; agentId?: string; anyAgent?: boolean } = {};
  if (patch.pattern !== undefined) body.pattern = patch.pattern;
  if (patch.agentId !== undefined) {
    if (patch.agentId === null) body.anyAgent = true;
    else body.agentId = patch.agentId;
  }
  // Mostra já; o banco confirma (e corrige) na releitura.
  usePermissions.setState((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  chatPermissionRuleUpdate(id, body).then(() => loadRules(), console.error);
}

export function removeRule(id: string): void {
  usePermissions.setState((s) => ({ rules: s.rules.filter((r) => r.id !== id) }));
  chatPermissionRuleRemove(id).then(() => loadRules(), console.error);
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
  if (ask.conversation) unsnoozeConversation(ask.conversation);
  const markAnswered = () => usePermissions.setState((s) => ({ answered: { ...s.answered, [ask.id]: true }, selected: s.selected === ask.id ? null : s.selected }));
  if (ref.source === "thread") {
    // O pedido só sai da caixa quando o backend aceita a resposta; recusado, continua aqui com o erro da conversa.
    void answerRequest(ref.threadId, ref.requestId, decision).then((accepted) => {
      if (!accepted) return;
      markAnswered();
      if (text) void sendToThread(ref.threadId, text);
    });
    return;
  }
  markAnswered();
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
/** As fontes que compõem os pedidos pendentes (o que `usePendingAsks` e a contagem da barra leem). */
type AskSources = {
  threads: ThreadRow[];
  live: Record<string, ThreadLive>;
  tui: PermissionsState["tui"];
  answered: PermissionsState["answered"];
  tabs: ReturnType<typeof useTabsStore.getState>["tabs"];
  detected: ReturnType<typeof useTabsStore.getState>["detectedAgents"];
  turns: ReturnType<typeof useChatLive.getState>["turn"];
  awaiting: ReturnType<typeof useChatLive.getState>["awaiting"];
  approvals: ReturnType<typeof useRunsStore.getState>["approvals"];
  tasks: ReturnType<typeof useRunsStore.getState>["tasks"];
};

/** Os pedidos pendentes de todas as fontes, o mais antigo primeiro. Pura sobre as fontes lidas. */
export function pendingAsksOf(src: AskSources): PendingAsk[] {
  const label = (id: string) => src.detected.find((a) => a.id === id)?.label ?? id;
  const fromThreads = src.threads.filter((th) => th.state === "active").flatMap((th) => {
    const l = src.live[th.id] ?? EMPTY_LIVE;
    return threadAsks(th, l.requests, l.items, label);
  });
  const fromTui = src.tui.flatMap((item) => {
    const tab = src.tabs.find((t) => t.id === item.tabId);
    if (!tab || tab.agentId === SHELL_AGENT_ID) return [];
    const tools = src.turns[tab.id]?.tools ?? [];
    const pending = tools[tools.length - 1] ?? (src.awaiting[tab.id] ? { name: "", summary: src.awaiting[tab.id]! } : null);
    return [tuiAsk({ id: tab.id, title: tab.title, cwd: tab.cwd, agentId: tab.agentId, agentLabel: tab.agentLabel }, item.prompt, item.atMs, pending)];
  });
  const fromFleet = src.approvals.map((a) => fleetAsk(a, src.tasks.find((t) => t.id === a.taskId), label));
  return sortAsks([...fromThreads, ...fromTui, ...fromFleet].filter((a) => !src.answered[a.id]));
}

/**
 * Todos os pedidos pendentes, de todas as fontes, o mais antigo primeiro. As abas de shell não
 * pedem nada; os respondidos aqui somem na hora. Assina o `live` inteiro: quem mostra a lista (a caixa, o cartão)
 * refaz a lista a cada pedaço de texto; quem só conta pedidos usa `usePendingAskCounts`.
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
  return useMemo(
    () => pendingAsksOf({ threads, live, tui, answered, tabs, detected, turns, awaiting, approvals, tasks }),
    [threads, live, tui, answered, tabs, detected, turns, awaiting, approvals, tasks],
  );
}

/**
 * Um texto curto com o que a contagem de pedidos lê dos registros: o id de cada conversa ativa, e os pedidos dela (id,
 * tipo, estado e título). Muda só quando um pedido muda, nunca com o texto do streaming. Pura.
 */
function requestsSignature(live: Record<string, ThreadLive>, threads: ThreadRow[]): string {
  return threads.filter((th) => th.state === "active").map((th) =>
    `${th.id}[${(live[th.id]?.requests ?? []).map((r) => `${r.id}/${r.kind}/${r.state}/${r.title}`).join(";")}]`).join("|");
}

/**
 * A contagem de pedidos por conversa e quantas conversas esperam a pessoa (a barra lateral). Assina só a assinatura dos
 * pedidos, então o texto que chega numa conversa não re-renderiza quem só conta. Os arquivos das edições (que vêm dos
 * itens) ficam para a lista; a contagem não depende deles.
 */
export function usePendingAskCounts(): { waiting: number; byConversation: Record<string, number> } {
  const threads = useStructured((s) => s.threads);
  const requests = useStructured((s) => requestsSignature(s.live, s.threads));
  const tui = usePermissions((s) => s.tui);
  const answered = usePermissions((s) => s.answered);
  const tabs = useTabsStore((s) => s.tabs);
  const detected = useTabsStore((s) => s.detectedAgents);
  const turns = useChatLive((s) => s.turn);
  const awaiting = useChatLive((s) => s.awaiting);
  const approvals = useRunsStore((s) => s.approvals);
  const tasks = useRunsStore((s) => s.tasks);
  return useMemo(() => {
    const asks = pendingAsksOf({ threads, live: useStructured.getState().live, tui, answered, tabs, detected, turns, awaiting, approvals, tasks });
    const byConversation: Record<string, number> = {};
    for (const a of asks) if (a.conversation) byConversation[a.conversation] = (byConversation[a.conversation] ?? 0) + 1;
    return { waiting: waitingAgents(asks), byConversation };
  }, [threads, requests, tui, answered, tabs, detected, turns, awaiting, approvals, tasks]);
}

/** O aviso do sistema de um pedido novo (só aparece com o app sem foco; ver `notifier.rs`). */
export function notifyAsk(title: string, body: string): void {
  chatPermissionNotify(title, body).catch(() => undefined);
}
