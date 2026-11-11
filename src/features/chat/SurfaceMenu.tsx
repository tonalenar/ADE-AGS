import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_BROWSER_PROFILE_ID, readBrowserProfiles } from "@/features/browser/profiles";

import type { ColumnKind } from "./columnTabs";
import { ChevronRightIcon, DesignIcon, DetailsIcon, DiffIcon, FilesIcon, GalleryIcon, GlobeIcon, HtmlPageIcon, PhoneIcon, PullRequestIcon, SideChatIcon, TerminalIcon, UsersIcon } from "./chatIcons";
import { entryForKey, isAvailable, keyLabel, MENU_ENTRIES, SUBMENU_OWNERS, type PanelAvailability, type PanelChoice } from "./panelMenu";
import { TasksIcon } from "./tasks/taskIcons";

/** O ícone de cada superfície: as linhas do menu e as abas da barra. */
export const KIND_ICON: Record<ColumnKind, (p: { className?: string }) => React.ReactElement> = {
  diff: DiffIcon, shell: TerminalIcon, files: FilesIcon, browser: GlobeIcon, design: DesignIcon, ios: PhoneIcon, android: PhoneIcon,
  team: UsersIcon, tasks: TasksIcon, pr: PullRequestIcon, side: SideChatIcon, renders: HtmlPageIcon, snapshots: GalleryIcon,
};

/** O ícone de uma linha do menu (o terminal do menu é a aba `shell`). */
export const iconOfChoice = (id: PanelChoice): ((p: { className?: string }) => React.ReactElement) =>
  id === "summary" ? DetailsIcon : KIND_ICON[id === "terminal" ? "shell" : id];

/** O que a escolha pede: a superfície e, no submenu do Browser, o perfil. */
export type SurfacePick = { id: PanelChoice; profileId?: string };

/** Uma linha de submenu: o que mostrar e o que escolher. */
export interface SubItem { key: string; label: string; pick: SurfacePick }

/** Os itens do submenu de uma linha (vazio = a linha não tem). Browser: perfis, só se houver mais de um. Device: iOS e Android. */
export function submenuFor(id: PanelChoice, t: (key: string) => string, profiles: { id: string; name: string }[] = readBrowserProfiles()): SubItem[] {
  if (id === "browser") {
    if (profiles.length < 2) return [];
    return profiles.map((p) => ({
      key: p.id, label: p.id === DEFAULT_BROWSER_PROFILE_ID ? t("browser.profile.default") : p.name,
      pick: { id: "browser", profileId: p.id },
    }));
  }
  if (id === "ios") {
    return [
      { key: "ios", label: t("chat.panel.open.ios"), pick: { id: "ios" } },
      { key: "android", label: t("chat.panel.open.android"), pick: { id: "android" } },
    ];
  }
  return [];
}

/** Uma tecla do menu abre a linha dela (as esmaecidas e as com modificador não). */
export function onEntryKey(e: React.KeyboardEvent, available: PanelAvailability, onPick: (pick: SurfacePick) => void): void {
  const entry = entryForKey(e, available);
  if (!entry) return;
  e.preventDefault();
  e.stopPropagation();
  onPick({ id: entry.id });
}

const ROW = "w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-left text-chat-ui";

/**
 * As linhas do menu (o "+" da barra e o estado vazio): ícone, nome e a tecla de atalho numa caixinha à direita; esmaecida
 * a que não se aplica. As linhas Browser e Device têm um `›` que abre o submenu embaixo da linha (→ também abre, ← fecha).
 * As teclas de uma letra valem com o foco na lista; ↑/↓ andam entre as linhas.
 */
