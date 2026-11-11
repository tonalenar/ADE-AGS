import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { readTuning } from "@/features/canvas/tabTuning";
import { useTabsStore } from "@/features/tabs/store";

import { readAccess, type ConversationCard } from "./chatModel";
import { chatSideChatDelete, chatThreadItems, type ThreadRow } from "./structured/ipc";
import { createThread, forkSideChat, settleThread, sendToThread, useStructured } from "./structured/store";
import { threadIdOf, threadKey } from "./structured/model";
import { StructuredConversationView } from "./structured/StructuredConversationView";
import { switchableAgents } from "./structured/switchModel";
import { SideChatDraftView } from "./SideChatDraft";
import { messageFor } from "./attachments/send";
import type { Attachment } from "./attachments/attachModel";
import { useChatLive } from "./liveStore";
import { insertIntoComposer } from "./store";
import { conversationTimeline } from "./ipc";
import type { TimelineItem } from "./timeline/types";
import { canOpenSideChat, clampSideChatAccess, sideChatAccountFor, sideChatDraftDefaults, sideChatFirstMessage, sideChatForkNote, sideChatHistory, sideChatParentReference, type SideChatDraft } from "./sideChatModel";
import { NewChatIcon, SideChatIcon, XIcon } from "./chatIcons";

function cardForThread(thread: ThreadRow, parent: ConversationCard, label: string): ConversationCard {
  return {
    tabId: threadKey(thread.id),
    title: thread.title,
    project: parent.project,
    cwd: thread.cwd,
    branch: parent.branch,
    isWorktree: parent.isWorktree,
    agentId: thread.agentId,
    agentLabel: label,
    starting: false,
    active: true,
    openedAt: thread.updatedAt,
  };
}

/** A lixeira do cabeçalho (o `chatIcons` não tem uma): o traço usa a cor do texto. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

/**
 * A pergunta lateral: uma conversa independente ao lado da conversa de origem, com o histórico dela na frente (a
 * mesma timeline do chat principal) e o composer compacto. Cabeçalho enxuto: título, Trazer para conversa, Excluir e
 * Nova. A origem e o terminal continuam montados; perguntar aqui não interrompe o turno dela.
 */
