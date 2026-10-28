import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon } from "neogestify-ui-components";

import { PenIcon, SendIcon } from "@/app/icons";

import { peerQueueCancel, peerQueueEdit, peerQueueList, peerQueueMove, peerQueueSendNow } from "./ipc";
import { ageOf, canMove, firstLine } from "./model";
import { ensurePeerQueueSync, usePeerQueueStore } from "./store";
import type { PeerMessage } from "./types";

interface Props {
  tabId: string;
  /** O nome do agente, no título da lista. */
  name: string;
  /** `tab`: só o número (a aba é estreita). `node`: "N na fila". */
  variant: "tab" | "node";
}

/**
 * O selo "N na fila" de um terminal: as mensagens de outros agentes que esperam ele terminar o
 * turno. Clicar abre a lista, onde o usuário edita, reordena, cancela ou manda já cada uma.
 * Sem nada na fila, não aparece.
 */
export function PeerQueueBadge({ tabId, name, variant }: Props) {
  const { t } = useTranslation();
  useEffect(() => ensurePeerQueueSync(), []);
  const count = usePeerQueueStore((s) => s.counts[tabId] ?? 0);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (count === 0 && !open) return null;

  // O clique não pode ativar/arrastar a aba nem o nó do canvas.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    // Na aba, abre espaço para o X de fechar, que aparece por cima no hover.
    <span ref={anchor} className={`nodrag shrink-0 inline-flex ${variant === "tab" ? "group-hover:mr-3.5" : ""}`}
      onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop}>
      <Button variant="custom"
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={t("peerQueue.badgeTitle")}
        aria-label={t("peerQueue.badge", { count })}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`cc-t inline-flex items-center gap-1 rounded-full font-medium tabular-nums
          bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25
          ${variant === "tab" ? "h-4 px-1.5 text-[10px]" : "h-[18px] px-[7px] text-[10.5px]"}`}
      >
        <QueueIcon className={variant === "tab" ? "w-2.5 h-2.5" : "w-3 h-3"} />
        {variant === "tab" ? count : t("peerQueue.badge", { count })}
      </Button>
      {open && <PeerQueuePopover tabId={tabId} name={name} anchor={anchor} onClose={close} />}
    </span>
  );
}

function QueueIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M3 4h10M3 8h10M3 12h6" />
    </svg>
  );
}

function ArrowIcon({ up, className }: { up: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {up ? <path d="M8 13V3M4 7l4-4 4 4" /> : <path d="M8 3v10M4 9l4 4 4-4" />}
    </svg>
  );
}

const WIDTH = 380;

