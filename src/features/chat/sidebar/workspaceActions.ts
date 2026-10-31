import { useSkillsStore } from "@/features/skills/store";
import { useTabsStore } from "@/features/tabs/store";
import { useSnapshotsStore } from "@/features/workspaces/snapshotsStore";

/**
 * Fechar uma pasta inteira (o "fechar workspace" do painel antigo das Abas): primeiro se guarda o que
 * ela tinha (conversa, comando e skills de cada aba) e só depois as abas fecham, nessa ordem, porque
 * fechar uma aba leva junto o que há para lembrar. As pastas fechadas aparecem em "Concluídas" e
 * reabrem com `reopenFolder`.
 */
export async function closeWorkspaceFolder(cwd: string): Promise<void> {
  const tabs = useTabsStore.getState();
  const mine = tabs.tabs.filter((tab) => tab.cwd === cwd);
  if (mine.length === 0) return;
  const skills = useSkillsStore.getState().skills;
  await useSnapshotsStore.getState().save(cwd, tabs.workspaceId, mine.map((tab) => ({
    title: tab.title,
    titleIsCustom: tab.titleIsCustom ?? null,
    agentId: tab.agentId,
    agentLabel: tab.agentLabel,
    command: tab.command,
    sessionId: tab.sessionId ?? null,
    accountId: tab.accountId ?? null,
    prelaunch: tab.prelaunch ?? [],
    skillIds: skills.filter((s) => s.usedBy.some((u) => u.scope === "tab" && u.tabId === tab.id)).map((s) => s.id),
  })));
  for (const tab of mine) tabs.closeTab(tab.id);
}

/** Esquecer uma pasta fechada: some das "Concluídas" (é o único destrutivo daqui, e é da pessoa). */
export function forgetWorkspaceFolder(cwd: string): Promise<void> {
  return useSnapshotsStore.getState().forget(cwd);
}
