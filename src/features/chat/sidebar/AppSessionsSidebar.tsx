import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useUiStore } from "@/app/uiStore";
import { MissionsSection } from "@/features/missions/MissionsSection";
import { useMissionIndex } from "@/features/missions/groups";
import { useTabsStore } from "@/features/tabs/store";
import { PetCard, usePetStatus } from "@/shared/brand/Pet";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { newConversationIn, reopenFolder } from "../chatActions";
import { conversationCards, type ChatProject } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useFolderDiffs } from "../ChatShell";
import { startChatLive } from "../liveStore";
import { addSurface } from "../store";
import { startQueueRunner } from "../queueRunner";
import { startStructured, useStructured } from "../structured/store";
import { threadCards } from "../structured/model";

/**
 * A MESMA barra de sessões do modo chat, nas Abas e no Canvas (no lugar do painel de workspaces): as
 * conversas vêm da mesma fonte (`conversationCards` e as conversas por protocolo), com Fixadas,
 * seções por projeto, ⋯, renomear e teclado. O cabeçalho é o `SideHead` e o rodapé é o riel, então a
 * barra vem sem os dois; as missões e o pet, que só estes modos têm, entram no alto e embaixo.
 */
export function AppSessionsSidebar({ groups, width }: { groups: RepoGroup[]; width: number }) {
  const navigate = useNavigate();
  const threads = useStructured((s) => s.threads);
  const detected = useTabsStore((s) => s.detectedAgents);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const missionOf = useMissionIndex();
  const pet = usePetStatus();
  const chatMode = useUiStore((s) => s.chatMode);
  const setShellMode = useUiStore((s) => s.setShellMode);
  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);
  useEffect(() => startQueueRunner(), []);
  const cards = useMemo(() => {
    const labelOf = (id: string) => detected.find((a) => a.id === id)?.label ?? id;
    // As terminais de uma missão ficam na seção de missões (acima), não soltas na lista.
    return [...threadCards(threads, groups, labelOf, null), ...conversationCards(groups).filter((c) => !missionOf[c.tabId])]
      .sort((a, b) => b.openedAt - a.openedAt);
  }, [groups, threads, detected, missionOf]);
  const closed = useMemo(() => {
    const open = new Set(cards.map((c) => c.cwd));
    return groups.flatMap((g) => g.workspaces).filter((w) => w.closed && !open.has(w.cwd)).map((w): ChatProject => ({ cwd: w.cwd, name: w.title, branch: w.branch }));
  }, [groups, cards]);
  const diffs = useFolderDiffs(cards);
  return (
    <ChatSidebar cards={cards} closed={closed} diffs={diffs} selectedId={activeTabId} width={width}
      showHeader={false} showFooter={false}
      onCollapse={() => undefined}
      onNew={() => navigate("/")} onAddProject={() => navigate("/")}
      // O "+" de um projeto: com o modo chat ligado leva à tela de conversa nova (no chat) já nessa pasta; sem ele, ao início com a pasta escolhida.
      onNewIn={(cwd) => {
        if (chatMode) { setShellMode("chat"); newConversationIn(cwd); }
        else navigate(`/?cwd=${encodeURIComponent(cwd)}`);
      }}
      onOpened={() => navigate("/workspace")}
      // As pranchetas moram no painel do modo chat: nas Abas e no Canvas a linha leva para lá (e some com o modo chat desligado).
      onArtifacts={chatMode ? () => { setShellMode("chat"); addSurface("design"); } : null}
      onReopen={(cwd) => { void reopenFolder(cwd).then(() => navigate("/workspace")); }}
      extraTop={<MissionsSection />}
      extraBottom={<PetCard pet={pet} className="mx-2 mb-2 shrink-0" />} />
  );
}
