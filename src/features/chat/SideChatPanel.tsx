import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { readTuning } from "@/features/canvas/tabTuning";

import { readAccess, type ConversationCard } from "./chatModel";
import { chatSideChatDelete, chatThreadItems, type ThreadRow } from "./structured/ipc";
import { createThread, settleThread, sendToThread, useStructured } from "./structured/store";
import { threadIdOf, threadKey } from "./structured/model";
import { StructuredConversationView } from "./structured/StructuredConversationView";
import { ChatComposer } from "./ChatComposer";
import { messageFor } from "./attachments/send";
import type { Attachment } from "./attachments/attachModel";
import { useChatLive } from "./liveStore";
import { insertIntoComposer } from "./store";
import { useTabsStore } from "@/features/tabs/store";
import { conversationTimeline } from "./ipc";
import type { TimelineItem } from "./timeline/types";
import { canOpenSideChat, sideChatContext, sideChatParentReference } from "./sideChatModel";
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

/** Conversa independente no painel lateral; o terminal e a conversa de origem continuam montados. */
export function SideChatPanel({ conversation, cards = [] }: { conversation: ConversationCard | null; cards?: ConversationCard[] }) {
  const { t } = useTranslation();
  const threads = useStructured((s) => s.threads);
  const detected = useTabsStore((s) => s.detectedAgents);
  const tab = useTabsStore((s) => conversation && !conversation.tabId.startsWith("thread:") ? s.tabs.find((row) => row.id === conversation.tabId) : undefined);
  const parentThreadId = conversation ? threadIdOf(conversation.tabId) : null;
  const parentThread = useStructured((s) => parentThreadId ? s.threads.find((row) => row.id === parentThreadId) : undefined);
  const parentStructuredBusy = useStructured((s) => parentThreadId ? s.live[parentThreadId]?.phase === "working" : false);
  const command = tab?.command ?? "";
  const tuning = useMemo(() => conversation && !parentThread ? readTuning(conversation.agentId, command) : null,
    [conversation?.agentId, parentThread, command]);
  const access = useMemo(() => conversation && !parentThread ? readAccess(conversation.agentId, command) : null,
    [conversation?.agentId, parentThread, command]);
  const ref = conversation ? sideChatParentReference(conversation) : null;
  const sideChats = useMemo(
    () => threads.filter((row) => row.isSideChat && row.parentRef === ref).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads, ref],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const parentTuiBusy = useChatLive((s) => conversation ? s.phase[conversation.tabId] === "working" : false);
  const parentBusy = parentTuiBusy || parentStructuredBusy;
  const live = useStructured((s) => s.live);
  const selected = sideChats.find((row) => row.id === selectedId) ?? null;
  const answerItems = useStructured((s) => selectedId ? s.live[selectedId]?.items : undefined) ?? [];
  const answer = [...answerItems].reverse().find((item) => item.kind === "assistant" && item.text?.trim())?.text?.trim() ?? "";
  const selectedWorking = selectedId ? live[selectedId]?.phase === "working" : false;

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
  const create = async (question: string, attachments: Attachment[]) => {
    if (!conversation || !ref || !eligible || !question.trim()) return false;
    setError(null);
    setLoading(true);
    try {
      const id = await createThread({
        agentId: conversation.agentId,
        cwd: conversation.cwd,
        title: question.trim().replace(/\s+/g, " ").slice(0, 72) || t("chat.sideChat.title"),
        model: parentThread?.model ?? tuning?.model ?? null,
        effort: parentThread?.effort ?? tuning?.effort ?? null,
        access: "ask",
        accountId: parentThread?.accountId ?? tab?.accountId ?? null,
        parentRef: ref,
      });
      setSelectedId(id);
      setDrafting(false);
      const sent = messageFor(threadKey(id), sideChatContext(items, question), attachments);
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
    if (!conversation || !answer || parentBusy || selectedWorking) return;
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

  if (!eligible || !conversation) {
    return <div className="flex-1 min-h-0 grid place-items-center p-8 text-center text-chat-note text-gray-500 dark:text-white/45">
      <div><SideChatIcon className="w-6 h-6 mx-auto mb-2 opacity-50" /><p>{t("chat.sideChat.unsupported")}</p></div>
    </div>;
  }

  const activeCard = selected ? cardForThread(selected, conversation, detected.find((row) => row.id === selected.agentId)?.label ?? selected.agentId) : null;
  const effectiveAccess = parentThread?.access === "plan" ? "ask" : parentThread?.access ?? access?.access ?? "ask";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-gray-200 dark:border-white/[0.08]">
        <SideChatIcon className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/50" />
        <span className="min-w-0 flex-1 truncate text-chat-ui font-medium">{t("chat.sideChat.title")}</span>
        <button type="button" onClick={() => { setSelectedId(null); setDrafting(true); setError(null); }}
          aria-label={t("chat.sideChat.new")} title={t("chat.sideChat.new")}
          className="w-7 h-7 rounded-md grid place-items-center text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.08]">
          <NewChatIcon className="w-4 h-4" />
        </button>
      </header>
      {sideChats.length > 0 && (
        <nav aria-label={t("chat.sideChat.list")} className="shrink-0 flex gap-1.5 overflow-x-auto cc-scroll-hidden px-3 py-2 border-b border-gray-200 dark:border-white/[0.08]">
          {sideChats.map((row) => (
            <div key={row.id} className={"shrink-0 h-7 max-w-[220px] flex items-center rounded-lg border text-chat-caption " +
              (selectedId === row.id ? "border-accent-500/40 bg-accent-500/10 text-gray-900 dark:text-white" : "border-gray-200 dark:border-white/10 text-gray-500 dark:text-white/50")}>
              <button type="button" onClick={() => { if (row.state === "settled") settleThread(row.id, false); setSelectedId(row.id); setDrafting(false); }}
                className="min-w-0 h-full px-2 truncate" title={row.title}>{row.title || t("chat.sideChat.title")}</button>
              <button type="button" onClick={() => void remove(row)} disabled={live[row.id]?.phase === "working"}
                aria-label={t("chat.sideChat.delete")} title={t("chat.sideChat.delete")}
                className="w-6 h-full grid place-items-center text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40">
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </nav>
      )}
      {error && <p role="alert" className="shrink-0 px-3 py-2 text-chat-caption text-red-600 dark:text-red-400 break-words">{error}</p>}
      {selected && activeCard ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-white/[0.08]">
            <button type="button" disabled={!answer || parentBusy || selectedWorking} onClick={bringBack}
              className="h-7 px-2 rounded-md text-chat-caption font-medium text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/[0.08] disabled:opacity-40">
              {t("chat.sideChat.bringBack")}
            </button>
          </div>
          <StructuredConversationView key={selected.id} card={activeCard} thread={selected} cards={cards} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto cc-scroll-hidden p-5">
            <p className="text-chat-note text-gray-500 dark:text-white/45">{drafting
              ? t("chat.sideChat.contextHint")
              : t("chat.sideChat.empty", { agent: conversation.agentLabel })}</p>
          </div>
          <div className="shrink-0 pb-3">
            <ChatComposer cwd={conversation.cwd} quoteKey={null} disabled={loading}
              placeholder={t("chat.sideChat.placeholder")}
              onSubmit={(text, attachments) => create(text, attachments)}
              controls={<span className="px-1.5 text-chat-caption text-gray-400 dark:text-white/35" title={t("chat.sideChat.supervised")}>{t("chat.sideChat.supervisedShort")}</span>} />
            <div className="flex justify-end px-4 pt-1 text-chat-caption text-gray-400 dark:text-white/35">
              {t("chat.sideChat.agent", { agent: conversation.agentLabel })} · {t("chat.access." + effectiveAccess)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
