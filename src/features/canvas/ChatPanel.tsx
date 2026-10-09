import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertaToast } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { AIChatCard } from "./AIChatCard";
import { agentTile } from "@/features/agents/agentTile";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";
import { useRepoInfo } from "@/features/workspaces/useRepoInfo";
import { open as pickFile } from "@tauri-apps/plugin-dialog";

const TOOL = "cc-t flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.05] hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.07] dark:hover:text-white";
import { unreadOf, useUnreadStore } from "./chatUnread";
import { useActiveBoardKey, boardKeyOfTab } from "./store";
import { ChatMarkdown } from "./ChatMarkdown";
import { ResponsePicker } from "./ResponsePicker";
import { CHAT_MARGIN, clampSize, isDefaultSize, loadChatSize, resizeBy, saveChatSize, DEFAULT_CHAT_SIZE, type ChatSize, type ChatSizeState } from "./chatSize";
import { dateLocale } from "@/i18n/dateLocale";

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

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

/**
 * El chat con un agente: globos en vez del flujo mezclado de su terminal, y siete hilos de
 * color para no mezclar conversaciones. Lo que escribís le llega con su hilo; él contesta
 * con `ags say` y aparece acá.
 *
 * Solo agentes: a una terminal de shell lo escrito se ejecutaría como comando (el backend
 * también lo rechaza).
 *
 * Las respuestas del agente se muestran como Markdown seguro (`ChatMarkdown`: sin HTML crudo,
 * enlaces solo http/https). Lo que escribe el usuario queda como texto plano.
 */
