import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { turnLive } from "./activityModel";
import { AgentModelPicker } from "./AgentModelPicker";
import { ChatFrame } from "./ChatFrame";
import { ChatComposer } from "./ChatComposer";
import { ComposerColumn } from "./ComposerColumn";
import type { ChatAccess, ConversationCard } from "./chatModel";
import { ActivityLine } from "./LiveActivity";
import type { Attachment } from "./attachments/attachModel";
import type { AgentInfo } from "@/features/tabs/types";
import { TimelineView } from "./timeline/ConversationTimeline";
import type { TimelineItem } from "./timeline/types";
import { sideChatAccessModes, sideChatInheritedAccess, type SideChatDraft as Draft } from "./sideChatModel";

const NO_STREAMING: ReadonlySet<string> = new Set();

/**
 * A pergunta lateral antes da primeira mensagem: o histórico da conversa de origem na mesma timeline do chat principal
 * (só leitura), o estado de trabalho dela e o composer compacto com o modelo, o esforço e a permissão da pergunta.
 * A origem segue trabalhando: esta tela não a interrompe, e a pergunta só vira conversa quando é enviada.
 */
export function SideChatDraftView({ conversation, history, truncated, parentBusy, agents, draft, originAccess, busy, onDraftChange, onSubmit }: {
  conversation: ConversationCard;
  /** O histórico da conversa de origem, já limitado. */
  history: TimelineItem[];
  truncated: boolean;
  /** A conversa de origem está trabalhando agora (o estado aparece aqui; a pergunta não a interrompe). */
  parentBusy: boolean;
  /** Os agentes que a pergunta pode usar (o da origem primeiro). */
  agents: AgentInfo[];
  draft: Draft;
  /** O modo de permissão da origem: o teto do seletor da pergunta (nunca oferece um modo acima dele). */
  originAccess: ChatAccess | "plan" | null;
  busy: boolean;
  onDraftChange: (next: Draft) => void;
  /** `false` = não foi enviada: o texto e os anexos continuam no composer. */
  onSubmit: (text: string, attachments: Attachment[]) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const turn = useMemo(() => turnLive(history, false), [history]);
  const modes = sideChatAccessModes(draft.agentId, originAccess);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ChatFrame
        list={(bottomInset) => history.length > 0 ? (
          <TimelineView bottomInset={bottomInset} items={history} loaded truncated={truncated} working={parentBusy} live
            approval={null} streaming={NO_STREAMING} agentLabel={conversation.agentLabel} agentId={conversation.agentId} />
        ) : (
          <div style={{ paddingBottom: bottomInset }} className="flex-1 min-h-0 overflow-y-auto p-5">
            <p className="text-chat-note text-gray-500 dark:text-white/45">{t("chat.sideChat.empty", { agent: conversation.agentLabel })}</p>
          </div>
        )}
        composer={
          <ComposerColumn>
            {parentBusy && <ActivityLine live={turn} startedAt={null} />}
            <ChatComposer compact cwd={conversation.cwd} quoteKey={null} composerTarget={`side-draft:${conversation.tabId}`} disabled={busy}
              placeholder={parentBusy ? t("chat.sideChat.busyHint") : t("chat.sideChat.placeholder")}
              onSubmit={(text, attachments) => onSubmit(text, attachments)}
              controls={
                <AgentModelPicker agents={agents} harnessSurface="chat" showAccount={false} disabled={busy}
                  value={{ agentId: draft.agentId, model: draft.model, effort: draft.effort, account: null }}
                  permission={{ value: draft.access, modes, onChange: (access) => onDraftChange({ ...draft, access }) }}
                  onChange={(next) => {
                    const agentId = next.agentId ?? draft.agentId;
                    // A permissão da pergunta fica se o agente novo a oferece dentro do teto da origem; senão volta ao
                    // modo herdado dela para aquele agente.
                    const access = sideChatAccessModes(agentId, originAccess).includes(draft.access) ? draft.access : sideChatInheritedAccess(agentId, originAccess);
                    onDraftChange({ agentId, model: next.model, effort: next.effort, access });
                  }} />
              } />
          </ComposerColumn>
        } />
    </div>
  );
}
