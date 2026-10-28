import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Pet, usePetStatus } from "./Pet";
import { useBotToastStore, type BotToast, type BotToastTone } from "./botToastStore";

const TONE: Record<BotToastTone, string> = {
  info: "border-accent-400/50",
  warning: "border-amber-400/60",
  error: "border-red-400/60",
};

function Item({ toast, level }: { toast: BotToast; level: number }) {
  const { t } = useTranslation();
  const dismiss = useBotToastStore((state) => state.dismiss);

  useEffect(() => {
    if (toast.sticky) return;
    const timer = window.setTimeout(() => dismiss(toast.id), toast.ms);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id, toast.ms, toast.sticky]);

  return (
    <div role="status" className="pointer-events-auto flex items-end gap-1.5">
      {/* El bot "doidão": toma la forma que le toca por nivel y por cuántos agentes trabajan. */}
      <Pet level={level} state="working" size={56} className="shrink-0" />
      <div className={`relative max-w-[320px] rounded-2xl rounded-bl-sm border bg-white/97 dark:bg-surface-raised/97 shadow-xl px-3 py-2 ${TONE[toast.tone]}`}>
        <button
          type="button"
          aria-label={t("btn.close")}
          onClick={() => dismiss(toast.id)}
          className="absolute top-1 right-1.5 text-[13px] leading-none text-gray-400 hover:text-gray-700 dark:hover:text-white"
        >
          ×
        </button>
        <div className="pr-4 text-[12px] font-semibold text-gray-900 dark:text-white">{toast.title}</div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-gray-600 dark:text-gray-300">{toast.text}</div>
        {toast.progress !== undefined && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={toast.progress ?? undefined}
            className="mt-2 flex items-center gap-2"
          >
            <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
              <div
                className={`h-full rounded-full bg-accent-500 transition-[width] duration-500 ${toast.progress === null ? "w-1/3 animate-pulse" : ""}`}
                style={toast.progress === null ? undefined : { width: `${Math.max(0, Math.min(100, toast.progress))}%` }}
              />
            </div>
            {toast.progress !== null && (
              <span className="w-8 text-right text-[10.5px] tabular-nums text-gray-500 dark:text-gray-400">{Math.round(toast.progress)}%</span>
            )}
          </div>
        )}
        {toast.actionLabel && toast.onAction && (
          <button
            type="button"
            onClick={() => { toast.onAction?.(); dismiss(toast.id); }}
            className="cc-t mt-1.5 h-6 px-2.5 rounded-md text-[11px] font-medium bg-accent-500/15 text-accent-700 dark:text-accent-300 hover:bg-accent-500/25"
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** Los avisos de la app, con el bot dentro del globo, en la esquina de abajo a la derecha. Se monta una vez. */
export function BotToastHost() {
  const toasts = useBotToastStore((state) => state.toasts);
  const pet = usePetStatus();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col gap-2">
      {toasts.map((toast) => <Item key={toast.id} toast={toast} level={pet.level} />)}
    </div>
  );
}
