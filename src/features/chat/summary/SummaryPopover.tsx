import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/** A largura do cartão do Resumo (a do Claude Code). */
export const SUMMARY_POPOVER_W = 380;

/**
 * O Resumo como no Claude Code: um cartão flutuante ancorado logo abaixo do ícone, alinhado à direita dele, POR CIMA da
 * conversa, sem empurrar o layout nem mexer no painel direito (o simulador, o navegador e o terminal ficam no lugar).
 * Fecha com clique fora, com Esc (o foco volta ao ícone) e quando a conversa troca (`ChatShell`). Ao abrir, o foco
 * entra no cartão.
 *
 * `anchor` é o contêiner do ícone (relativo): clicar nele não conta como «fora» (o próprio ícone alterna).
 */
export function SummaryPopover({ anchor, onClose, children }: {
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || anchor.current?.contains(target) || ref.current?.contains(target)) return;
      // O menu de um seletor (PopupSelect) é desenhado num portal: escolher nele não é sair do cartão.
      if (target.closest?.("[data-popup-menu]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      // O foco volta ao ícone que abriu o cartão.
      anchor.current?.querySelector<HTMLElement>("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={t("chat.panel.open.summary")} tabIndex={-1} data-summary-popover=""
      style={{ width: SUMMARY_POPOVER_W }}
      className="absolute right-0 top-full mt-2 z-50 max-w-[calc(100vw-24px)] max-h-[calc(100vh-72px)] flex flex-col min-h-0 outline-none
        rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-white dark:bg-surface-deep
        shadow-[0_16px_40px_-12px_rgba(0,0,0,0.45)]">
      {children}
    </div>
  );
}
