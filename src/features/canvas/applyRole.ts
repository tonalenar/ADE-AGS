import { useTabsStore } from "@/features/tabs/store";

import { loadCanvasRoles, roleBriefing, roleLabelOf, type AgentRoleChoice } from "./agentRole";
import { boardKeyOfTab, canvasActions } from "./store";

/**
 * Grava no canvas o que o terminal é (função e subagente) e devolve o que o agente deve ler sobre isso,
 * ou `null` se não há nada a dizer (sem função e não é subagente). Quem chama manda o texto.
 */
export async function applyTabRole(tabId: string, choice: AgentRoleChoice): Promise<string | null> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const roles = await loadCanvasRoles();
  canvasActions.setRole(boardKeyOfTab(tab), tabId, roleLabelOf(roles, choice.roleId), choice.subagent);
  return roleBriefing(roles, choice);
}
