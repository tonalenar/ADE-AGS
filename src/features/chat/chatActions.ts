import { resolveAccountChoice } from "@/features/accounts/pools";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { useSnapshotsStore } from "@/features/workspaces/snapshotsStore";
import type { AgentInfo } from "@/features/tabs/types";
import { pasteIntoTab, sendWhenReady } from "@/features/terminal/terminalRegistry";

import { chatCommand, conversationTitle, type LaunchChoice } from "./chatModel";
import { setComposing } from "./store";

export interface StartConversation extends LaunchChoice {
  cwd: string;
  agent: AgentInfo;
  prompt: string;
  /** O valor do seletor de conta: um id, um pool ou `undefined` (a conta principal). */
  account: string | undefined;
}

/**
 * Abre uma conversa: uma aba de agente com a escolha do composer, e o prompt enviado assim que a
 * TUI estiver pronta. É o mesmo caminho da tela inicial (`HomePage`) e do "+" das abas: as skills
 * do workspace entram antes de o agente subir, e a conta de um pool é decidida agora.
 */
export async function startConversation(input: StartConversation): Promise<string> {
  const accountId = await resolveAccountChoice(input.agent.id, input.account);
  const command = chatCommand(input.agent.id, input.agent.command, input);
  const title = conversationTitle(input.prompt) ?? undefined;
  const tabs = useTabsStore.getState();
  const tabId = tabs.addTab({
    cwd: input.cwd,
    agent: { ...input.agent, command },
    title,
    titleIsCustom: title !== undefined,
    accountId,
  });
  registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, tabs.workspaceId, []));
  if (input.prompt.trim()) sendWhenReady(tabId, input.prompt.trim());
  // A conversa nova é a ativa: a tela dela substitui a de conversa nova.
  useViewTabsStore.getState().showTerminal();
  setComposing(false);
  return tabId;
}

/** Mostra uma conversa da sidebar. */
export function openConversation(tabId: string): void {
  useTabsStore.getState().activateTab(tabId);
  useViewTabsStore.getState().showTerminal();
  setComposing(false);
}

/** Abre a tela de conversa nova (a hero com o composer). */
export function newConversation(): void {
  setComposing(true);
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
