import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Button, CloseIcon } from "neogestify-ui-components";

import { usePageHost } from "@/shared/ui/pageHost";
import { hasOpenDialog } from "@/shared/ui/openDialog";
import { useFocusInside } from "@/shared/ui/useFocusInside";

/**
 * O marco que transforma uma rota em TELA CHEIA.
 *
 * Missões, Squads, Skills e as demais eram um modal centrado por cima das terminais. Nas
 * pranchetas aprovadas são telas: ocupam tudo à direita do riel, sem véu nem cantos
 * arredondados, e as terminais continuam vivas por baixo (se volta com Escape ou no X).
 *
 * As rotas NÃO mudam: por dentro se segue navegando igual (o detalhe de uma skill, os
 * repositórios do marketplace); o que muda é só onde se pinta. O contêiner é o `PAGE_HOST_ID`
 * do AppShell (ver `pageHost`).
 */
export function RouteModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const host = usePageHost();
  // Ver `useFocusInside`: sem isto o teclado seguia na terminal de trás.
  const { pathname } = useLocation();
  useFocusInside(frameRef, pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Um diálogo aberto por cima é o dono deste Escape (ver `hasOpenDialog`).
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
      <Button variant="icon"
        onClick={onClose}
        title={t("btn.close")}
        aria-label={t("btn.close")}
        className="absolute top-3 right-3 z-10 flex items-center justify-center w-7 h-7 rounded-md
          text-gray-400 dark:text-white/35
          bg-black/[0.04] dark:bg-white/[0.06]
          hover:text-gray-700 dark:hover:text-white
          hover:bg-black/[0.08] dark:hover:bg-white/10 transition-colors p-0"
      >
        <CloseIcon className="w-4 h-4" />
      </Button>

      {/* Sem scroll próprio: as rotas pintadas aqui são de altura completa e rolam por
          dentro. Ver a nota equivalente no `AppShell`. */}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );

  // Sem contêiner (um teste, uma vista fora do shell) fica como um painel que cobre o pai.
  return host ? createPortal(frame, host) : frame;
}
