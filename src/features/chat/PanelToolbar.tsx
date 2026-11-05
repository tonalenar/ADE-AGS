import { useTranslation } from "react-i18next";

import { DesignIcon, DetailsIcon, DiffIcon, FilesIcon, FolderIcon, GlobeIcon, MaximizeIcon, MoreHorizontalIcon, PhoneIcon, PullRequestIcon, TerminalIcon, UsersIcon } from "./chatIcons";
import { COMPACT_HIDDEN, entryForKey, isAvailable, keyLabel, MORE_ENTRIES, PANEL_ENTRIES, ROW_CHOICES, type PanelAvailability, type PanelChoice } from "./panelMenu";
import { addSurface, setRightPanel, setTerminalOpen, togglePanelMaximized, toggleSummary, toggleSummaryPinned, useChatStore } from "./store";
import { SUMMARY_ANCHOR_ATTR } from "./summary/SummaryPopover";
import { usePopover } from "./usePopover";

/** Os ícones das linhas do menu "Abrir uma superfície". */
export const ENTRY_ICON: Record<PanelChoice, (p: { className?: string }) => React.ReactElement> = {
  summary: DetailsIcon, browser: GlobeIcon, terminal: TerminalIcon, files: FilesIcon, diff: DiffIcon, design: DesignIcon,
  ios: PhoneIcon, android: PhoneIcon, team: UsersIcon, pr: PullRequestIcon,
};

const ROW_ICON: Record<string, (p: { className?: string }) => React.ReactElement> = {
  summary: DetailsIcon, terminal: TerminalIcon, diff: DiffIcon, browser: GlobeIcon, ios: PhoneIcon, files: FolderIcon, team: UsersIcon,
};

/** O ícone da fileira está "ligado" quando é a superfície à vista (o aparelho vale iOS e Android). */
export function isRowActive(id: PanelChoice, panel: string | null): boolean {
  return id === panel;
}

/** Um ícone da fileira: tooltip com o nome e a tecla, e o fundo arredondado quando é o que está à vista. */
export function RowIcon({ id, active, available, onChoose, className = "" }: { id: PanelChoice; active: boolean; available: PanelAvailability; onChoose: (id: PanelChoice) => void; className?: string }) {
  const { t } = useTranslation();
  const Icon = ROW_ICON[id]!;
  const entry = PANEL_ENTRIES.find((e) => e.id === id)!;
  const on = isAvailable(id, available);
  const name = t(`chat.panel.open.${id}`);
  return (
    <button type="button" disabled={!on} aria-label={name} title={`${name} (${keyLabel(entry)})`} aria-pressed={active} aria-keyshortcuts={keyLabel(entry)}
      onClick={() => onChoose(id)}
      className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${className}
        ${active ? "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"}`}>
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );
}

/** O `⋯` da fileira: o que não cabe nos ícones (Design, Android, PR), com as mesmas teclas. */
export function MoreMenu({ available, onChoose, active }: { available: PanelAvailability; onChoose: (id: PanelChoice) => void; active: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const pick = (id: PanelChoice) => { onChoose(id); setOpen(false); };
  const maximized = useChatStore((s) => s.panelMaximized);
  const panel = useChatStore((s) => s.panel);
  const docked = panel !== null;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t("chat.panel.more")} title={t("chat.panel.more")} aria-expanded={open} aria-haspopup="menu"
        className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg ${active || open ? "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10"}`}>
        <MoreHorizontalIcon className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <div role="menu" onKeyDown={(e) => onEntryKey(e, available, pick)} ref={(el) => el?.focus()} tabIndex={-1}
          className="absolute right-0 top-full mt-1 z-50 w-[240px] p-1 rounded-lg bg-white dark:bg-surface-raised outline-none
          shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
            {/* Na conversa estreita (`@container/main`), os ícones que saíram da fileira aparecem aqui primeiro. */}
            {[...COMPACT_HIDDEN.filter((id) => id !== panel).map((id) => PANEL_ENTRIES.find((e) => e.id === id)!), ...MORE_ENTRIES].map((entry) => {
              const Icon = ENTRY_ICON[entry.id];
              const on = isAvailable(entry.id, available);
              const compact = COMPACT_HIDDEN.includes(entry.id);
              return (
                <li key={entry.id} role="none" className={compact ? "@min-[36rem]/main:hidden" : undefined}>
                  <button type="button" role="menuitem" disabled={!on} aria-disabled={!on} aria-keyshortcuts={keyLabel(entry)} onClick={() => pick(entry.id)}
                    className={`w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-left text-chat-ui ${on ? "text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]" : "text-gray-400 dark:text-white/30 cursor-default"}`}>
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="flex-1 truncate">{t(`chat.panel.open.${entry.id}`)}</span>
                    <kbd className="min-w-6 h-6 px-1.5 rounded-md inline-flex items-center justify-center font-sans text-chat-caption bg-gray-100 dark:bg-white/[0.07] text-gray-500 dark:text-white/45">{keyLabel(entry)}</kbd>
                  </button>
                </li>
              );
            })}
            {/* O "expandir" que morava na faixa do painel: com uma superfície do dock à vista, ocupa a janela toda. */}
            <li role="none" className="mt-0.5 pt-0.5 border-t border-gray-200 dark:border-white/10">
              <button type="button" role="menuitem" disabled={!docked} aria-disabled={!docked} aria-pressed={maximized}
                onClick={() => { togglePanelMaximized(); setOpen(false); }}
                className={`w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-left text-chat-ui ${docked ? "text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]" : "text-gray-400 dark:text-white/30 cursor-default"}`}>
                <MaximizeIcon className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">{t("chat.panel.maximize")}</span>
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}


