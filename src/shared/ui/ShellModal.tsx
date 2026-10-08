import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon } from "neogestify-ui-components";

import { usePageHost } from "@/shared/ui/pageHost";
import { hasOpenDialog } from "@/shared/ui/openDialog";
import { useFocusInside } from "@/shared/ui/useFocusInside";

/**
 * O marco de uma tela da app aberta pelo riel (Configurações, Contas), em TELA CHEIA.
 *
 * Abre-se por cima das terminais e sem mudar de rota: os agentes seguem rodando atrás e se
 * volta com Escape. Como as demais telas (ver `RouteModal`), ocupa tudo à direita do riel
 * em vez de ser uma janela centrada; o contêiner é o `PAGE_HOST_ID` do AppShell.
 *
 * Não o usam as rotas (Skills, Marketplace, Missões…): essas precisam que a URL mude para
 * poder navegar por dentro, e esse marco é o `RouteModal`.
 */
export function ShellModal({ title, icon, onClose, children }: {
  title: string;
  icon?: React.ReactNode;
  /** Era a largura máxima da janela; a tela cheia não a usa. Fica para não mexer nos chamadores. */
  width?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const host = usePageHost();
  // Ver `useFocusInside`: sem isto o teclado seguia na terminal de trás.
  useFocusInside(frameRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Um diálogo aberto por cima (adicionar conta, por exemplo) é o dono deste Escape:
      // fechar a tela inteira o levaria junto. Ver `hasOpenDialog`.
      if (hasOpenDialog()) return;
      // Corta aqui: senão o Escape segue até a terminal de trás e o agente o recebe como
      // se você o tivesse digitado.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  const frame = (
    <div ref={frameRef} tabIndex={-1}
      className="outline-none cc-fade pointer-events-auto absolute inset-0 flex flex-col overflow-hidden
        bg-gray-50 dark:bg-surface-deep">
      {/* Título centrado, como a barra de uma tela do macOS: o X flutua à direita e o
          `px-10` reserva o vão dele dos dois lados para o centro ficar exato. */}
      <div className="relative flex items-center justify-center gap-2 h-12 shrink-0 px-10
        border-b border-gray-200 dark:border-[rgba(84,84,88,0.55)]">
        {icon}
        <h2 className="min-w-0 truncate text-center text-[13.5px] font-semibold tracking-[-0.01em]
          text-gray-900 dark:text-[#f5f5f7]">
          {title}
        </h2>
        <Button variant="icon"
          onClick={onClose}
          title={t("btn.close")}
          aria-label={t("btn.close")}
          className="cc-t absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-md shrink-0
            text-gray-400 dark:text-white/35
            bg-black/[0.04] dark:bg-white/[0.06]
            hover:text-gray-700 dark:hover:text-white
            hover:bg-black/[0.08] dark:hover:bg-white/10 p-0"
        >
          <CloseIcon className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex">{children}</div>
    </div>
  );

  // Sem contêiner (um teste) fica como um painel que cobre o pai.
  return host ? createPortal(frame, host) : frame;
}