function PeerQueuePopover({ tabId, name, anchor, onClose }: {
  tabId: string;
  name: string;
  anchor: React.RefObject<HTMLSpanElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const version = usePeerQueueStore((s) => s.version);
  const [items, setItems] = useState<PeerMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [armedCancel, setArmedCancel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    peerQueueList(tabId).then(setItems).catch((e) => setError(String(e)));
  }, [tabId]);
  useEffect(reload, [reload, version]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Embaixo do selo, alinhado à direita dele, dentro da janela.
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
    const top = r.bottom + 6;
    setPos({ left, top, maxHeight: Math.max(160, window.innerHeight - top - 12) });
  }, [anchor]);

  // Na camada de cima: o terminal vivo do canvas é desenhado por cima dos nós.
  useLayoutEffect(() => {
    const el = panel.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    if (!pos || !el?.showPopover) return;
    try { el.showPopover(); } catch { /* sem suporte: fica o z-index */ }
  }, [pos]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !editing) onClose(); };
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose, editing]);

  /** Roda uma ação e recarrega a lista. `false` se deu erro (o erro aparece no topo). */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
      reload();
    }
  };

  const kindLabel = (kind: string) => t(`peerQueue.kind.${["ask", "handoff", "role", "notice"].includes(kind) ? kind : "tell"}`);
  const list = items ?? [];

  if (!pos) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={t("peerQueue.title", { name })}
      {...{ popover: "manual" }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: "auto", margin: 0, border: 0, left: pos.left, top: pos.top, width: WIDTH, maxHeight: pos.maxHeight, zIndex: 10050, color: "inherit" }}
      className="nodrag flex flex-col overflow-hidden rounded-xl shadow-xl ring-1 ring-black/10 dark:ring-white/10 bg-white dark:bg-surface-raised text-[12.5px] text-gray-800 dark:text-gray-100"
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-black/[0.06] dark:border-white/[0.08]">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{t("peerQueue.title", { name })}</span>
          <span className="text-[11px] text-gray-500 dark:text-white/50">{t("peerQueue.hint")}</span>
        </span>
        <Button variant="custom" onClick={onClose} aria-label={t("peerQueue.close")} title={t("peerQueue.close")}
          className="cc-t w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:bg-black/5 dark:hover:bg-white/10">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      {error && <div role="alert" className="px-3 py-1.5 text-[11.5px] text-red-600 dark:text-red-400">{t("peerQueue.error", { error })}</div>}

      <ol className="flex-1 overflow-y-auto">
        {items !== null && list.length === 0 && (
          <li className="px-3 py-4 text-center text-gray-500 dark:text-white/50">{t("peerQueue.empty")}</li>
        )}
        {list.map((m, index) => {
          const age = ageOf(now, m.createdAt);
          const queued = m.state === "queued";
          const isEditing = editing?.id === m.id;
          return (
            <li key={m.id} className="px-3 py-2 border-b last:border-b-0 border-black/[0.05] dark:border-white/[0.06]">
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/55">
                <span className="font-mono tabular-nums text-gray-400 dark:text-white/35">#{m.id}</span>
                <span className="font-medium text-gray-700 dark:text-white/80">{kindLabel(m.kind)}</span>
                <span className="truncate">{t("peerQueue.from", { name: m.fromName })}</span>
                <span className="shrink-0">· {t("peerQueue.age", { age: t(age.key, { n: age.n }) })}</span>
                {m.editedAt != null && <span className="shrink-0 italic">· {t("peerQueue.edited")}</span>}
                {!queued && <span className="ml-auto shrink-0 text-accent-600 dark:text-accent-300">{t("peerQueue.delivering")}</span>}
                {queued && m.forceNow && <span className="ml-auto shrink-0 text-accent-600 dark:text-accent-300">{t("peerQueue.forced")}</span>}
              </div>

              {isEditing ? (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  <textarea
                    value={editing.text}
                    autoFocus
                    rows={5}
                    aria-label={t("peerQueue.edit")}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && editing.text.trim()) {
                        void run(() => peerQueueEdit(m.id, editing.text)).then((ok) => { if (ok) setEditing(null); });
                      }
                    }}
                    className="w-full resize-y rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-[12px] font-mono outline-none focus:border-accent-500"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button variant="custom" onClick={() => setEditing(null)}
                      className="cc-t h-6 px-2 rounded-md text-[11.5px] text-gray-600 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10">
                      {t("peerQueue.discard")}
                    </Button>
                    <Button variant="custom" disabled={busy || !editing.text.trim()}
                      onClick={() => void run(() => peerQueueEdit(m.id, editing.text)).then((ok) => { if (ok) setEditing(null); })}
                      className="cc-t h-6 px-2.5 rounded-md text-[11.5px] font-medium bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50">
                      {t("peerQueue.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <p title={m.text} className="mt-1 break-words text-[12px] text-gray-800 dark:text-gray-100">
                  {firstLine(m.text, 240)}
                </p>
              )}

              {queued && !isEditing && (
                <div className="mt-1.5 flex items-center gap-1">
                  <IconButton label={t("peerQueue.moveUp")} disabled={busy || !canMove(list, index, -1)}
                    onClick={() => void run(() => peerQueueMove(m.id, -1))}>
                    <ArrowIcon up className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label={t("peerQueue.moveDown")} disabled={busy || !canMove(list, index, 1)}
                    onClick={() => void run(() => peerQueueMove(m.id, 1))}>
                    <ArrowIcon up={false} className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label={t("peerQueue.edit")} disabled={busy}
                    onClick={() => { setArmedCancel(null); setEditing({ id: m.id, text: m.text }); }}>
                    <PenIcon className="w-3.5 h-3.5" />
                  </IconButton>
                  <span className="flex-1" />
                  <Button variant="custom" disabled={busy} title={t("peerQueue.sendNowHint")}
                    onClick={() => void run(() => peerQueueSendNow(m.id))}
                    className="cc-t inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11.5px] font-medium text-accent-600 dark:text-accent-300 hover:bg-accent-500/10 disabled:opacity-50">
                    <SendIcon className="w-3 h-3" />
                    {t("peerQueue.sendNow")}
                  </Button>
                  <Button variant="custom" disabled={busy}
                    title={armedCancel === m.id ? t("peerQueue.cancelConfirm") : t("peerQueue.cancel")}
                    onClick={() => {
                      if (armedCancel === m.id) { setArmedCancel(null); void run(() => peerQueueCancel(m.id)); }
                      else setArmedCancel(m.id);
                    }}
                    className={`cc-t h-6 px-2 rounded-md text-[11.5px] font-medium disabled:opacity-50 ${armedCancel === m.id
                      ? "bg-red-500 text-white hover:bg-red-600"
                      : "text-gray-500 dark:text-white/60 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10"}`}>
                    {armedCancel === m.id ? t("peerQueue.cancelConfirm") : t("peerQueue.cancel")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>,
    document.body,
  );
}

function IconButton({ label, disabled, onClick, children }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant="custom" disabled={disabled} onClick={onClick} title={label} aria-label={label}
      className="cc-t w-6 h-6 flex items-center justify-center rounded-md text-gray-500 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30">
      {children}
    </Button>
  );
}