/** Uma tecla do menu abre a linha dela (as esmaecidas e as com modificador não). */
export function onEntryKey(e: React.KeyboardEvent, available: PanelAvailability, onChoose: (id: PanelChoice) => void): void {
  const entry = entryForKey(e, available);
  if (!entry) return;
  e.preventDefault();
  e.stopPropagation();
  onChoose(entry.id);
}

/**
 * Um clique num ícone: o ativo recolhe o painel; os outros abrem a superfície. O terminal alterna a gaveta do agente
 * (`drawerTabId`: a conversa de TUI com timeline); sem gaveta (conversa por protocolo, ou TUI que já é o corpo), abre
 * a aba Terminal do painel, um shell na pasta da conversa.
 */
export function choosePanel(id: PanelChoice, drawerTabId: string | null, terminalOn: boolean): void {
  if (id === "pr") return;
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
  if (useChatStore.getState().panel === id) setRightPanel(null);
  else if (id === "diff") setRightPanel(id);
  else addSurface(id);
}

/**
 * A fileira de ícones do painel (Resumo, Terminal, Diff, Navegador, Aparelho, Arquivos e o ⋯), como a do
 * Claude Code. Fica no cabeçalho principal da janela; com o painel maximizado, no cabeçalho dele.
 */
export function PanelToolbar({ drawerTabId, terminalAvailable }: { drawerTabId: string | null; terminalAvailable: boolean }) {
  const { t } = useTranslation();
  const panel = useChatStore((s) => s.panel);
  // O ícone do Resumo fica marcado com a coluna à vista (sem painel) ou com o cartão aberto (com painel).
  const summaryOn = useChatStore((s) => (s.panel === null ? s.summaryPinned : s.summaryOpen));
  const drawerOn = useChatStore((s) => (drawerTabId ? s.terminalOpen[drawerTabId] ?? false : false));
  const available: PanelAvailability = { terminal: terminalAvailable, pr: false };
  const choose = (id: PanelChoice) => choosePanel(id, drawerTabId, drawerOn);
  const terminalActive = drawerTabId ? drawerOn : panel === "shell";
  return (
    <div role="toolbar" aria-label={t("chat.panel.label")} className="flex items-center gap-0.5 shrink-0" data-tauri-drag-region="false">
      {ROW_CHOICES.map((id) => {
        if (id === "summary") {
          // O cartão do Resumo é desenhado pela coluna da conversa (`ChatShell`); aqui só o ícone, marcado enquanto ele
          // está aberto. O atributo diz ao cartão que clicar no ícone não é «fora».
          return (
            <span key={id} {...{ [SUMMARY_ANCHOR_ATTR]: "" }} className="contents">
              <RowIcon id={id} active={summaryOn} available={available} onChoose={choose} />
            </span>
          );
        }
        const active = id === "terminal" ? terminalActive : isRowActive(id, panel);
        // Conversa estreita: Diff, Navegador e Arquivos vão para o ⋯ (menos o que está à vista).
        return <RowIcon key={id} id={id} active={active} available={available} onChoose={choose}
          className={COMPACT_HIDDEN.includes(id) && !active ? "@max-[36rem]/main:hidden" : ""} />;
      })}
      <MoreMenu available={available} onChoose={choose} active={panel === "design" || panel === "android"} />
    </div>
  );
}
