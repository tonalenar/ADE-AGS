import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { AIChatCard } from "./AIChatCard";
import { unreadOf, useUnreadStore } from "./chatUnread";
import { useActiveBoardKey, boardKey } from "./store";

/** Los siete hilos, en el orden en que los conoce el backend (`chat::THREADS`). */
export const THREADS = ["blue", "purple", "pink", "red", "orange", "yellow", "green"] as const;
export type Thread = (typeof THREADS)[number];

export const THREAD_COLOR: Record<Thread, string> = {
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
};

export interface ChatMessage {
  id: string;
  thread: Thread;
  kind: "user" | "say" | "progress";
  text: string;
  at: number;
}

interface Conversation {
  currentThread: string;
  messages: ChatMessage[];
}

/** Los mensajes de un hilo, en orden. */
export function inThread(messages: ChatMessage[], thread: Thread): ChatMessage[] {
  return messages.filter((m) => m.thread === thread);
}

/** Cuántos mensajes de cada hilo (para marcar cuáles tienen conversación). */
export function threadCounts(messages: ChatMessage[]): Record<Thread, number> {
  const counts = Object.fromEntries(THREADS.map((t) => [t, 0])) as Record<Thread, number>;
  for (const m of messages) if (m.thread in counts) counts[m.thread] += 1;
  return counts;
}

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * El chat con un agente: globos en vez del flujo mezclado de su terminal, y siete hilos de
 * color para no mezclar conversaciones. Lo que escribís le llega con su hilo; él contesta
 * con `ccode say` y aparece acá.
 *
 * Solo agentes: a una terminal de shell lo escrito se ejecutaría como comando (el backend
 * también lo rechaza).
 *
 * El texto de los globos se muestra como texto plano: lo escribió un agente y no se
 * interpreta.
 */
