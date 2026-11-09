import { chatShellOn, useUiStore } from "@/app/uiStore";
import { homeDir } from "@tauri-apps/api/path";
import { resolveAccountChoice } from "@/features/accounts/pools";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { useSnapshotsStore } from "@/features/workspaces/snapshotsStore";
import type { AgentInfo } from "@/features/tabs/types";
import { pasteIntoTab, sendKeysToTab, sendWhenReady } from "@/features/terminal/terminalRegistry";

import { chatCommand, conversationTitle, retuneConversation, type LaunchChoice } from "./chatModel";
import { useChatLive } from "./liveStore";
import { composeIn, setComposing, useChatStore } from "./store";
import { interruptThread, useStructured } from "./structured/store";
import { assertProjectChatAgentEnabled } from "./projectChatPolicy";

export interface StartConversation extends LaunchChoice {
  cwd: string;
  agent: AgentInfo;
  prompt: string;
  /** O valor do seletor de conta: um id, um pool ou `undefined` (a conta principal). */
  account: string | undefined;
  /** O título da conversa (senão sai da primeira linha do prompt). */
  title?: string;
  /** Cria a aba sem trocar a tela: a de conversa nova continua à vista (o time ainda está sendo montado). */
  background?: boolean;
}

/**
 * Abre uma conversa: uma aba de agente com a escolha do composer, e o prompt enviado assim que a
 * TUI estiver pronta. É o mesmo caminho da tela inicial (`HomePage`) e do "+" das abas: as skills
 * do workspace entram antes de o agente subir, e a conta de um pool é decidida agora.
 */
export async function startConversation(input: StartConversation): Promise<string> {
  await assertProjectChatAgentEnabled(input.cwd, input.agent.id);
  const accountId = await resolveAccountChoice(input.agent.id, input.account);
  const command = chatCommand(input.agent.id, input.agent.command, input);
  const title = input.title ?? conversationTitle(input.prompt) ?? undefined;
  const tabs = useTabsStore.getState();
  const tabId = tabs.addTab({
    cwd: input.cwd,
    agent: { ...input.agent, command },
    title,
    titleIsCustom: title !== undefined,
    accountId,
    activate: !input.background,
  });
  registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, tabs.workspaceId, []));
  if (input.prompt.trim()) sendWhenReady(tabId, input.prompt.trim());
  if (input.background) return tabId;
  // A conversa nova é a ativa: a tela dela substitui a de conversa nova.
  useChatStore.setState({ thread: null });
  useViewTabsStore.getState().showTerminal();
  setComposing(false);
  return tabId;
}

/** Mostra uma conversa da sidebar. */
export function openConversation(tabId: string): void {
  useChatStore.setState({ thread: null });
  useTabsStore.getState().activateTab(tabId);
  useViewTabsStore.getState().showTerminal();
  setComposing(false);
}

/** Abre a tela de conversa nova (a hero com o composer). */
export function newConversation(): void {
  setComposing(true);
}

/** Abre um rascunho no projeto da conversa ou aba que está em foco. */
export function newConversationLocal(): void {
  const chat = useChatStore.getState();
  const inChatShell = chatShellOn(useUiStore.getState());
  const threadCwd = inChatShell && !chat.composing && chat.thread
    ? useStructured.getState().threads.find((thread) => thread.id === chat.thread)?.cwd
    : undefined;
  const tabs = useTabsStore.getState();
  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  const cwd = threadCwd ?? activeTab?.cwd;
  if (cwd) newConversationIn(cwd);
  else newConversation();
}

/** Abre a tela de conversa nova já no projeto `cwd` (o "+" do cabeçalho do grupo na barra). */
export function newConversationIn(cwd: string): void {
  composeIn(cwd);
}

/** Abre um rascunho na pasta pessoal, sem associá-lo a um projeto já cadastrado. */
export function newConversationWithoutProject(): void {
  void homeDir().then(newConversationIn).catch(console.error);
}

/** Interrompe somente o turno da conversa focada, sem tocar no terminal quando há um pedido pendente. */
export function stopFocusedConversation(): boolean {
  const chat = useChatStore.getState();
  const inChatShell = chatShellOn(useUiStore.getState());
  if (inChatShell && chat.composing) return false;

  const threadId = inChatShell ? chat.thread : null;
  if (threadId) {
    const live = useStructured.getState().live[threadId];
    if (live?.phase !== "working" || live.requests.length > 0) return false;
    interruptThread(threadId);
    return true;
  }

  const tabId = useTabsStore.getState().activeTabId;
  if (!tabId) return false;
  const live = useChatLive.getState();
  if (live.phase[tabId] !== "working" || live.question[tabId] || live.awaiting[tabId]) return false;
  return sendKeysToTab(tabId, "\u001b");
}

/**
 * Manda uma mensagem do composer para o agente da conversa. `false` = o terminal ainda não está
 * vivo; aí a mensagem fica na fila e sai quando ele estiver pronto.
 */
export function sendToConversation(tabId: string, text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (pasteIntoTab(tabId, clean, true)) return true;
  sendWhenReady(tabId, clean);
  return false;
}

/**
 * Reabre uma pasta fechada (as "Concluídas" da sidebar): os agentes dela voltam com a conversa e as
 * skills, como no painel de workspaces. Abre a primeira na tela.
 */
export async function reopenFolder(cwd: string): Promise<void> {
  const snapshot = await useSnapshotsStore.getState().take(cwd);
  if (!snapshot) return;
  const tabs = useTabsStore.getState();
  let first: string | null = null;
  for (const saved of snapshot.tabs) {
    const tabId = tabs.addTab({
      cwd: snapshot.cwd,
      agent: { id: saved.agentId, label: saved.agentLabel, command: saved.command, available: true },
      title: saved.title,
      titleIsCustom: saved.titleIsCustom ?? undefined,
      sessionId: saved.sessionId ?? undefined,
      accountId: saved.accountId ?? undefined,
      prelaunch: saved.prelaunch,
    });
    first ??= tabId;
    if (saved.skillIds.length > 0) registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, tabs.workspaceId, saved.skillIds));
  }
  if (first) openConversation(first);
}

/**
 * Troca o modelo, o esforço ou a permissão de uma conversa aberta. Os flags vivem no comando da aba,
 * então o agente reinicia retomando a mesma sessão (`restartAgent`: o `--resume` da TUI) — a
 * conversa continua, com a escolha nova. Sem mudança, não reinicia nada.
 */
export function retuneConversationTab(tabId: string, choice: LaunchChoice): boolean {
  const tabs = useTabsStore.getState();
  const tab = tabs.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const command = retuneConversation(tab.agentId, tab.command, choice);
  if (command === tab.command) return false;
  tabs.updateTab(tabId, { command });
  tabs.restartAgent(tabId);
  return true;
}
