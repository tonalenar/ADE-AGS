import { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useUiStore } from "@/app/uiStore";
import { MissionsSection } from "@/features/missions/MissionsSection";
import { PetCard, usePetStatus } from "@/shared/brand/Pet";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { newConversationLocal, newConversationIn, reopenFolder } from "../chatActions";
import { ChatSidebar } from "../ChatSidebar";
import { useFolderDiffs } from "../useFolderDiffs";
import { startChatLive } from "../liveStore";
import { pickProjectFolder } from "../NewConversation";
import { addSurface, useChatStore } from "../store";
import { startQueueRunner } from "../queueRunner";
import { startStructured } from "../structured/store";
import { useSelectedRef } from "../unified/useConversations";
import { useSidebarCards } from "./useSidebarCards";

const NOOP = () => undefined;

/**
 * A MESMA barra de sessões do modo chat, nas Abas e no Canvas (no lugar do painel de workspaces): as
 * conversas vêm da mesma fonte (`useSidebarCards`), com Fixadas, seções por projeto, ⋯, renomear e
 * teclado. O cabeçalho é o `SideHead` e o rodapé é o riel, então a barra vem sem os dois; as missões
 * e o pet, que só estes modos têm, entram no alto e embaixo.
 */
export const AppSessionsSidebar = memo(function AppSessionsSidebar({ groups, width }: { groups: RepoGroup[]; width: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const selected = useSelectedRef();
  const pet = usePetStatus();
  const chatMode = useUiStore((s) => s.chatMode);
  const setShellMode = useUiStore((s) => s.setShellMode);
  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);
  useEffect(() => startQueueRunner(), []);
  const addProject = useCallback(async () => {
    const picked = await pickProjectFolder(t("home.dialogTitle"));
    if (!picked) return;
    newConversationIn(picked);
  }, [t]);
  // Os terminais de uma missão entram na lista como as demais conversas: o espelho da missão (`origin =
  // "mission"`) os agrupa sob o orquestrador com o selo "MISSÃO" (ver `TeamSidebar`). A seção de missões
  // (acima) segue sendo a lista das missões, com criar, iniciar e encerrar.
  const { cards, projects, closed } = useSidebarCards(groups);
  const diffs = useFolderDiffs(cards);
  const onNew = useCallback(() => {
    useChatStore.setState({ composeFolder: null });
    newConversationLocal();
  }, []);
  const onAddProject = useCallback(() => { void addProject(); }, [addProject]);
  const onOpened = useCallback(() => navigate("/workspace"), [navigate]);
  const onArtifacts = useMemo(
    () => (chatMode ? () => { setShellMode("chat"); addSurface("design"); } : null),
    [chatMode, setShellMode],
  );
  const onReopen = useCallback((cwd: string) => { void reopenFolder(cwd).then(() => navigate("/workspace")); }, [navigate]);
  const extraTop = useMemo(() => <MissionsSection />, []);
  const extraBottom = useMemo(() => <PetCard pet={pet} className="mx-2 mb-2 shrink-0" />, [pet]);
  return (
    <ChatSidebar cards={cards} projects={projects} closed={closed} diffs={diffs} selectedId={selected} width={width}
      showHeader={false} showFooter={false}
      onCollapse={NOOP}
      onNew={onNew}
      onAddProject={onAddProject}
      // O mesmo composer do chat abre sobre o workspace, sem trocar a preferência de modo.
      onNewIn={newConversationIn}
      onOpened={onOpened}
      // As pranchetas moram no painel do modo chat: nas Abas e no Canvas a linha leva para lá (e some com o modo chat desligado).
      onArtifacts={onArtifacts}
      onReopen={onReopen}
      extraTop={extraTop}
      extraBottom={extraBottom} />
  );
});
