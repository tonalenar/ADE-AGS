import { useId } from "react";
import { useTranslation } from "react-i18next";

import { PlusIcon } from "./chatIcons";
import { usePopover } from "./usePopover";

/**
 * O «+» do composer, como o do T3 Code: um gatilho redondo discreto e um painel com as ações secundárias
 * (anexar arquivo, rascunho guardado, câmera, gravação). O ditado não mora aqui: fica ao lado do enviar. O painel fica
 * sempre montado e só some por CSS: captura e gravação guardam estado local, e desmontá-las ao fechar o painel faria a
 * gravação em andamento sumir da tela. Fecha com clique fora e Esc. É um grupo de botões, não um `role="menu"`: as
 * ações são botões próprios, sem `menuitem`. Todas seguem acessíveis por `aria-label`.
 */
export function ComposerMoreActions({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const panelId = useId();
  return (
    <div ref={ref} data-composer-more="" className="relative shrink-0 flex items-center">
      <button type="button" aria-expanded={open} aria-controls={panelId} aria-label={t("chat.composer.moreActions")} title={t("chat.composer.moreActions")}
        onClick={() => setOpen(!open)}
        className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-full text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white ${open ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white" : ""}`}>
        <PlusIcon className="w-4 h-4" />
      </button>
      <div id={panelId} role="group" aria-label={t("chat.composer.moreActions")}
        className={`${open ? "flex" : "hidden"} absolute bottom-full left-0 z-30 mb-2 items-center gap-0.5 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-white dark:bg-surface-raised p-1 shadow-xl`}>
        {children}
      </div>
    </div>
  );
}