export function ChatPanel({ onClose, onNewAgent }: { onClose: () => void; onNewAgent: () => void }) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const allTabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const agents = useMemo(
    () => allTabs.filter((tab) => tab.agentId !== "bash" && key !== null && boardKeyOfTab(tab) === key),
    [allTabs, key],
  );
  const [tabId, setTabId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread>("blue");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<{ kind: "more" | "agent"; x: number; y: number } | null>(null);
  const [view, setView] = useState<ChatSizeState>(loadChatSize);
  // Marca dentro de la tarjeta: de ahí se llega a ella y al área que la contiene.
  const sentinel = useRef<HTMLSpanElement>(null);
  const area = () => {
    const box = sentinel.current?.parentElement?.parentElement;
    return { width: box?.clientWidth ?? 1200, height: box?.clientHeight ?? 800 };
  };
  const commit = (next: ChatSizeState) => { setView(next); saveChatSize(next); };
  const startResize = (edge: { left: boolean; top: boolean }) => (e: React.PointerEvent<HTMLElement>) => {
    if (view.maximized || e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = sentinel.current?.parentElement?.getBoundingClientRect();
    const start: ChatSize = rect ? { width: rect.width, height: rect.height } : view.size;
    const x0 = e.clientX, y0 = e.clientY;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = resizeBy(start, ev.clientX - x0, ev.clientY - y0, edge, area());
      setView({ size: last, maximized: false });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      commit({ size: last, maximized: false });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || view.maximized) return;
    e.preventDefault();
    // Izquierda/arriba agrandan: el panel está pegado abajo a la derecha.
    commit({ size: resizeBy(view.size, d[0], d[1], { left: true, top: true }, area()), maximized: false });
  };
  const toggleMax = () => commit({ ...view, maximized: !view.maximized });
  const clamped = clampSize(view.size, { width: 4000, height: 4000 });
  const sizeStyle: React.CSSProperties = view.maximized
    ? { width: `calc(100% - ${CHAT_MARGIN.x}px)`, height: `calc(100% - ${CHAT_MARGIN.y}px)` }
    : { width: clamped.width, height: clamped.height, maxWidth: `calc(100% - ${CHAT_MARGIN.x}px)`, maxHeight: `calc(100% - ${CHAT_MARGIN.y}px)` };
  const handleCls = "absolute z-20 bg-transparent hover:bg-accent-400/30 focus-visible:bg-accent-400/40 focus-visible:outline-none";
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
  const repos = useRepoInfo(current ? [current.cwd] : []);
  const branch = current ? repos.get(current.cwd)?.branch ?? null : null;

  // A resposta de um agente que já não está à vista não pode pintar por cima do atual.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const mine = ++loadSeq.current;
    if (!currentId) return setConversation(null);
    invoke<Conversation>("chat_history", { tabId: currentId })
      .then((c) => { if (mine === loadSeq.current) setConversation(c); })
      .catch(() => { if (mine === loadSeq.current) setConversation(null); });
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

  // Chat | Plano (prancheta 6): no Plano a mensagem vai com o pedido de planejar antes de mexer.
  const [mode, setMode] = useState<"chat" | "plan">("chat");
  const attach = async () => {
    try {
      const picked = await pickFile({ multiple: false, directory: false });
      if (typeof picked === "string" && picked) setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}${picked} `);
    } catch (e) {
      AlertaToast(t("canvas.chat.title"), String(e), "error", 6000);
    }
  };

  const send = async () => {
    const typed = draft.trim();
    const text = typed && mode === "plan" ? `${t("canvas.chat.planPrefix")}\n\n${typed}` : typed;
    if (!text || !currentId || sending) return;
    setSending(true);
    setDraft("");
    try {
      await invoke("chat_send", { tabId: currentId, thread, text });
    } catch (e) {
      // No llegó: se devuelve lo escrito para no perderlo.
      setDraft(typed);
      AlertaToast(t("canvas.chat.title"), String(e), "error", 6000);
    } finally {
      setSending(false);
      load();
    }
  };

  const moreItems: ContextMenuItem[] = [
    { key: "pick", label: t("canvas.chat.pick.open"), disabled: !current, onSelect: () => setPicking(true) },
    { key: "max", label: view.maximized ? t("canvas.chat.resize.unmaximize") : t("canvas.chat.resize.maximize"), hint: "Ctrl+Shift+M", onSelect: toggleMax },
    ...((!isDefaultSize(view.size) || view.maximized)
      ? [{ key: "reset", label: t("canvas.chat.resize.reset"), onSelect: () => commit({ size: DEFAULT_CHAT_SIZE, maximized: false }) }]
      : []),
    { key: "refresh", label: t("canvas.chat.refresh"), disabled: !current, onSelect: load },
    { key: "sound", label: sound ? t("canvas.chat.soundOn") : t("canvas.chat.soundOff"), onSelect: () => useUnreadStore.getState().setSound(!sound) },
    { key: "close", label: t("canvas.chat.close"), separator: true, hint: "Esc", onSelect: onClose },
  ];
  const agentItems: ContextMenuItem[] = agents.map((a) => ({
    key: a.id,
    label: `${a.id === currentId ? "✓ " : ""}${a.title.split(" — ")[0]}`,
    onSelect: () => setTabId(a.id),
  }));

  return (
    <AIChatCard
      className="pointer-events-auto absolute right-3 bottom-16"
      style={sizeStyle}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !picking) { e.stopPropagation(); onClose(); }
        else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMax(); }
      }}
      chrome={<>
        <span ref={sentinel} hidden />
        {!view.maximized && <>
          <div role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t("canvas.chat.resize.handle")} title={t("canvas.chat.resize.handle")}
            onPointerDown={startResize({ left: true, top: false })} onKeyDown={nudge}
            className={`${handleCls} left-0 top-4 bottom-4 w-1.5 cursor-ew-resize`} />
          <div role="separator" aria-orientation="horizontal" tabIndex={0} aria-label={t("canvas.chat.resize.handle")} title={t("canvas.chat.resize.handle")}
            onPointerDown={startResize({ left: false, top: true })} onKeyDown={nudge}
            className={`${handleCls} top-0 left-4 right-4 h-1.5 cursor-ns-resize`} />
          <div aria-hidden onPointerDown={startResize({ left: true, top: true })}
            className={`${handleCls} left-0 top-0 h-4 w-4 cursor-nwse-resize`} />
        </>}
        {menu && (
          <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.kind === "more" ? moreItems : agentItems} />
        )}
        {picking && current && <ResponsePicker tabId={current.id} onClose={() => setPicking(false)}
          onPick={(text) => { setDraft((d) => (d.trim() ? `${d.trimEnd()}

${text}` : text)); setPicking(false); }} />}
      </>}
      title={t("canvas.chat.title")}
      subtitle={current?.title ?? t("canvas.chat.subtitle")}
      heading={agents.length > 0 ? (
        <div className="flex min-w-0 gap-0.5 overflow-x-auto rounded-[9px] bg-black/[0.05] p-0.5 dark:bg-surface-raised" role="tablist" aria-label={t("canvas.chat.title")}>
          {agents.map((a) => (
            <button key={a.id} type="button" role="tab" onClick={() => setTabId(a.id)} title={a.title} aria-selected={a.id === currentId}
              className={`cc-t flex h-[26px] min-w-0 max-w-44 flex-1 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium
                ${a.id === currentId
                  ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-surface-overlay dark:text-[#f5f5f7] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                  : "text-gray-500 hover:text-gray-900 dark:text-white/55 dark:hover:text-white"}`}>
              <span className="truncate">{a.title.split(" — ")[0]}</span>
              {a.id !== currentId && unreadOf(unread[a.id]) > 0 && <Badge n={unreadOf(unread[a.id])} />}
            </button>
          ))}
        </div>
      ) : (
        <div className="px-1">
          <h3 className="text-[15px] font-semibold leading-5 tracking-[-0.01em]">{t("canvas.chat.title")}</h3>
        </div>
      )}
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
      composerHint={current && <span className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={() => void attach()} title={t("canvas.chat.attach")} aria-label={t("canvas.chat.attach")} className={TOOL}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
        </button>
        <button type="button" onClick={() => setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@`)} title={t("canvas.chat.mention")} aria-label={t("canvas.chat.mention")} className={TOOL}>
          <span className="text-[14px] font-medium leading-none">@</span>
        </button>
        <button type="button" title={current.title} aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: "agent", x: r.left, y: r.top - 8 - 30 * Math.max(1, agents.length) }); }}
          className="ml-1 flex h-[26px] min-w-0 items-center gap-1.5 rounded-md bg-black/[0.05] pl-2 pr-1.5 text-[12.5px] text-gray-800 hover:bg-black/[0.08] dark:bg-surface-raised dark:text-[#f5f5f7] dark:hover:brightness-110">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: agentTile(current.agentId) }} />
          <span className="truncate">{current.agentLabel}</span>
          <svg viewBox="0 0 18 18" aria-hidden className="h-3 w-3 shrink-0 text-gray-400 dark:text-white/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 7.5 3.5-3.5 3.5 3.5M5.5 10.5 9 14l3.5-3.5" /></svg>
        </button>
      </span>}
      composerRight={current && (
        <span role="radiogroup" aria-label={t("canvas.chat.mode")} className="flex shrink-0 rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.07]">
          {(["chat", "plan"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              title={m === "plan" ? t("canvas.chat.planHint") : undefined}
              className={`h-[22px] rounded-[5px] px-2 text-[11.5px] font-medium ${mode === m
                ? "bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-surface-overlay dark:text-white"
                : "text-gray-500 hover:text-gray-900 dark:text-white/50 dark:hover:text-white"}`}>
              {t(`canvas.chat.mode.${m}`)}
            </button>
          ))}
        </span>
      )}
      actions={<>
        <button type="button" onClick={onNewAgent} title={t("canvas.chat.newAgent")} aria-label={t("canvas.chat.newAgent")}
          className="cc-t flex h-[26px] w-[26px] items-center justify-center rounded-md bg-black/[0.05] text-gray-600 hover:text-gray-900 dark:bg-surface-raised dark:text-white/70 dark:hover:text-white">
          <svg viewBox="0 0 18 18" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M9 3.5v11M3.5 9h11" /></svg>
        </button>
        <button type="button" aria-label={t("settings.accounts.more")} title={t("settings.accounts.more")}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: "more", x: r.right - 210, y: r.bottom + 4 }); }}
          className="cc-t flex h-[26px] w-[26px] items-center justify-center rounded-md text-gray-500 hover:bg-black/[0.05] hover:text-gray-900 dark:text-white/55 dark:hover:bg-white/[0.07] dark:hover:text-white">
          <svg viewBox="0 0 18 18" aria-hidden className="h-4 w-4" fill="currentColor"><circle cx="4" cy="9" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="14" cy="9" r="1.3" /></svg>
        </button>
      </>}
      toolbar={current && <div className="flex h-7 shrink-0 items-center gap-2 px-4 pb-1">
          <svg viewBox="0 0 18 18" aria-hidden className="h-3 w-3 shrink-0 text-gray-400 dark:text-white/35" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><circle cx="5" cy="4" r="1.7" /><circle cx="5" cy="14" r="1.7" /><circle cx="13" cy="6" r="1.7" /><path d="M5 5.7v6.6" /><path d="M13 7.7c0 2.9-8 1.9-8 4.6" /></svg>
          <span title={current.cwd} className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-500 dark:text-white/45">{branch ?? current.cwd}</span>
          {THREADS.map((th) => (
            <button key={th} type="button" onClick={() => setThread(th)}
              title={`${t(`canvas.chat.thread.${th}`)}${counts[th] ? ` · ${counts[th]}` : ""}`}
              aria-label={t(`canvas.chat.thread.${th}`)} aria-pressed={thread === th}
              className="cc-t relative h-2.5 w-2.5 shrink-0 rounded-full hover:scale-110"
              style={{
                background: THREAD_COLOR[th],
                opacity: thread === th ? 1 : counts[th] ? 0.7 : 0.3,
                boxShadow: thread === th ? `0 0 0 1.5px var(--color-surface, white), 0 0 0 3px ${THREAD_COLOR[th]}` : undefined,
              }}>
              {th !== thread && (unread[current.id]?.[th] ?? 0) > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-red-500 text-white
                  text-[8.5px] font-bold leading-[13px] text-center">{unread[current.id][th]}</span>
              )}
            </button>
          ))}
      </div>}
    >
      {current && messages.length > 0 ? <div className="space-y-4 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-4 dark:[&_pre]:bg-surface-deep [&_code]:font-mono [&_code]:text-[12px]" role="log" aria-label={t("canvas.chat.title")}>
              {messages.map((m) => (
                <div key={m.id} className={`flex flex-col ${m.kind === "user" ? "items-end" : "items-stretch"}`}>
                  {m.kind !== "user" && current && (
                    <div className="mb-1 flex items-center gap-1.5 text-[11.5px] leading-4">
                      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: agentTile(current.agentId) }} />
                      <span className="font-semibold text-gray-900 dark:text-[#f5f5f7]">{current.title.split(" — ")[0]}</span>
                      <span className="text-gray-500 dark:text-white/50">{current.agentLabel}</span>
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.at)}</span>
                    </div>
                  )}
                  <div
                    className={`px-3.5 py-2 text-[13px] leading-[19px] break-words ${m.kind === "user"
                      ? "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent-500 text-white"
                      : m.kind === "progress"
                        ? "rounded-xl border border-black/[0.1] text-[12px] text-gray-600 dark:border-[rgba(84,84,88,0.55)] dark:text-white/60"
                        : "rounded-[14px] bg-gray-100 text-gray-900 dark:bg-surface-raised dark:text-[#f5f5f7]"}`}
                  >
                    {m.kind === "user" ? m.text : <ChatMarkdown text={m.text} />}
                  </div>
                  {m.kind === "user" && <span className="mt-1 font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35">{clock(m.at)}</span>}
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
