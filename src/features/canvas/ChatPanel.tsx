import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
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
    <div className="pointer-events-auto absolute right-3 bottom-14 w-[26rem] h-[min(34rem,70%)] flex flex-col rounded-lg
      border border-gray-200 dark:border-white/10 bg-white/98 dark:bg-surface-raised/98 shadow-lg overflow-hidden">
      <div className="flex items-center gap-1 px-2 h-9 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="px-1 text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{t("canvas.chat.title")}</span>
        <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto">
          {agents.map((a) => (
            <Button key={a.id} variant="custom" onClick={() => setTabId(a.id)}
              className={`cc-t h-6 px-2 rounded-md text-[11.5px] font-medium shrink-0 max-w-32 truncate
                ${a.id === currentId
                  ? "bg-gray-100 dark:bg-white/12 text-gray-900 dark:text-white"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"}`}>
              {a.title}
            </Button>
          ))}
        </div>
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.chat.close")}
          className="cc-t w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      {!current ? (
        <p className="p-4 text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">{t("canvas.chat.noAgents")}</p>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 h-8 shrink-0 border-b border-gray-100 dark:border-white/6">
            {THREADS.map((th) => (
              <button key={th} type="button" onClick={() => setThread(th)}
                title={`${t(`canvas.chat.thread.${th}`)}${counts[th] ? ` · ${counts[th]}` : ""}`}
                aria-label={t(`canvas.chat.thread.${th}`)} aria-pressed={thread === th}
                className="cc-t relative w-4 h-4 rounded-full"
                style={{
                  background: THREAD_COLOR[th],
                  opacity: thread === th ? 1 : counts[th] ? 0.7 : 0.3,
                  boxShadow: thread === th ? `0 0 0 2px var(--color-surface-raised, white), 0 0 0 4px ${THREAD_COLOR[th]}` : undefined,
                }} />
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 ? (
              <p className="pt-6 text-center text-[12px] text-gray-400 dark:text-gray-500">{t("canvas.chat.empty")}</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex flex-col ${m.kind === "user" ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] px-2.5 py-1.5 rounded-lg text-[12.5px] leading-snug whitespace-pre-wrap break-words
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
              ))
            )}
            <div ref={bottom} />
          </div>

          <div className="flex items-end gap-2 p-2 shrink-0 border-t border-gray-200 dark:border-white/10">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={t("canvas.chat.placeholder", { name: current.title })}
              aria-label={t("canvas.chat.placeholder", { name: current.title })}
              className="flex-1 resize-none rounded-md px-2 py-1.5 text-[12.5px] outline-none bg-gray-50 dark:bg-white/5
                border border-gray-200 dark:border-white/10 focus:border-accent-400 text-gray-800 dark:text-gray-100"
            />
            <Button variant="custom" onClick={() => void send()} disabled={sending || !draft.trim()}
              className="cc-t h-8 px-3 rounded-md text-[12px] font-medium text-white bg-accent-500 hover:bg-accent-600 disabled:opacity-40">
              {sending ? "…" : t("canvas.chat.send")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
