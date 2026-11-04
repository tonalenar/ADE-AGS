import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EMPTY_LIVE } from "@/features/chat/structured/model";
import { hydrateThread, openThread, useStructured } from "@/features/chat/structured/store";
import { withDrafts } from "@/features/chat/timeline/streaming";
import { TimelineView } from "@/features/chat/timeline/ConversationTimeline";

/**
 * A conversa por protocolo (`thread:<id>`) nas Abas: a mesma timeline do chat, em React puro (sem xterm,
 * sem PTY). É só leitura; escrever ou aprovar é no chat ("Abrir no chat"). Desmontar este painel não
 * mata nada: a conversa vive no backend.
 */
export function ProtocolPane({ threadId, agentId, agentLabel }: { threadId: string; agentId: string; agentLabel: string }) {
  const { t } = useTranslation();
  const live = useStructured((s) => s.live[threadId]) ?? EMPTY_LIVE;
  const hydrated = useStructured((s) => !!s.hydrated[threadId]);
  useEffect(() => hydrateThread(threadId), [threadId]);
  const items = useMemo(() => withDrafts(live.items, live.drafts), [live.items, live.drafts]);
  const streaming = useMemo(() => new Set(live.drafts.map((d) => d.itemId)), [live.drafts]);
  const working = live.phase === "working";
  return (
    <div data-protocol-pane={threadId} className="flex-1 min-h-0 flex flex-col pointer-events-auto bg-white dark:bg-surface-deep">
      <div className="shrink-0 flex items-center gap-2 px-2 h-7 text-[11px] text-gray-500 dark:text-white/50 border-b border-gray-200 dark:border-white/[0.08]">
        <span className="rounded-[5px] px-1.5 py-px font-semibold bg-gray-200/70 dark:bg-white/[0.08] text-gray-600 dark:text-white/60">{t("tabs.team.protocol")}</span>
        <span className="flex-1 min-w-0 truncate">{t("tabs.team.protocolHint")}</span>
        <button type="button" onClick={() => openThread(threadId)} className="shrink-0 text-accent-700 dark:text-accent-400 hover:underline">
          {t("tabs.team.openInChat")}
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <TimelineView items={items} loaded={hydrated} working={working} approval={null} live streaming={streaming}
          agentLabel={agentLabel} agentId={agentId} threadId={threadId} />
      </div>
    </div>
  );
}
