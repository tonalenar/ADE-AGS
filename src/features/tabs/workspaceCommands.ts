import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";

/** Evento local para abrir o assistente de uma nova sessão no workspace ativo. */
export const NEW_WORKSPACE_AGENT_EVENT = "ade:workspace-new-agent";

/** Confere o contexto atual antes de expor ou executar a ação. */
export function canOpenWorkspaceAgent(pathname: string): boolean {
  const workspaceRoute = pathname === "/workspace" || pathname.startsWith("/workspace/");
  if (typeof window === "undefined" || chatShellOn(useUiStore.getState()) || !workspaceRoute) return false;
  const { tabs, activeTabId } = useTabsStore.getState();
  return !!tabs.find((tab) => tab.id === activeTabId)?.cwd;
}

/** Abre o assistente existente; a sessão só inicia depois da confirmação da pessoa. */
export function requestWorkspaceAgent(pathname: string): boolean {
  if (!canOpenWorkspaceAgent(pathname)) return false;
  window.dispatchEvent(new Event(NEW_WORKSPACE_AGENT_EVENT));
  return true;
}
