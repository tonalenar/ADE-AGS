import { useTranslation } from "react-i18next";

import { DesignIcon, DetailsIcon, DiffIcon, FilesIcon, FolderIcon, GlobeIcon, MaximizeIcon, MoreHorizontalIcon, PhoneIcon, PullRequestIcon, TerminalIcon, UsersIcon } from "./chatIcons";
import { entryForKey, isAvailable, keyLabel, MORE_ENTRIES, PANEL_ENTRIES, ROW_CHOICES, type PanelAvailability, type PanelChoice } from "./panelMenu";
import { addSurface, setRightPanel, setTerminalOpen, togglePanelMaximized, useChatStore } from "./store";
import { usePopover } from "./usePopover";

/** Os ícones das linhas do menu "Abrir uma superfície". */
export const ENTRY_ICON: Record<PanelChoice, (p: { className?: string }) => React.ReactElement> = {
  summary: DetailsIcon, browser: GlobeIcon, terminal: TerminalIcon, files: FilesIcon, diff: DiffIcon, design: DesignIcon,
  ios: PhoneIcon, android: PhoneIcon, team: UsersIcon, pr: PullRequestIcon,
};

const ROW_ICON: Record<string, (p: { className?: string }) => React.ReactElement> = {
  summary: DetailsIcon, terminal: TerminalIcon, diff: DiffIcon, browser: GlobeIcon, ios: PhoneIcon, files: FolderIcon,
};

/** O ícone da fileira está "ligado" quando é a superfície à vista (o aparelho vale iOS e Android). */
export function isRowActive(id: PanelChoice, panel: string | null): boolean {
  return id === panel;
}

/** Um ícone da fileira: tooltip com o nome e a tecla, e o fundo arredondado quando é o que está à vista. */
export function RowIcon({ id, active, available, onChoose }: { id: PanelChoice; active: boolean; available: PanelAvailability; onChoose: (id: PanelChoice) => void }) {
  const { t } = useTranslation();
  const Icon = ROW_ICON[id]!;
  const entry = PANEL_ENTRIES.find((e) => e.id === id)!;
  const on = isAvailable(id, available);
  const name = t(`chat.panel.open.${id}`);
  return (
    <button type="button" disabled={!on} aria-label={name} title={`${name} (${keyLabel(entry)})`} aria-pressed={active} aria-keyshortcuts={keyLabel(entry)}
      onClick={() => onChoose(id)}
      className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors disabled:opacity-35
        ${active ? "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"}`}>
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );
}

/** O `⋯` da fileira: o que não cabe nos ícones (Design, Android, Time, PR), com as mesmas teclas. */
export function MoreMenu({ available, onChoose, active }: { available: PanelAvailability; onChoose: (id: PanelChoice) => void; active: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const pick = (id: PanelChoice) => { onChoose(id); setOpen(false); };
  const maximized = useChatStore((s) => s.panelMaximized);
  const panel = useChatStore((s) => s.panel);
  // O dock só existe com uma superfície que não é o Resumo (que flutua, sem coluna).
  const docked = panel !== null && panel !== "summary";
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
            {MORE_ENTRIES.map((entry) => {
              const Icon = ENTRY_ICON[entry.id];
              const on = isAvailable(entry.id, available);
              return (
                <li key={entry.id} role="none">
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

/** Um clique num ícone: o ativo recolhe o painel; os outros abrem a superfície; o terminal alterna a gaveta. */
export function choosePanel(id: PanelChoice, tabId: string | null, terminalOn: boolean): void {
  if (id === "pr") return;
  if (id === "terminal") { if (tabId) setTerminalOpen(tabId, !terminalOn); return; }
  if (useChatStore.getState().panel === id) setRightPanel(null);
  else if (id === "summary" || id === "diff") setRightPanel(id);
  else addSurface(id);
}

/**
 * A fileira de ícones do painel (Resumo, Terminal, Diff, Navegador, Aparelho, Arquivos e o ⋯), como a do
 * Claude Code. Fica no cabeçalho principal da janela; com o painel maximizado, no cabeçalho dele.
 */
export function PanelToolbar({ tabId, terminalAvailable }: { tabId: string | null; terminalAvailable: boolean }) {
  const { t } = useTranslation();
  const panel = useChatStore((s) => s.panel);
  const terminalOn = useChatStore((s) => (tabId ? s.terminalOpen[tabId] ?? false : false));
  const available: PanelAvailability = { terminal: terminalAvailable, pr: false };
  const choose = (id: PanelChoice) => choosePanel(id, tabId, terminalOn);
  return (
    <div role="toolbar" aria-label={t("chat.panel.label")} className="flex items-center gap-0.5 shrink-0" data-tauri-drag-region="false">
      {ROW_CHOICES.map((id) => (
        <RowIcon key={id} id={id} active={id === "terminal" ? terminalOn : isRowActive(id, panel)} available={available} onChoose={choose} />
      ))}
      <MoreMenu available={available} onChoose={choose} active={panel === "design" || panel === "android" || panel === "team"} />
    </div>
  );
}
