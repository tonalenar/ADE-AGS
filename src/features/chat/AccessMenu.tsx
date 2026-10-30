import { useTranslation } from "react-i18next";

import { LockIcon, PenIcon, ShieldIcon, ShieldOffIcon } from "./chatIcons";
import { ACCESS_MODES, type ChatAccess } from "./chatModel";
import { usePopover } from "./usePopover";

const ICON: Record<ChatAccess, (p: { className?: string }) => React.JSX.Element> = {
  ask: LockIcon, edits: PenIcon, safe: ShieldIcon, full: ShieldOffIcon,
};

/**
 * As permissões da conversa (prancheta 3): menu de 288 px com os quatro modos num segmentado e a
 * descrição do escolhido. Os modos que o agente não tem ficam desligados. Sem `onChange`, só mostra
 * (a conversa já aberta: o modo é o do comando com que o agente subiu).
 */
export function AccessMenu({ value, available, onChange, placement = "above" }: {
  value: ChatAccess;
  available: ChatAccess[];
  onChange?: (next: ChatAccess) => void;
  /** Para onde abre: em cima (o rodapé do composer, no pé da tela) ou embaixo (uma linha das Configurações). */
  placement?: "above" | "below";
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const Icon = ICON[value];
  const trigger = (
    <span className="flex items-center gap-1.5">
      <Icon className="w-3.5 h-3.5" />{t(`chat.access.${value}`)}
    </span>
  );
  if (!onChange) {
    return <span title={t(`chat.access.${value}Hint`)} className="h-6 px-1.5 flex items-center text-chat-caption text-gray-500 dark:text-white/45">{trigger}</span>;
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`h-6 px-1.5 rounded-md text-chat-caption text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/[0.07] hover:text-gray-800 dark:hover:text-white/80
          ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        {trigger}
      </button>
      {open && (
        <div role="menu" aria-label={t("chat.access.title")}
          className={`absolute right-0 ${placement === "below" ? "top-full mt-1.5" : "bottom-full mb-1.5"} z-50 w-72 p-2 rounded-lg bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]`}>
          <div className="px-1 pb-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.access.title")}</div>
          <div role="group" className="grid grid-cols-4 gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.07]">
            {ACCESS_MODES.map((mode) => {
              const enabled = available.includes(mode);
              return (
                <button key={mode} type="button" role="menuitemradio" aria-checked={mode === value} disabled={!enabled}
                  title={enabled ? t(`chat.access.${mode}`) : t("chat.access.unsupported")}
                  onClick={() => onChange(mode)}
                  className={`h-6 rounded-md text-chat-caption font-medium
                    ${mode === value
                      ? "bg-white dark:bg-surface-overlay text-gray-900 dark:text-white shadow-sm"
                      : enabled ? "text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80" : "text-gray-300 dark:text-white/20 cursor-not-allowed"}`}>
                  {t(`chat.access.${mode}Short`)}
                </button>
              );
            })}
          </div>
          <p className="m-0 mx-1 mt-2 mb-0.5 text-chat-note leading-snug">
            <b className="font-semibold text-gray-900 dark:text-white">{t(`chat.access.${value}`)}.</b>{" "}
            <span className="text-gray-500 dark:text-white/50">{t(`chat.access.${value}Hint`)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
