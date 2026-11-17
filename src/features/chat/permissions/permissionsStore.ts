import { useMemo } from "react";
import { create } from "zustand";

import i18n from "@/i18n";
import { answerTerminalPrompt } from "@/features/canvas/useTerminalPrompts";
import type { TerminalPromptItem } from "@/features/canvas/teamFeedModel";
import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { AlertaToast } from "@/shared/ui/alerts";

import { sendToConversation } from "../chatActions";
import { chatPermissionNotify } from "../ipc";
import { useChatLive } from "../liveStore";
import { unsnoozeConversation } from "../shelf";
import { EMPTY_LIVE } from "../structured/model";
import { answerRequest, sendToThread, useStructured } from "../structured/store";
import { teamVerdictForAsk } from "../team/teamPermissions";
import { useTeamStore } from "../team/teamStore";
import { fleetAsk, threadAsks, tuiAsk } from "./askSources";
import { chatPermissionRuleAdd, chatPermissionRuleRemove, chatPermissionRuleUpdate, chatPermissionRules, ruleOf } from "./ipc";
import { sortAsks, type AskFilter, type PendingAsk, type PermissionRule } from "./permissionModel";

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

/**
 * Um aviso de falha no canto. Não repete o erro técnico: diz o que não mudou e deixa a tela no estado gravado.
 */
function avisoDeFalha(key: string): void {
  void AlertaToast(i18n.t("chat.permission.failedTitle"), i18n.t(key), "warning", 6000);
}

/**
 * Lê as regras do banco (a fonte da verdade, também do backend). Falha de leitura não é "sem regras": a lista que já
 * estava na tela fica, `rulesLoaded` não sobe, e a pessoa é avisada (sem regras lidas, nenhum pedido é decidido sozinho).
 */
export async function loadRules(): Promise<void> {
  try {
    const rows = await chatPermissionRules();
    usePermissions.setState({ rules: rows.map(ruleOf), rulesLoaded: true });
  } catch {
    avisoDeFalha("chat.permission.ruleLoadFailed");
  }
}

/** Acrescenta uma regra (sem repetir a mesma): só a pessoa, pela tela. */
export function addRule(rule: Omit<PermissionRule, "id" | "createdAt">): void {
  const { rules } = usePermissions.getState();
  if (rules.some((r) => r.kind === rule.kind && r.pattern === rule.pattern && r.agentId === rule.agentId)) return;
  chatPermissionRuleAdd({ kind: rule.kind, pattern: rule.pattern, agentId: rule.agentId }).then(() => loadRules(), () => avisoDeFalha("chat.permission.ruleSaveFailed"));
}

/**
 * Muda uma regra. A tela só mostra a mudança depois de o banco confirmar: o padrão que vale para os pedidos é o
 * gravado. Se a gravação falhar, a regra segue como estava e a pessoa é avisada.
 */
export async function updateRule(id: string, patch: Partial<Omit<PermissionRule, "id">>): Promise<void> {
  const body: { pattern?: string; agentId?: string; anyAgent?: boolean } = {};
  if (patch.pattern !== undefined) body.pattern = patch.pattern;
  if (patch.agentId !== undefined) {
    if (patch.agentId === null) body.anyAgent = true;
    else body.agentId = patch.agentId;
  }
  // `false` do backend é falha (a regra não existe, ou não foi gravada): não é sucesso.
  const saved = await chatPermissionRuleUpdate(id, body).catch(() => false);
  if (saved !== true) {
    avisoDeFalha("chat.permission.ruleSaveFailed");
    await loadRules();
    return;
  }
  usePermissions.setState((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  await loadRules();
}

/**
 * Apaga uma regra. Ela só sai da tela depois de o banco confirmar. Se a remoção falhar, a regra continua valendo:
 * fica na tela e a pessoa é avisada.
 */
export async function removeRule(id: string): Promise<void> {
  // `false` do backend é falha: a regra não saiu do banco, então não sai da tela.
  const removed = await chatPermissionRuleRemove(id).catch(() => false);
  if (removed !== true) {
    avisoDeFalha("chat.permission.ruleSaveFailed");
    await loadRules();
    return;
  }
  usePermissions.setState((s) => ({ rules: s.rules.filter((r) => r.id !== id) }));
  await loadRules();
}

export type AskDecision = "allow" | "allowSession" | "deny";

/** Quanto esperar depois do "negar" na TUI para colar a resposta (o diálogo precisa fechar). */
const REPLY_DELAY_MS = 400;

/** Pedidos com uma resposta em andamento: um segundo clique no mesmo pedido não manda outra resposta. */
const answering = new Set<string>();

/**
 * Responde um pedido pelo caminho da fonte dele. `reply` = "Responder…": nega e manda o texto ao agente (o que fazer
 * em vez disso). O pedido só sai da caixa depois de a fonte confirmar; se a resposta falhar, ele fica e a pessoa vê o
 * aviso. Devolve `true` quando a fonte confirmou.
 */
export async function answerAsk(ask: PendingAsk, decision: AskDecision, reply?: string): Promise<boolean> {
  if (answering.has(ask.id)) return false;
  answering.add(ask.id);
  try {
    if (ask.conversation) unsnoozeConversation(ask.conversation);
    const ok = await deliver(ask, decision, reply?.trim());
    if (ok) usePermissions.setState((s) => ({ answered: { ...s.answered, [ask.id]: true }, selected: s.selected === ask.id ? null : s.selected }));
    return ok;
  } finally {
    answering.delete(ask.id);
  }
}

/** Manda a decisão pelo caminho da fonte e diz se ela confirmou. */
async function deliver(ask: PendingAsk, decision: AskDecision, text: string | undefined): Promise<boolean> {
  const ref = ask.ref;
  if (ref.source === "thread") {
    // `answerRequest` só tira o pedido da conversa depois da confirmação do backend.
    if (!(await answerRequest(ref.threadId, ref.requestId, decision))) {
      avisoDeFalha("chat.permission.answerFailed");
      return false;
    }
    if (text) sendToThread(ref.threadId, text);
    return true;
  }
  if (ref.source === "tui") {
    const item = usePermissions.getState().tui.find((p) => p.tabId === ref.tabId && p.prompt.signature === ref.signature);
    const choices = item?.prompt.choices ?? [];
    const choice = choices.find((c) => c.id === decision) ?? (decision === "allowSession" ? choices.find((c) => c.id === "allow") : undefined);
    // Sem a opção, ou com a tela já trocada, `answerTerminalPrompt` não manda a tecla: o pedido fica, e a pessoa é avisada.
    if (!choice || !answerTerminalPrompt(ref.tabId, choice, ref.signature)) {
      avisoDeFalha("chat.permission.ttyChanged");
      return false;
    }
    if (text) window.setTimeout(() => sendToConversation(ref.tabId, text), REPLY_DELAY_MS);
    return true;
  }
  try {
    await useRunsStore.getState().decideApproval(ref.approvalId, decision !== "deny", false);
    return true;
  } catch {
    avisoDeFalha("chat.permission.answerFailed");
    return false;
  }
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
  void answerAsk(ask, "allow");
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
