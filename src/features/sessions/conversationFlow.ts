/**
 * Conversa de projeto = um canvas com vários terminais. Trocar de conversa SALVA os terminais da atual (agente,
 * sessão, conta, skills, posição e conexões) e os FECHA, para não acumular terminais abertos; abrir uma conversa
 * salva reabre cada terminal retomando a sessão, no mesmo lugar do canvas.
 *
 * Aqui só orquestra: a lógica pura está em `conversationModel.ts` e a persistência no backend.
 */
import i18n from "i18next";
import { AlertaToast } from "@/shared/ui/alerts";

import { boardKeyOfTab, canvasActions, conversationBoardKey, useCanvasStore } from "@/features/canvas/store";
import { nextFreeBox, type Box } from "@/features/canvas/geometry";
import { attachSkillsToTab, tabSkillIds } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { flushPendingSave } from "@/features/tabs/persistence";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { sustainedTabIds } from "@/features/terminal/activity";

import {
  activeAgentWork, conversationTitle, firstToActivate, parseConversationSnapshot, pickRestoreOrder, snapshotConversation,
  type ConversationRow,
} from "./conversationModel";
import { activeConversationFor, sameProject, useConversationsStore } from "./conversationsStore";
import { createConversation, setActiveConversation, updateConversation } from "./ipc.projectConversations";
import { refreshSessionTitle } from "./sessionTitle";
import { confirmSwitchWork, type SwitchIntent } from "./switchConfirm";

export interface FlowContext {
  workspaceId: string;
  /** A pasta do projeto onde a conversa mora (a do workspace aberto). */
  cwd: string;
  /** A chave do projeto (a raiz do repo): agrupa as conversas dele. */
  projectKey: string;
}

/** As abas que pertencem ao canvas desta conversa (são nós dele). */
export function tabsOfConversation(row: ConversationRow): Tab[] {
  const { tabs } = useTabsStore.getState();
  const boards = useCanvasStore.getState().boards;
  const key = conversationBoardKey(row.cwd, row.id);
  return tabs.filter((tab) => boardKeyOfTab(tab, boards) === key);
}

/** O snapshot dos terminais abertos da conversa: sessão, conta, skills, posição e conexões. */
async function snapshotOf(row: ConversationRow, tabs: Tab[], refreshTitles: boolean) {
  const named = refreshTitles ? await Promise.all(tabs.map(async (tab) => ({ ...tab, title: await refreshSessionTitle(tab) }))) : tabs;
  const skills = new Map(await Promise.all(tabs.map(async (tab) => [tab.id, await tabSkillIds(tab.id).catch(() => [] as string[])] as const)));
  const board = useCanvasStore.getState().boards[conversationBoardKey(row.cwd, row.id)];
  return snapshotConversation(
    named,
    board?.nodes ?? {},
    (id) => skills.get(id) ?? [],
    board?.roles ?? {},
    board?.edges ?? [],
    board?.orchestrators ?? [],
  );
}

/**
 * Grava, sem fechar nada, o snapshot das conversas ativas (chamado pelos checkpoints): se o app cair ou as abas
 * forem fechadas na mão, a conversa ainda sabe quais terminais tinha.
 */
export async function saveActiveSnapshots(): Promise<void> {
  const rows = useConversationsStore.getState().rows.filter((r) => r.state === "active");
  for (const row of rows) {
    const tabs = tabsOfConversation(row);
    // Só vale gravar quando há sessão identificada em algum terminal (senão não há o que retomar).
    if (tabs.length === 0 || !tabs.some((tab) => tab.sessionId)) continue;
    const snapshot = await snapshotOf(row, tabs, false);
    useConversationsStore.getState().upsert(await updateConversation(row.id, { terminals: snapshot }));
  }
}

/**
 * Salva a conversa (snapshot dos terminais) e fecha os terminais dela. Devolve `false` se a pessoa desistiu por
 * haver agentes trabalhando. As sessões dos agentes continuam no disco e voltam com `--resume`.
 */
export async function hibernateConversation(row: ConversationRow, _ctx: FlowContext, intent: SwitchIntent = "open"): Promise<boolean> {
  const tabs = tabsOfConversation(row);
  const working = activeAgentWork(tabs, (id) => sustainedTabIds().includes(id));
  if (working.length > 0 && !(await confirmSwitchWork(working, intent))) return false;

  // Títulos reais das sessões antes de fechar (depois a aba some).
  const snapshot = await snapshotOf(row, tabs, true);
  const title = row.customTitle ? row.title ?? undefined : conversationTitle(row, snapshot.terminals);
  // Sem terminais abertos (foram fechados na mão), o snapshot que já estava salvo não é sobrescrito por um vazio.
  const saved = await updateConversation(row.id, {
    state: "saved",
    ...(tabs.length > 0 ? { terminals: snapshot } : {}),
    ...(title && tabs.length > 0 ? { title } : {}),
  });
  useConversationsStore.getState().upsert(saved);
  // Quem pede para trocar quer ter certeza de que nada se perdeu: a conversa está na lista, para abrir quando quiser.
  if (tabs.length > 0 && intent !== "delete") {
    AlertaToast(i18n.t("conversations.switch.savedTitle"), i18n.t("conversations.switch.saved", { title: conversationTitle(saved, snapshot.terminals) }), "success", 4500);
  }

  const close = useTabsStore.getState().closeTab;
  for (const tab of tabs) close(tab.id);
  // O arquivamento das sessões acontece ao salvar o estado sem as abas.
  await flushPendingSave();
  return true;
}