export function SurfaceList({ available, onPick }: { available: PanelAvailability; onPick: (pick: SurfacePick) => void }) {
  const { t } = useTranslation();
  const [openSub, setOpenSub] = useState<PanelChoice | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const profiles = readBrowserProfiles();

  const move = (e: React.KeyboardEvent, delta: 1 | -1) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + delta + items.length) % items.length]!.focus();
    e.preventDefault();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") return move(e, 1);
    if (e.key === "ArrowUp") return move(e, -1);
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-surface-row]")?.dataset.surfaceRow as PanelChoice | undefined;
    if (row && SUBMENU_OWNERS.includes(row) && submenuFor(row, t, profiles).length > 0) {
      if (e.key === "ArrowRight") { setOpenSub(row); e.preventDefault(); return; }
      if (e.key === "ArrowLeft" && openSub === row) { setOpenSub(null); e.preventDefault(); return; }
    }
    onEntryKey(e, available, onPick);
  };

  return (
    <ul ref={listRef} role="menu" onKeyDown={onKeyDown} className="list-none m-0 p-0 flex flex-col gap-0.5" data-surface-list="">
      {MENU_ENTRIES.map((entry) => {
        const Icon = iconOfChoice(entry.id);
        const on = isAvailable(entry.id, available);
        const sub = on ? submenuFor(entry.id, t, profiles) : [];
        const name = t(entry.id === "ios" ? "chat.panel.open.device" : `chat.panel.open.${entry.id}`);
        const expanded = openSub === entry.id && sub.length > 0;
        return (
          <li key={entry.id} role="none" data-surface-row={entry.id}>
            <div className="flex items-center gap-0.5">
              <button type="button" role="menuitem" disabled={!on} aria-disabled={!on} aria-keyshortcuts={keyLabel(entry)}
                aria-haspopup={sub.length > 0 ? "menu" : undefined} aria-expanded={sub.length > 0 ? expanded : undefined}
                onClick={() => onPick({ id: entry.id })}
                className={`${ROW} flex-1 min-w-0 ${on ? "text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]" : "text-gray-400 dark:text-white/30 cursor-default"}`}>
                <Icon className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">{name}</span>
                <kbd className="min-w-6 h-6 px-1.5 rounded-md inline-flex items-center justify-center font-sans text-chat-caption
                  bg-gray-100 dark:bg-white/[0.07] text-gray-500 dark:text-white/45">{keyLabel(entry)}</kbd>
              </button>
              {sub.length > 0 && (
                <button type="button" aria-label={t("chat.panel.submenu", { name })} title={t("chat.panel.submenu", { name })}
                  aria-expanded={expanded} onClick={() => setOpenSub(expanded ? null : entry.id)}
                  className={`w-7 h-9 shrink-0 flex items-center justify-center rounded-lg text-gray-400 dark:text-white/40 hover:bg-gray-100 dark:hover:bg-white/[0.07]`}>
                  <ChevronRightIcon className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
                </button>
              )}
            </div>
            {expanded && (
              <ul role="menu" className="list-none m-0 mt-0.5 mb-1 ml-7 p-0 flex flex-col gap-0.5 border-l border-gray-200 dark:border-white/10">
                {sub.map((item) => (
                  <li key={item.key} role="none">
                    <button type="button" role="menuitem" onClick={() => onPick(item.pick)}
                      className="w-full h-8 pl-3 pr-2.5 rounded-lg flex items-center gap-2 text-left text-chat-ui text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * O estado vazio da coluna (como o T3 Code): "Abrir uma superfície" e a lista com os atalhos. Pega o foco ao aparecer,
 * para as teclas valerem de cara. Some assim que uma aba se abre.
 */
export function SurfaceLauncher({ available, onPick }: { available: PanelAvailability; onPick: (pick: SurfacePick) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={0} aria-label={t("chat.panel.empty.title")}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "ArrowDown") { e.currentTarget.querySelector<HTMLButtonElement>("button[role=menuitem]:not(:disabled)")?.focus(); e.preventDefault(); return; }
        onEntryKey(e, available, onPick);
      }}
      className="flex-1 min-h-0 flex items-center justify-center outline-none">
      <div className="w-full max-w-[420px] px-6 pb-24">
        <h2 className="m-0 mb-4 text-center text-chat-ui font-medium text-gray-900 dark:text-white">{t("chat.panel.empty.title")}</h2>
        <SurfaceList available={available} onPick={onPick} />
      </div>
    </div>
  );
}
