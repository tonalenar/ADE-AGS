import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useViewTabsStore } from "@/features/tabs/viewStore";

import { PanelBottomIcon, PanelRightIcon, MaximizeIcon, MinimizeIcon, PlusIcon, XIcon } from "./chatIcons";
import { tabLabelKey, type ColumnKind, type ColumnTab } from "./columnTabs";
import type { PanelAvailability } from "./panelMenu";
import { choosePanel } from "./PanelToolbar";
import { KIND_ICON, onEntryKey, SurfaceList, type SurfacePick } from "./SurfaceMenu";
import { activateColumnTab, closeColumnTab, hostLabel, openColumnTab, togglePanelMaximized, toggleRightPanel, useChatStore } from "./store";
import { usePopover } from "./usePopover";

/** O que uma escolha do menu abre. O terminal do menu é uma aba nova da coluna (a gaveta do agente é o botão de baixo). */
export function openSurface(pick: SurfacePick): void {
  if (pick.id === "summary") return;
  if (pick.id === "terminal") { openColumnTab("shell", { forceNew: true }); return; }
  if (pick.id === "browser") { openColumnTab("browser", { forceNew: true, ...(pick.profileId ? { profileId: pick.profileId } : {}) }); return; }
  openColumnTab(pick.id as ColumnKind);
}

const ICON_BTN = "w-7 h-7 shrink-0 flex items-center justify-center rounded-md transition-colors disabled:opacity-35 [-webkit-app-region:no-drag]";
const ICON_IDLE = "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white";
const ICON_ON = "bg-gray-200/80 dark:bg-white/[0.12] text-gray-900 dark:text-white";

/** O nome de uma aba de navegador: o host da página, ou "Navegador" sem endereço. */
function useBrowserTitle(viewId: string | undefined): string | null {
  return useViewTabsStore((s) => {
    const view = viewId ? s.views.find((v) => v.id === viewId) : undefined;
    return view && view.kind === "browser" ? hostLabel(view.url) : null;
  });
}

function TabItem({ tab, tabs, active, scope, onClose }: { tab: ColumnTab; tabs: ColumnTab[]; active: boolean; scope: string; onClose: () => void }) {
  const { t } = useTranslation();
  const host = useBrowserTitle(tab.kind === "browser" ? tab.resources?.[scope] : undefined);
  const { key, index } = tabLabelKey(tab, tabs);
  const base = host ?? t(key);
  const name = !host && index > 0 ? t("chat.panel.tab.numbered", { name: base, n: index }) : base;
  const Icon = KIND_ICON[tab.kind];
  return (
    <div role="presentation" data-active-tab={active ? "true" : undefined} data-column-tab={tab.kind}
      className={`group shrink-0 flex items-center h-7 max-w-[11rem] rounded-md text-chat-caption transition-colors
        ${active ? ICON_ON : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10"}`}>
      <button type="button" role="tab" aria-selected={active} title={name} onClick={() => activateColumnTab(tab.id)}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        className="min-w-0 h-7 pl-2 pr-1 flex items-center gap-1.5 [-webkit-app-region:no-drag]">
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      <button type="button" aria-label={t("chat.panel.close", { name })} title={t("chat.panel.close", { name })} onClick={onClose}
        className="w-5 h-5 mr-1 shrink-0 flex items-center justify-center rounded text-gray-400 dark:text-white/35 opacity-60 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white [-webkit-app-region:no-drag]">
        <XIcon className="w-3 h-3" />
      </button>
    </div>
  );
}

/** O "+": abre o menu de superfícies (as mesmas linhas e teclas do estado vazio). Com o menu aberto, uma letra abre a linha. */
function AddSurface({ available }: { available: PanelAvailability }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const pick = (choice: SurfacePick) => { openSurface(choice); setOpen(false); };
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t("chat.panel.addTab")} title={t("chat.panel.addTab")}
        aria-expanded={open} aria-haspopup="menu" className={`${ICON_BTN} ${open ? ICON_ON : ICON_IDLE}`}>
        <PlusIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="presentation" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => onEntryKey(e, available, pick)}
          className="absolute left-0 top-full mt-1 z-50 w-[260px] p-1 rounded-lg bg-white dark:bg-surface-raised outline-none
          shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <SurfaceList available={available} onPick={pick} />
        </div>
      )}
    </div>
  );
}

