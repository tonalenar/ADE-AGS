import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/** A largura do cartão do Resumo (a do Claude Code). */
export const SUMMARY_POPOVER_W = 380;

/** O contêiner do ícone do Resumo na fileira (`PanelToolbar`): clicar nele não é «fora» (o ícone alterna sozinho). */
export const SUMMARY_ANCHOR_ATTR = "data-summary-anchor";

/**
 * O Resumo como no Claude Code: um cartão único que flutua logo abaixo do cabeçalho, com a borda direita na borda
 * direita da coluna da conversa (encostado no painel direito, sem cobri-lo) e crescendo para a esquerda. Fica POR CIMA
 * da conversa, sem empurrar o layout nem mexer no painel direito (simulador, navegador e terminal ficam no lugar).
 *
 * Quem o desenha é a coluna da conversa (`<main>`, `relative`): a posição é do CSS e acompanha o redimensionamento e o
 * abrir e fechar do painel sem conta nenhuma. Antes ele ficava preso ao contêiner do ícone e abria colado à esquerda.
 *
 * Fecha com clique fora, com Esc (o foco volta ao ícone) e quando a conversa troca (`ChatShell`). Ao abrir, o foco
 * entra no cartão.
 */
export function SummaryPopover({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || ref.current?.contains(target) || target.closest?.(`[${SUMMARY_ANCHOR_ATTR}]`)) return;
      // O menu de um seletor (PopupSelect) é desenhado num portal: escolher nele não é sair do cartão.
      if (target.closest?.("[data-popup-menu]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      // O foco volta ao ícone que abriu o cartão.
      document.querySelector<HTMLElement>(`[${SUMMARY_ANCHOR_ATTR}] button`)?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={t("chat.panel.open.summary")} tabIndex={-1} data-summary-popover=""
      style={{ width: SUMMARY_POPOVER_W }}
      className="absolute top-[52px] right-2 z-40 max-w-[calc(100%-16px)] max-h-[calc(100%-64px)] flex flex-col min-h-0 overflow-hidden outline-none
        rounded-2xl border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-surface-raised
        shadow-[0_16px_40px_-12px_rgba(0,0,0,0.28)] dark:shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]">
      {children}
    </div>
  );
}
