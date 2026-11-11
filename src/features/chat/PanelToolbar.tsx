import { useTranslation } from "react-i18next";

import { DetailsIcon, PanelBottomIcon } from "./chatIcons";
import { keyLabel, PANEL_ENTRIES, type PanelChoice } from "./panelMenu";
import { setRightPanel, setTerminalOpen, toggleDiffPanel, togglePanelMaximized, toggleSummary, toggleSummaryPinned, useChatStore, addSurface } from "./store";
import { SUMMARY_ANCHOR_ATTR } from "./summary/SummaryPopover";
import { TasksButton } from "./tasks/TasksButton";

/**
 * Um clique num ícone: o ativo recolhe o painel; os outros abrem a superfície. O terminal alterna a gaveta do agente
 * (`drawerTabId`: a conversa de TUI com timeline); sem gaveta (conversa por protocolo, ou TUI que já é o corpo), abre
 * a aba Terminal do painel, um shell na pasta da conversa.
 */
export function choosePanel(id: PanelChoice, drawerTabId: string | null, terminalOn: boolean): void {
  if (id === "terminal") {
    if (drawerTabId) setTerminalOpen(drawerTabId, !terminalOn);
    else setRightPanel(useChatStore.getState().panel === "shell" ? null : "shell");
    return;
  }
  // O Resumo não é aba do painel. Sem painel aberto, o ícone liga e desliga a coluna fixa. Com painel, abre o cartão
  // flutuante, sem mexer no painel; com o painel maximizado, ele volta ao tamanho normal antes, para o cartão flutuar
  // sobre a conversa (e não sobre o simulador ou o navegador, que são nativos).
  if (id === "summary") {
    const s = useChatStore.getState();
    if (s.panel === null) {
      toggleSummaryPinned();
      return;
    }
    if (!s.summaryOpen && s.panelMaximized) togglePanelMaximized();
    toggleSummary();
    return;
  }
  if (id === "diff") toggleDiffPanel();
  else if (useChatStore.getState().panel === id) setRightPanel(null);
  else addSurface(id);
}

/**
 * O que sobrou no cabeçalho da conversa, como no T3 Code: o que é da CONVERSA (Resumo = o "thread details" do T3, e as
 * Tarefas em segundo plano). As superfícies (navegador, terminal, arquivos, diff, aparelho, time…) abrem pelo "+" da barra
 * de abas da coluna direita. Com a coluna fechada, o painel inferior (a gaveta do terminal) também fica aqui, como o T3
 * faz; com ela aberta, esse botão mora na barra da coluna.
 */
export function PanelToolbar({ drawerTabId, terminalAvailable }: { drawerTabId: string | null; terminalAvailable: boolean }) {
  const { t } = useTranslation();
  const panel = useChatStore((s) => s.panel);
  // O ícone do Resumo fica marcado com a coluna à vista (sem painel) ou com o cartão aberto (com painel).
  const summaryOn = useChatStore((s) => (s.panel === null ? s.summaryPinned : s.summaryOpen));
  const drawerOn = useChatStore((s) => (drawerTabId ? s.terminalOpen[drawerTabId] ?? false : false));
  const bottomOn = drawerTabId ? drawerOn : panel === "shell";
  const summary = PANEL_ENTRIES.find((e) => e.id === "summary")!;
  const name = t("chat.panel.open.summary");
  const idle = "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white";
  const on = "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white";
  return (
    <div role="toolbar" aria-label={t("chat.panel.label")} className="flex items-center gap-0.5 shrink-0" data-tauri-drag-region="false">
      {/* O cartão do Resumo é desenhado pela coluna da conversa (`ChatShell`); aqui só o ícone, marcado enquanto ele
          está aberto. O atributo diz ao cartão que clicar no ícone não é «fora». */}
      <span {...{ [SUMMARY_ANCHOR_ATTR]: "" }} className="contents">
        <button type="button" aria-label={name} title={`${name} (${keyLabel(summary)})`} aria-pressed={summaryOn} aria-keyshortcuts={keyLabel(summary)}
          onClick={() => choosePanel("summary", drawerTabId, drawerOn)}
          className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors ${summaryOn ? on : idle}`}>
          <DetailsIcon className="w-[18px] h-[18px]" />
        </button>
      </span>
      {/* As tarefas em segundo plano (como no Claude Code): sempre à mostra. */}
      <TasksButton />
      {panel === null && (
        <button type="button" onClick={() => choosePanel("terminal", drawerTabId, drawerOn)} disabled={!terminalAvailable} aria-pressed={bottomOn}
          aria-label={t("chat.panel.bottom")} title={t("chat.panel.bottom")}
          className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${bottomOn ? on : idle}`}>
          <PanelBottomIcon className="w-[18px] h-[18px]" />
        </button>
      )}
    </div>
  );
}
