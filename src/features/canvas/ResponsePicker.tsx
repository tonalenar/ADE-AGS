import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { screenOf, selectionOf } from "@/features/terminal/terminalRegistry";
import { segmentResponses } from "@/features/terminal/responseSegments";

/**
 * Elegir QUÉ de la terminal del agente pasa al chat: una respuesta entera (se resalta al pasar el
 * mouse o con las flechas), o la selección libre que el usuario tenga hecha en la terminal.
 * Nada se envía solo: lo elegido va al campo de mensaje y el usuario decide si lo manda.
 *
 * Teclado: ↑/↓ mueven, Enter elige, Esc cierra.
 */
export function ResponsePicker({ tabId, onPick, onClose }: { tabId: string; onPick: (text: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const selection = useMemo(() => selectionOf(tabId).trim(), [tabId, version]);
  const segments = useMemo(() => {
    const screen = screenOf(tabId, 0, 5000);
    return screen ? segmentResponses(screen.lines).reverse() : [];
  }, [tabId, version]);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const options = [...(selection ? [{ key: "sel", label: t("canvas.chat.pick.selection"), text: selection }] : []),
    ...segments.map((s) => ({ key: `r${s.index}`, label: s.prompt ?? t("canvas.chat.pick.noPrompt"), text: s.text }))];

  useEffect(() => { root.current?.focus(); }, []);
  useEffect(() => { if (active >= options.length) setActive(Math.max(0, options.length - 1)); }, [options.length, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && options[active]) { e.preventDefault(); onPick(options[active].text); }
  };

  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("canvas.chat.pick.title")} onKeyDown={onKeyDown}
      className="absolute inset-0 z-10 flex flex-col bg-white/95 backdrop-blur-sm outline-none dark:bg-surface-deep/95">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-white/10">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium">{t("canvas.chat.pick.title")}</h4>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">{t("canvas.chat.pick.hint")}</p>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setVersion((v) => v + 1)} className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] dark:border-white/12">{t("canvas.chat.refresh")}</button>
          <button type="button" onClick={onClose} aria-label={t("canvas.chat.close")} className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] dark:border-white/12">Esc</button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" role="listbox" aria-label={t("canvas.chat.pick.title")}>
        {options.length === 0 && <li className="p-4 text-center text-[12px] text-gray-500">{t("canvas.chat.pick.empty")}</li>}
        {options.map((o, i) => (
          <li key={o.key} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)}
            className={`rounded-xl border p-2.5 transition-colors ${i === active
              ? "border-accent-400 bg-accent-50 dark:border-accent-400/60 dark:bg-accent-400/10"
              : "border-gray-200 dark:border-white/10"}`}>
            <p className="truncate text-[10.5px] font-medium text-gray-500 dark:text-gray-400">{o.label}</p>
            <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-sans text-[12px] leading-snug">{o.text}</pre>
            <button type="button" onClick={() => onPick(o.text)} aria-label={`${t("canvas.chat.pick.send")}: ${o.label}`}
              className="mt-1.5 rounded-full bg-gray-950 px-3 py-1 text-[11px] font-medium text-white dark:bg-white dark:text-gray-950">
              {o.key === "sel" ? t("canvas.chat.pick.sendSelection") : t("canvas.chat.pick.send")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