export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const allTabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const agents = useMemo(
    () => allTabs.filter((tab) => tab.agentId !== "bash" && key !== null && boardKey(tab.cwd) === key),
    [allTabs, key],
  );
  const [tabId, setTabId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread>("blue");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const unread = useUnreadStore((s) => s.unread);
  const sound = useUnreadStore((s) => s.sound);
  const jump = useUnreadStore((s) => s.jump);

  // Se llegó desde un aviso del sistema: se abre ese agente en ese hilo.
  useEffect(() => {
    if (!jump) return;
    if ((THREADS as readonly string[]).includes(jump.thread)) setThread(jump.thread as Thread);
    setTabId(jump.tabId);
    useUnreadStore.getState().setJump(null);
  }, [jump]);

  // Con quién se habla: el agente activo si sirve, si no el primero.
  const current = agents.find((a) => a.id === tabId) ?? agents.find((a) => a.id === activeTabId) ?? agents[0];
  const currentId = current?.id ?? null;

  const load = useCallback(() => {
    if (!currentId) return setConversation(null);
    invoke<Conversation>("chat_history", { tabId: currentId }).then(setConversation).catch(() => setConversation(null));
  }, [currentId]);

  useEffect(() => {
    load();
    const off = listen<string>("cc-chat-changed", (e) => {
      if (e.payload === currentId) load();
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [load, currentId]);

  // Al abrir un agente se cae en el hilo donde quedó la conversación.
  useEffect(() => {
    const last = conversation?.currentThread;
    if (last && (THREADS as readonly string[]).includes(last)) setThread(last as Thread);
    // Solo al cambiar de agente: durante la charla el hilo lo elige quien mira.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const messages = useMemo(() => inThread(conversation?.messages ?? [], thread), [conversation, thread]);
  const counts = useMemo(() => threadCounts(conversation?.messages ?? []), [conversation]);

  // Lo que está a la vista cuenta como leído: al abrir, al cambiar de hilo y cuando llega algo nuevo.
  const visibleUnread = currentId ? unread[currentId]?.[thread] ?? 0 : 0;
  useEffect(() => {
    if (currentId && conversation) useUnreadStore.getState().markSeen(currentId, thread, conversation.messages);
  }, [currentId, thread, conversation, visibleUnread]);

  // Mientras el panel está abierto, lo que se mira no suena; al cerrarlo, todo vuelve a sonar.
  useEffect(() => {
    useUnreadStore.getState().setViewing(currentId ? { tabId: currentId, thread } : null);
    return () => useUnreadStore.getState().setViewing(null);
  }, [currentId, thread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, thread, currentId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !currentId || sending) return;
    setSending(true);
    setDraft("");
    try {
      await invoke("chat_send", { tabId: currentId, thread, text });
    } catch (e) {
      // No llegó: se devuelve lo escrito para no perderlo.
      setDraft(text);
      AlertaToast(t("canvas.chat.title"), String(e), "error", 6000);
    } finally {
      setSending(false);
      load();
    }
  };

  return (
    <AIChatCard
      className="pointer-events-auto absolute right-3 bottom-16 w-[26rem] max-w-[calc(100%-1.5rem)] h-[min(34rem,70%)]"
      title={t("canvas.chat.title")}
      subtitle={current?.title ?? t("canvas.chat.subtitle")}
      greeting={t("canvas.chat.greeting")}
      prompt={t(current ? "canvas.chat.empty" : "canvas.chat.noAgents")}
      placeholder={t("canvas.chat.composerPlaceholder")}
      inputLabel={t("canvas.chat.placeholder", { name: current?.title ?? "" })}
      sendLabel={t("canvas.chat.send")}
      message={draft}
      onMessageChange={setDraft}
      onSend={() => void send()}
      busy={sending}
      disabled={!current}
      composerHint={current && <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: THREAD_COLOR[thread] }} />
        {t(`canvas.chat.thread.${thread}`)}
      </span>}
      actions={<>
        <button type="button" onClick={load} disabled={!current} title={t("canvas.chat.refresh")} aria-label={t("canvas.chat.refresh")}
          className="cc-t flex h-[30px] w-[30px] items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:text-gray-900 active:rotate-180 disabled:opacity-40 dark:border-white/12 dark:text-gray-400 dark:hover:text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
            <path d="M20 11a8 8 0 1 0-2.4 6.4M20 4v7h-7" />
          </svg>
        </button>
        <Button variant="custom" onClick={() => useUnreadStore.getState().setSound(!sound)} aria-pressed={sound}
          title={sound ? t("canvas.chat.soundOn") : t("canvas.chat.soundOff")} aria-label={sound ? t("canvas.chat.soundOn") : t("canvas.chat.soundOff")}
          className="cc-t w-[30px] h-[30px] shrink-0 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden>
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            {sound ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="m16 9 5 6M21 9l-5 6" />}
          </svg>
        </Button>
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.chat.close")}
          className="cc-t w-[30px] h-[30px] shrink-0 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
          <CloseIcon className="w-3.5 h-3.5" />
        </Button>
      </>}
      toolbar={current && <div className="shrink-0 border-b border-gray-100 dark:border-white/6">
        {agents.length > 1 && <div className="flex gap-1.5 overflow-x-auto px-5 pt-3 pb-1">
          {agents.map((a) => (
            <button key={a.id} type="button" onClick={() => setTabId(a.id)} title={a.title} aria-pressed={a.id === currentId}
              className={`cc-t flex h-7 max-w-40 shrink-0 items-center rounded-full px-2.5 text-[11px] font-medium
                ${a.id === currentId
                  ? "bg-gray-900 text-white dark:bg-white dark:text-gray-950"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/6 dark:text-gray-400 dark:hover:bg-white/10"}`}>
              <span className="truncate">{a.title}</span>
              {a.id !== currentId && unreadOf(unread[a.id]) > 0 && <Badge n={unreadOf(unread[a.id])} />}
            </button>
          ))}
        </div>}
          <div className="flex items-center gap-2.5 px-5 h-11">
            {THREADS.map((th) => (
              <button key={th} type="button" onClick={() => setThread(th)}
                title={`${t(`canvas.chat.thread.${th}`)}${counts[th] ? ` · ${counts[th]}` : ""}`}
                aria-label={t(`canvas.chat.thread.${th}`)} aria-pressed={thread === th}
                className="cc-t relative w-4 h-4 rounded-full hover:scale-110"
                style={{
                  background: THREAD_COLOR[th],
                  opacity: thread === th ? 1 : counts[th] ? 0.7 : 0.3,
                  boxShadow: thread === th ? `0 0 0 2px var(--color-surface-raised, white), 0 0 0 4px ${THREAD_COLOR[th]}` : undefined,
                }}>
                {th !== thread && (unread[current.id]?.[th] ?? 0) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-red-500 text-white
                    text-[8.5px] font-bold leading-[13px] text-center">{unread[current.id][th]}</span>
                )}
              </button>
            ))}
          </div>
      </div>}
    >
      {current && messages.length > 0 ? <div className="space-y-3" role="log" aria-label={t("canvas.chat.title")}>
              {messages.map((m) => (
                <div key={m.id} className={`flex flex-col ${m.kind === "user" ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] px-3 py-2 rounded-[16px] text-[12.5px] leading-relaxed whitespace-pre-wrap break-words
                      ${m.kind === "user"
                        ? "text-white"
                        : m.kind === "progress"
                          ? "italic text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-white/4"
                          : "text-gray-800 dark:text-gray-100 bg-gray-100 dark:bg-white/8"}`}
                    style={m.kind === "user" ? { background: THREAD_COLOR[thread] } : undefined}
                  >
                    {m.text}
                  </div>
                  <span className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">{clock(m.at)}</span>
                </div>
              ))}
            <div ref={bottom} />
      </div> : undefined}
    </AIChatCard>
  );
}

/** El globito rojo con la cantidad de respuestas sin leer. */
export function Badge({ n }: { n: number }) {
  return (
    <span className="ml-1 inline-flex min-w-[15px] h-[15px] px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
      {n > 9 ? "9+" : n}
    </span>
  );
}
