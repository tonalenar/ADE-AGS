import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesignComment } from "@/features/canvas/design/designApi";

export interface PinItem { id: string; n: number; x: number; y: number; active: boolean; draft?: boolean }

/** Os pinos âmbar no mundo, em tamanho constante na tela, com a ponta (canto de baixo à esquerda) no ponto. */
export function CommentPins({ pins, onOpen }: { pins: PinItem[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      {pins.map((p) => (
        <button key={p.id} type="button" aria-label={t("design.comments.pin", { n: p.n })}
          onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpen(p.id)}
          className="absolute origin-bottom-left" style={{ left: p.x, top: p.y, transform: "translateY(-100%) scale(var(--inv))" }}>
          <span className={`flex w-6 h-6 items-center justify-center rounded-full rounded-bl-none text-[11px] font-semibold tabular-nums
            bg-amber-400 text-gray-900 shadow-[0_1px_3px_rgba(0,0,0,0.25)]
            ${p.active ? "ring-2 ring-amber-400/50 ring-offset-1 ring-offset-white dark:ring-offset-surface-deep" : ""}`}>
            {p.draft ? "+" : p.n}
          </span>
        </button>
      ))}
    </>
  );
}

const popCls = `absolute z-40 w-72 rounded-xl bg-white dark:bg-surface-raised p-2.5 text-[13px] text-gray-800 dark:text-white/85
  shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]`;
const btn = `h-7 px-2.5 rounded-md text-[12.5px] font-medium hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none`;
const primary = `h-7 px-2.5 rounded-md text-[12.5px] font-medium bg-amber-400 text-gray-900 hover:bg-amber-300 disabled:opacity-40 disabled:pointer-events-none`;

/** Posição do popover junto do pino, sem sair da área (largura 288, altura estimada). */
export function popoverPlacement(sx: number, sy: number, width: number, height: number, est = 220): { left: number; top: number } {
  const left = Math.min(Math.max(8, sx + 16), Math.max(8, width - 296));
  const top = Math.min(Math.max(8, sy - 12), Math.max(8, height - est));
  return { left, top };
}

/** O compositor de um comentário novo: o rótulo do que foi apontado, o texto e as duas saídas. */
export function CommentComposer({ at, label, onSubmit, onCancel }: {
  at: { left: number; top: number };
  label: string;
  onSubmit: (text: string, send: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const ok = text.trim().length > 0;
  return (
    <div className={popCls} style={at} data-studio-popover="" onPointerDown={(e) => e.stopPropagation()}>
      {label && <div className="mb-1.5 truncate text-[11.5px] text-gray-500 dark:text-white/45" title={label}>{label}</div>}
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("design.comments.placeholder")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) onSubmit(text.trim(), false);
        }}
        className="w-full h-20 resize-none rounded-md bg-gray-50 dark:bg-white/[0.05] p-2 outline-none ring-1 ring-gray-200 dark:ring-white/10 focus:ring-amber-400" />
      <div className="mt-2 flex items-center gap-1">
        <button type="button" className={btn} onClick={onCancel}>{t("design.comments.cancel")}</button>
        <span className="flex-1" />
        <button type="button" className={btn} disabled={!ok} onClick={() => onSubmit(text.trim(), true)} title={t("design.comments.sendHint")}>{t("design.comments.send")}</button>
        <button type="button" className={primary} disabled={!ok} onClick={() => onSubmit(text.trim(), false)}>{t("design.comments.add")}</button>
      </div>
    </div>
  );
}

/** Um fio aberto: o comentário, as respostas, responder, resolver e mandar ao agente. */
export function CommentThread({ at, root, replies, label, onReply, onResolve, onSend, onClose }: {
  at: { left: number; top: number };
  root: DesignComment;
  replies: DesignComment[];
  label: string;
  onReply: (text: string) => void;
  onResolve: () => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const who = (c: DesignComment) => (c.author === "user" ? t("design.comments.you") : t("design.comments.agent"));
  return (
    <div className={popCls} style={at} data-studio-popover="" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-gray-500 dark:text-white/45" title={label}>{label}</span>
        <button type="button" className={btn} onClick={onResolve}>{root.resolved ? t("design.comments.reopen") : t("design.comments.resolve")}</button>
        <button type="button" className={btn} onClick={onClose} aria-label={t("design.comments.close")}>×</button>
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {[root, ...replies].map((c) => (
          <li key={c.id}>
            <div className="text-[11px] font-medium text-gray-500 dark:text-white/50">{who(c)}</div>
            <div className="whitespace-pre-wrap break-words">{c.text}</div>
          </li>
        ))}
      </ul>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("design.comments.reply")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { onReply(text.trim()); setText(""); }
        }}
        className="mt-2 w-full h-14 resize-none rounded-md bg-gray-50 dark:bg-white/[0.05] p-2 outline-none ring-1 ring-gray-200 dark:ring-white/10 focus:ring-amber-400" />
      <div className="mt-2 flex items-center gap-1">
        <button type="button" className={btn} onClick={onSend} title={t("design.comments.sendHint")}>{t("design.comments.send")}</button>
        <span className="flex-1" />
        <button type="button" className={primary} disabled={!text.trim()} onClick={() => { onReply(text.trim()); setText(""); }}>{t("design.comments.replyBtn")}</button>
      </div>
    </div>
  );
}