export function SideChatPanel({ conversation, cards = [] }: { conversation: ConversationCard | null; cards?: ConversationCard[] }) {
  const { t } = useTranslation();
  const threads = useStructured((s) => s.threads);
  const detected = useTabsStore((s) => s.detectedAgents);
  const availableAgents = useAvailableAgents({ includeLocalAcp: true });
  const tab = useTabsStore((s) => conversation && !conversation.tabId.startsWith("thread:") ? s.tabs.find((row) => row.id === conversation.tabId) : undefined);
  const parentThreadId = conversation ? threadIdOf(conversation.tabId) : null;
  const parentThread = useStructured((s) => parentThreadId ? s.threads.find((row) => row.id === parentThreadId) : undefined);
  const parentStructuredBusy = useStructured((s) => parentThreadId ? s.live[parentThreadId]?.phase === "working" : false);
  const command = tab?.command ?? "";
  const tuning = useMemo(() => conversation && !parentThread ? readTuning(conversation.agentId, command) : null,
    [conversation?.agentId, parentThread, command]);
  const ref = conversation ? sideChatParentReference(conversation) : null;
  const sideChats = useMemo(
    () => threads.filter((row) => row.isSideChat && row.parentRef === ref).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads, ref],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // O rascunho só existe quando a pessoa mexe nele; sem isso, vale o padrão da origem (ver `draftValue`).
  const [draft, setDraft] = useState<SideChatDraft | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const parentTuiBusy = useChatLive((s) => conversation ? s.phase[conversation.tabId] === "working" : false);
  const parentBusy = parentTuiBusy || parentStructuredBusy;
  const live = useStructured((s) => s.live);
  const selected = sideChats.find((row) => row.id === selectedId) ?? null;
  /** O aviso do topo: o recorte ou o contexto portátil (a cópia nativa não avisa). */
  const forkNote = sideChatForkNote(selected);
  const answerItems = useStructured((s) => selectedId ? s.live[selectedId]?.items : undefined) ?? [];
  const answer = [...answerItems].reverse().find((item) => item.kind === "assistant" && item.text?.trim())?.text?.trim() ?? "";
  const selectedWorking = selectedId ? live[selectedId]?.phase === "working" : false;
  // O histórico da origem, limitado, é o mesmo que a timeline do chat principal mostra: a pergunta lateral o herda na tela.
  const history = useMemo(() => sideChatHistory(items), [items]);
  const sideView = useMemo(() => ({ history: history.items, truncated: history.truncated }), [history]);

  useEffect(() => {
    if (!conversation || !ref) {
      setItems([]);
      return;
    }
    let alive = true;
    let scheduled = false;
    const load = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const read = parentThreadId
          ? chatThreadItems(parentThreadId)
          : conversationTimeline(conversation.tabId).then((timeline) => timeline?.items ?? []);
        void read.then((value) => { if (alive) setItems(value); }).catch(() => undefined);
      });
    };
    load();
    const offConversation = listen<{ tabId: string }>("cc-conversation-grew", (event) => {
      if (event.payload.tabId === conversation.tabId) load();
    });
    const offThread = listen<{ threadId: string; type: string }>("cc-chat-thread", (event) => {
      if (event.payload.threadId === parentThreadId && event.payload.type === "item") load();
    });
    return () => {
      alive = false;
      offConversation.then((off) => off()).catch(() => undefined);
      offThread.then((off) => off()).catch(() => undefined);
    };
  }, [conversation?.tabId, parentThreadId, ref]);

  useEffect(() => {
    if (selectedId && !sideChats.some((row) => row.id === selectedId)) setSelectedId(null);
  }, [selectedId, sideChats]);

  const eligible = canOpenSideChat(conversation) && !!ref;

  if (!eligible || !conversation) {
    return <div className="flex-1 min-h-0 grid place-items-center p-8 text-center text-chat-note text-gray-500 dark:text-white/45">
      <div><SideChatIcon className="w-6 h-6 mx-auto mb-2 opacity-50" /><p>{t("chat.sideChat.unsupported")}</p></div>
    </div>;
  }

  // O padrão de uma pergunta nova vem da origem: o agente, o modelo, o esforço e a permissão (nunca acima da dela).
  const originAccess = parentThread?.access ?? (tab ? readAccess(conversation.agentId, command).access : null);
  const draftValue = draft ?? sideChatDraftDefaults(conversation.agentId, parentThread?.model ?? tuning?.model ?? null, parentThread?.effort ?? tuning?.effort ?? null, originAccess);
  const agents = switchableAgents(availableAgents, conversation.agentId, conversation.agentLabel);

  const create = async (question: string, attachments: Attachment[]) => {
    if (!ref || !question.trim()) return false;
    setError(null);
    setLoading(true);
    try {
      const id = await createThread({
        agentId: draftValue.agentId,
        cwd: conversation.cwd,
        title: question.trim().replace(/\s+/g, " ").slice(0, 72) || t("chat.sideChat.title"),
        model: draftValue.model,
        effort: draftValue.effort,
        // A origem pode ter ficado mais cautelosa depois da escolha: a pergunta nunca passa do modo dela.
        access: clampSideChatAccess(draftValue.agentId, originAccess, draftValue.access),
        accountId: sideChatAccountFor(draftValue.agentId, conversation.agentId, parentThread?.accountId ?? tab?.accountId ?? null),
        parentRef: ref,
      });
      // A pergunta nasce como cópia da conversa de origem (fork nativo). Sem fork, a primeira mensagem leva o recorte
      // do histórico e a tela avisa o motivo. A origem não é tocada em nenhum dos dois caminhos.
      const fork = await forkSideChat(id);
      setSelectedId(id);
      setDraft(null);
      const sent = messageFor(threadKey(id), sideChatFirstMessage(fork.mode, items, question), attachments);
      sendToThread(id, sent.text, (message) => setError(message), undefined, sent.images);
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const bringBack = () => {
    if (!answer || parentBusy || selectedWorking) return;
    const text = "[" + t("chat.sideChat.contextLabel") + ": " + (selected?.title ?? t("chat.sideChat.title")) + "]\n" + answer.slice(0, 6000);
    insertIntoComposer(text, conversation.tabId);
  };

  const remove = async (thread: ThreadRow) => {
    if (!window.confirm(t("chat.sideChat.deleteConfirm", { title: thread.title }))) return;
    setError(null);
    try {
      await chatSideChatDelete(thread.id);
      useStructured.setState((state) => ({
        threads: state.threads.filter((row) => row.id !== thread.id),
        live: Object.fromEntries(Object.entries(state.live).filter(([id]) => id !== thread.id)),
        hydrated: Object.fromEntries(Object.entries(state.hydrated).filter(([id]) => id !== thread.id)),
      }));
      if (selectedId === thread.id) setSelectedId(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(null);
    setError(null);
  };

  const activeCard = selected ? cardForThread(selected, conversation, detected.find((row) => row.id === selected.agentId)?.label ?? selected.agentId) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-1 pl-3 pr-2 h-10 border-b border-gray-200 dark:border-white/[0.08]">
        <SideChatIcon className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/50" />
        <span className="min-w-0 flex-1 truncate text-chat-ui font-medium" title={selected?.title || undefined}>
          {selected ? selected.title || t("chat.sideChat.title") : t("chat.sideChat.title")}
        </span>
        {selected && (
          <button type="button" onClick={bringBack} disabled={!answer || parentBusy || selectedWorking}
            className="h-7 px-2 shrink-0 rounded-md text-chat-caption font-medium text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/[0.08] disabled:opacity-40">
            {t("chat.sideChat.bringBack")}
          </button>
        )}
        {selected && (
          <button type="button" onClick={() => void remove(selected)} disabled={selectedWorking}
            aria-label={t("chat.sideChat.delete")} title={t("chat.sideChat.delete")}
            className="w-7 h-7 shrink-0 rounded-md grid place-items-center text-gray-500 dark:text-white/50 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-white/[0.08] disabled:opacity-40">
            <TrashIcon className="w-4 h-4" />
          </button>
        )}
        <button type="button" onClick={startNew} aria-label={t("chat.sideChat.new")} title={t("chat.sideChat.new")}
          className="w-7 h-7 shrink-0 rounded-md grid place-items-center text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.08]">
          <NewChatIcon className="w-4 h-4" />
        </button>
      </header>
      {sideChats.length > 0 && (
        <nav aria-label={t("chat.sideChat.list")} className="shrink-0 flex gap-1.5 overflow-x-auto cc-scroll-hidden px-3 py-1.5 border-b border-gray-200 dark:border-white/[0.08]">
          {sideChats.map((row) => (
            <div key={row.id} className={"shrink-0 h-6 max-w-[220px] flex items-center rounded-md text-chat-caption " +
              (selectedId === row.id ? "bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/50")}>
              <button type="button" onClick={() => { if (row.state === "settled") settleThread(row.id, false); setSelectedId(row.id); setDraft(null); }}
                className="min-w-0 h-full px-2 truncate" title={row.title}>{row.title || t("chat.sideChat.title")}</button>
              <button type="button" onClick={() => void remove(row)} disabled={live[row.id]?.phase === "working"}
                aria-label={t("chat.sideChat.delete")} title={t("chat.sideChat.delete")}
                className="w-5 h-full grid place-items-center text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40">
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </nav>
      )}
      {forkNote && (
        <p className="shrink-0 px-3 py-1.5 border-b border-gray-200 dark:border-white/[0.08] text-chat-caption text-gray-500 dark:text-white/45 break-words">
          {t(forkNote.noteKey, { reason: t(forkNote.reasonKey) })}
        </p>
      )}
      {error && <p role="alert" className="shrink-0 px-3 py-2 text-chat-caption text-red-600 dark:text-red-400 break-words">{error}</p>}
      {selected && activeCard ? (
        <StructuredConversationView key={selected.id} card={activeCard} thread={selected} cards={cards} side={sideView} />
      ) : (
        <SideChatDraftView conversation={conversation} history={history.items} truncated={history.truncated} parentBusy={parentBusy}
          agents={agents} draft={draftValue} originAccess={originAccess} busy={loading} onDraftChange={setDraft} onSubmit={create} />
      )}
    </div>
  );
}
