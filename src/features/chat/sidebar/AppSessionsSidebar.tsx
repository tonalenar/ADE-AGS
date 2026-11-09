import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useUiStore } from "@/app/uiStore";
import { MissionsSection } from "@/features/missions/MissionsSection";
import { useTabsStore } from "@/features/tabs/store";
import { useLocalAcpStore } from "@/features/agents/localAcpStore";
import { PetCard, usePetStatus } from "@/shared/brand/Pet";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { newConversationIn, reopenFolder } from "../chatActions";
import { chatProjects, conversationCards, type ChatProject } from "../chatModel";
import { ChatSidebar } from "../ChatSidebar";
import { useFolderDiffs } from "../ChatShell";
import { startChatLive } from "../liveStore";
import { addSurface } from "../store";
import { startQueueRunner } from "../queueRunner";
import { startStructured, useStructured } from "../structured/store";
import { threadCards } from "../structured/model";
import { useSelectedRef } from "../unified/useConversations";

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
  const localProviders = useLocalAcpStore((s) => s.providers);
  const localProvidersLoaded = useLocalAcpStore((s) => s.loaded);
  const loadLocalProviders = useLocalAcpStore((s) => s.load);
  const selected = useSelectedRef();
  const pet = usePetStatus();
  const chatMode = useUiStore((s) => s.chatMode);
  const setShellMode = useUiStore((s) => s.setShellMode);
  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);
  useEffect(() => startQueueRunner(), []);
  useEffect(() => { if (!localProvidersLoaded) void loadLocalProviders().catch(console.error); }, [localProvidersLoaded, loadLocalProviders]);
  const cards = useMemo(() => {
    const labelOf = (id: string) => detected.find((a) => a.id === id)?.label ?? localProviders.find((a) => a.id === id)?.label ?? id;
    // Os terminais de uma missão entram na lista como as demais conversas: o espelho da missão (`origin =
    // "mission"`) os agrupa sob o orquestrador com o selo "MISSÃO" (ver `TeamSidebar`). A seção de missões
    // (acima) segue sendo a lista das missões, com criar, iniciar e encerrar.
    return [...threadCards(threads, groups, labelOf, null), ...conversationCards(groups)]
      .sort((a, b) => b.openedAt - a.openedAt);
  }, [groups, threads, detected, localProviders]);
  const closed = useMemo(() => {
    const open = new Set(cards.map((c) => c.cwd));
    return groups.flatMap((g) => g.workspaces).filter((w) => w.closed && !open.has(w.cwd)).map((w): ChatProject => ({ cwd: w.cwd, name: w.title, branch: w.branch }));
  }, [groups, cards]);
  const projects = useMemo(() => chatProjects(groups), [groups]);
  const diffs = useFolderDiffs(cards);
  return (
    <ChatSidebar cards={cards} projects={projects} closed={closed} diffs={diffs} selectedId={selected} width={width}
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
