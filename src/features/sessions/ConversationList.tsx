import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, AddIcon } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";

import { useMissionIndex } from "@/features/missions/groups";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWith } from "@/features/tabs/tabActions";
import { comparablePath } from "@/features/tabs/viewTabs";
import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";

import { CanvasConversations } from "./CanvasConversations";
import { adoptLooseTabs, startConversation } from "./conversationFlow";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { sameProject, useConversationsStore } from "./conversationsStore";
import { useConversationUi } from "./conversationUi";

/**
 * As conversas de um projeto. Uma conversa é a ÁREA DE TRABALHO inteira (o canvas ou as abas, com todos os
 * agentes dela), não a sessão de um agente: ela se salva junta e reabre junta, e o título segue o contexto do
 * orquestrador. Por isso não há lista por agente: toda aba de agente aberta numa pasta do projeto entra na conversa
 * ativa, que nasce sozinha se não houver. As sessões avulsas de antes continuam na página Sessões. Os terminais
 * de missão ficam de fora (vivem na própria missão). "+ Nova" salva a conversa atual e começa outra.
 */
export function ConversationList({ cwd, groupCwds, projectKey: rawKey, workspaceId, onOpenTab }: {
  cwd: string;
  /** A raiz do projeto: agrupa as conversas dele. */
  projectKey: string;
  groupCwds: string[];
  workspaceId: string;
  onOpenTab: (tabId: string) => void;
}) {
  const { t } = useTranslation();
  // Uma só forma da chave para o que se grava (ver `sameProject`).
  const projectKey = comparablePath(rawKey);
  const tabs = useTabsStore((s) => s.tabs);
  const hydrated = useTabsStore((s) => s.hydrated);
  const boards = useCanvasStore((s) => s.boards);
  // Só depois de o canvas salvo carregar: antes disso toda aba parece solta, e a adoção a tirava da conversa dela
  // (perdendo a coroa e as cordas, que ainda estavam no disco).
  const canvasLoaded = useCanvasStore((s) => s.loaded);
  const missionOf = useMissionIndex();
  const collapsed = useConversationUi((s) => !!s.projects[projectKey]);
  const toggleProject = useConversationUi((s) => s.toggleProject);
  const rows = useConversationsStore((s) => s.rows);
  const projectConvs = useMemo(() => rows.filter((r) => sameProject(r.projectKey, projectKey) && !r.hidden), [rows, projectKey]);

  // As abas de agente deste projeto que ainda não estão numa conversa (nem numa missão).
  const folders = useMemo(() => new Set(groupCwds.map(comparablePath)), [groupCwds]);
  const loose = useMemo(
    () => (hydrated && canvasLoaded ? tabs : [])
      .filter((tab) => tab.agentId !== SHELL_AGENT_ID && !missionOf[tab.id] && folders.has(comparablePath(tab.cwd)))
      .filter((tab) => !boardKeyOfTab(tab, boards).includes("#c:"))
      .map((tab) => tab.id),
    [hydrated, canvasLoaded, tabs, missionOf, folders, boards],
  );

  // Elas entram na conversa ativa (criada se não houver). Uma adoção por vez: a próxima vê o estado já mudado.
  const adopting = useRef(false);
  const looseKey = loose.join("|");
  useEffect(() => {
    if (loose.length === 0 || adopting.current) return;
    adopting.current = true;
    adoptLooseTabs({ workspaceId, cwd, projectKey }, loose)
      .catch((e) => AlertaToast(t("conversations.title"), String(e), "error", 6000))
      .finally(() => { adopting.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looseKey, workspaceId, cwd, projectKey]);

  /** Nova conversa: salva e fecha a atual (se houver) e abre o assistente de agente na nova. */
  const startNew = async () => {
    try {
      const row = await startConversation({ workspaceId, cwd, projectKey });
      if (row) openNewAgentWith({ cwd, title: t("conversations.newTitle") });
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 7000);
    }
  };

  return (
    <div className="flex flex-col gap-0.5" aria-label={t("conversations.title")}>
      <div className="flex items-center gap-1.5 pl-1.5 pr-0.5">
        <button type="button" aria-expanded={!collapsed} onClick={() => toggleProject(projectKey)}
          title={collapsed ? t("conversations.expand") : t("conversations.collapse")}
          className="cc-t flex flex-1 min-w-0 items-center gap-1 h-5 rounded text-left text-[9.5px] font-bold uppercase tracking-[0.09em] text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}><path d="m9 6 6 6-6 6" /></svg>
          <span className="truncate">{t("conversations.title")}</span>
          {projectConvs.length > 0 && <span className="tabular-nums font-normal">{projectConvs.length}</span>}
        </button>
        <Button variant="icon" aria-label={t("conversations.new")} title={t("conversations.newHint")}
          onClick={() => void startNew()}
          className="cc-t flex items-center gap-1 h-5 px-1.5 rounded-md text-[10.5px] text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <AddIcon className="w-3 h-3" />{t("conversations.new")}
        </Button>
      </div>

      {!collapsed && <CanvasConversations projectKey={projectKey} cwd={cwd} workspaceId={workspaceId}
        onOpened={(tabId) => { if (tabId) onOpenTab(tabId); }} />}
      {!collapsed && projectConvs.length === 0 && (
        <p className="px-[18px] py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("conversations.empty")}</p>
      )}
    </div>
  );
}
