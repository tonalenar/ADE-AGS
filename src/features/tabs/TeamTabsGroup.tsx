import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useChatShell } from "@/app/uiStore";
import { UsersIcon } from "@/features/chat/chatIcons";
import { startTeams } from "@/features/chat/team/teamStore";
import { startStructured } from "@/features/chat/structured/store";
import { useConversations } from "@/features/chat/unified/useConversations";
import { useTabsStore } from "@/features/tabs/store";
import { ProtocolPane } from "@/features/tabs/ProtocolPane";
import { runTeamAction } from "@/features/tabs/teamTabActions";
import { teamGroups } from "@/features/tabs/teamTabs";
import { threadIdOf } from "@/features/chat/structured/model";

const CHIP = `cc-t flex items-center gap-1.5 h-7 px-2.5 my-auto shrink-0 rounded-lg text-[11.5px] font-medium max-w-[200px]
  text-gray-600 dark:text-gray-300 bg-black/5 dark:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/[0.12]`;

/**
 * O time da aba ativa na barra: "Criar time" quando ela não está em nenhum, e uma entrada própria (com o selo
 * "protocolo") para cada integrante que nasceu por protocolo e portanto não tem aba. A entrada abre a timeline
 * dele numa gaveta; os terminais seguem nas abas e na grade. Ligar, desligar e coroar ficam no menu da aba.
 */
export function TeamTabsGroup() {
  const { t } = useTranslation();
  const chatShell = useChatShell();
  // Time e conversas por protocolo: abre a escuta (uma vez por janela) mesmo sem o chat aberto.
  useEffect(() => { startTeams(); startStructured(); }, []);
  const conversations = useConversations();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const [open, setOpen] = useState<string | null>(null);

  const active = conversations.find((c) => c.ref === activeTabId);
  const group = useMemo(() => (active?.teamId ? teamGroups(conversations).find((g) => g.teamId === active.teamId) : undefined), [conversations, active?.teamId]);
  if (chatShell || !active) return null;
  if (!group) {
    return (
      <button type="button" data-tauri-drag-region="false" onClick={() => { void runTeamAction("create", active, null); }}
        className={CHIP} title={t("tabs.team.createHint")}>
        <UsersIcon className="w-3.5 h-3.5" />
        {t("tabs.team.action.create")}
      </button>
    );
  }
  const shown = group.protocol.find((ref) => ref === open);
  const conv = shown ? conversations.find((c) => c.ref === shown) : undefined;
  const threadId = shown ? threadIdOf(shown) : null;
  return (
    <>
      {group.protocol.map((ref) => {
        const c = conversations.find((x) => x.ref === ref);
        return (
          <button key={ref} type="button" data-tauri-drag-region="false" aria-pressed={open === ref}
            onClick={() => setOpen(open === ref ? null : ref)} className={CHIP} title={t("tabs.team.protocolHint")}>
            <span className="min-w-0 truncate">{c?.title ?? ref}</span>
            <span className="shrink-0 rounded-[5px] px-1 py-px text-[10px] font-semibold bg-gray-200/70 dark:bg-white/[0.08]">{t("tabs.team.protocol")}</span>
          </button>
        );
      })}
      {conv && threadId && createPortal(
        <div role="dialog" aria-label={conv.title}
          className="fixed top-11 right-3 bottom-3 z-50 w-[480px] max-w-[calc(100vw-24px)] flex flex-col overflow-hidden rounded-xl
            bg-white dark:bg-surface-deep shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_20px_50px_-20px_rgba(0,0,0,0.55)]">
          <ProtocolPane threadId={threadId} agentId={conv.agentId} agentLabel={conv.agentId} />
        </div>,
        document.body,
      )}
    </>
  );
}