/** Reabre os terminais de uma conversa salva, retomando as sessões, no lugar em que estavam. */
async function restoreTerminals(row: ConversationRow): Promise<string | null> {
  const snapshot = parseConversationSnapshot(row.terminals);
  const ordered = pickRestoreOrder(snapshot.terminals);
  const key = conversationBoardKey(row.cwd, row.id);
  const { addTab } = useTabsStore.getState();
  const created = new Map<number, string>();

  for (const terminal of ordered) {
    const tabId = addTab({
      cwd: row.cwd,
      agent: { id: terminal.agentId, label: terminal.agentLabel, command: terminal.command, available: true },
      title: terminal.title,
      titleIsCustom: terminal.titleIsCustom || undefined,
      sessionId: terminal.sessionId ?? undefined,
      accountId: terminal.accountId ?? undefined,
      prelaunch: terminal.prelaunch,
    });
    created.set(snapshot.terminals.indexOf(terminal), tabId);
    // O nó entra no canvas DESTA conversa (é isso que liga a aba a ela), na posição em que estava.
    const existing = Object.values(useCanvasStore.getState().boards[key]?.nodes ?? {});
    canvasActions.placeNode(key, tabId, terminal.box ?? nextFreeBox(existing));
    if (terminal.orchestrator) canvasActions.toggleOrchestrator(key, tabId);
    if (terminal.skillIds.length > 0) {
      // Os links das skills têm que existir antes de o agente subir (veja `attachSkillsToTab`).
      registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, useTabsStore.getState().workspaceId, terminal.skillIds));
    }
  }
  for (const [a, b] of snapshot.links) {
    const from = created.get(a);
    const to = created.get(b);
    if (from && to) canvasActions.connect(key, from, to);
  }
  const first = firstToActivate(ordered);
  return first >= 0 ? created.get(snapshot.terminals.indexOf(ordered[first])) ?? null : null;
}

/**
 * O que se abre numa pasta que tem uma conversa ativa entra no canvas DELA (é isso que o liga à conversa, e é
 * o que a salva e fecha quando se troca de conversa). Sem conversa ativa, não faz nada. `box` é o retângulo
 * pedido (desenhado no canvas), se houver; senão, o próximo lugar livre.
 */
export function joinActiveConversation(tabId: string, cwd: string, box?: Box | null): boolean {
  const row = activeConversationFor(useConversationsStore.getState().rows, cwd);
  if (!row) return false;
  const key = conversationBoardKey(row.cwd, row.id);
  const existing = Object.values(useCanvasStore.getState().boards[key]?.nodes ?? {});
  canvasActions.placeNode(key, tabId, box ?? nextFreeBox(existing));
  return true;
}

/**
 * Tudo o que se abre numa área de trabalho é dela: as abas de agente soltas nas pastas do projeto (abertas sem
 * conversa ativa, ou de antes desta regra) entram na conversa ativa, que nasce aqui se não houver. Elas levam o
 * lugar no canvas, as ligações, o papel e a coroa, e o modo (abas ou canvas) da pasta.
 */
export async function adoptLooseTabs(ctx: FlowContext, tabIds: string[]): Promise<ConversationRow | null> {
  const loose = useTabsStore.getState().tabs.filter((tab) => tabIds.includes(tab.id));
  if (loose.length === 0) return null;
  let row = activeConversationOf(ctx.projectKey);
  if (!row) {
    row = await createConversation(ctx.workspaceId, ctx.projectKey, ctx.cwd);
    await setActiveConversation(ctx.workspaceId, ctx.projectKey, row.id);
    await useConversationsStore.getState().load(ctx.workspaceId);
  }
  const to = conversationBoardKey(row.cwd, row.id);
  const byBoard = new Map<string, string[]>();
  for (const tab of loose) {
    const from = boardKeyOfTab(tab);
    if (from !== to) byBoard.set(from, [...(byBoard.get(from) ?? []), tab.id]);
  }
  for (const [from, ids] of byBoard) canvasActions.moveTerminals(from, to, ids);
  return row;
}

/** A conversa ativa do projeto (a que tem os terminais abertos agora), se houver. */
export function activeConversationOf(projectKey: string): ConversationRow | null {
  return useConversationsStore.getState().rows.find((r) => sameProject(r.projectKey, projectKey) && r.state === "active") ?? null;
}

/** Abre uma conversa salva: antes salva e fecha a ativa. Devolve o id da aba a ativar, ou `null`. */
export async function openConversation(row: ConversationRow, ctx: FlowContext): Promise<{ ok: boolean; tabId: string | null }> {
  const current = activeConversationOf(ctx.projectKey);
  if (current && current.id !== row.id && !(await hibernateConversation(current, ctx, "open"))) return { ok: false, tabId: null };
  if (row.state === "active" && tabsOfConversation(row).length > 0) {
    return { ok: true, tabId: tabsOfConversation(row)[0].id };
  }
  await setActiveConversation(ctx.workspaceId, ctx.projectKey, row.id);
  await useConversationsStore.getState().load(ctx.workspaceId);
  const tabId = await restoreTerminals(row);
  const touched = await updateConversation(row.id, { touch: true });
  useConversationsStore.getState().upsert(touched);
  if (tabId) useTabsStore.getState().activateTab(tabId);
  return { ok: true, tabId };
}

/** Começa uma conversa nova (vazia): salva e fecha a ativa; quem chama abre o assistente de agente. */
export async function startConversation(ctx: FlowContext): Promise<ConversationRow | null> {
  const current = activeConversationOf(ctx.projectKey);
  if (current && !(await hibernateConversation(current, ctx, "new"))) return null;
  const row = await createConversation(ctx.workspaceId, ctx.projectKey, ctx.cwd);
  await setActiveConversation(ctx.workspaceId, ctx.projectKey, row.id);
  await useConversationsStore.getState().load(ctx.workspaceId);
  return row;
}