/**
 * A barra de cima da coluna direita, como a do T3 Code: as abas abertas, o "+" com o menu de superfícies e, à direita, o
 * expandir, o painel inferior (a gaveta do terminal do agente) e o recolher da coluna. Fica DENTRO da coluna; o cabeçalho
 * da conversa guarda só o que é da conversa (Resumo e Tarefas).
 */
export function ColumnTabBar({ available, scopes, drawerTabId, reserveWindowControls }: {
  available: PanelAvailability; scopes: { browser: string; shell: string };
  drawerTabId: string | null; reserveWindowControls: boolean;
}) {
  const { t } = useTranslation();
  const tabs = useChatStore((s) => s.columnTabs);
  const activeId = useChatStore((s) => s.columnActive);
  const panel = useChatStore((s) => s.panel);
  const maximized = useChatStore((s) => s.panelMaximized);
  const drawerOn = useChatStore((s) => (drawerTabId ? s.terminalOpen[drawerTabId] ?? false : false));
  const listRef = useRef<HTMLDivElement>(null);
  // A aba que ganha o foco aparece inteira, mesmo com muitas abas.
  useEffect(() => { listRef.current?.querySelector<HTMLElement>("[data-active-tab=true]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeId, tabs.length]);
  const bottomOn = drawerTabId ? drawerOn : panel === "shell";
  const scopeOf = (tab: ColumnTab) => (tab.kind === "browser" ? scopes.browser : scopes.shell);
  return (
    <div data-column-tabbar="" data-tauri-drag-region
      className={`h-11 shrink-0 flex items-center gap-1 pl-2 border-b border-gray-200 dark:border-white/[0.08] select-none ${reserveWindowControls ? "pr-36" : "pr-2"}`}>
      <div ref={listRef} role="tablist" aria-label={t("chat.panel.tabs")} data-tauri-drag-region="false"
        className="min-w-0 flex items-center gap-1 overflow-x-auto cc-scroll-hidden">
        {tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} tabs={tabs} active={tab.id === activeId && panel !== "empty"} scope={scopeOf(tab)} onClose={() => closeColumnTab(tab.id)} />
        ))}
      </div>
      <AddSurface available={available} />
      <span data-tauri-drag-region className="flex-1 min-w-0 self-stretch" />
      <div className="flex items-center gap-0.5 shrink-0" data-tauri-drag-region="false">
        <button type="button" onClick={togglePanelMaximized} aria-pressed={maximized}
          aria-label={maximized ? t("chat.panel.restore") : t("chat.panel.maximize")} title={maximized ? t("chat.panel.restore") : t("chat.panel.maximize")}
          className={`${ICON_BTN} ${maximized ? ICON_ON : ICON_IDLE}`}>
          {maximized ? <MinimizeIcon className="w-[15px] h-[15px]" /> : <MaximizeIcon className="w-[15px] h-[15px]" />}
        </button>
        <button type="button" onClick={() => choosePanel("terminal", drawerTabId, drawerOn)} disabled={!available.terminal} aria-pressed={bottomOn}
          aria-label={t("chat.panel.bottom")} title={t("chat.panel.bottom")} className={`${ICON_BTN} ${bottomOn ? ICON_ON : ICON_IDLE}`}>
          <PanelBottomIcon className="w-[15px] h-[15px]" />
        </button>
        <button type="button" onClick={toggleRightPanel} aria-pressed aria-label={t("chat.panel.toggle")} title={t("chat.panel.toggle")}
          className={`${ICON_BTN} ${ICON_ON}`}>
          <PanelRightIcon className="w-[15px] h-[15px]" />
        </button>
      </div>
    </div>
  );
}
