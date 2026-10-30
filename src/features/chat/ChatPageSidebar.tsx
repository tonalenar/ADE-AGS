import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WindowLights } from "@/app/WindowLights";
import { useUiStore, type SettingsSectionId } from "@/app/uiStore";

import { ChatBubbleIcon, ChevronLeftIcon, PullRequestIcon, SearchIcon, SettingsIcon, UsageIcon } from "./chatIcons";
import { CHAT_SIDEBAR_W, FooterButton } from "./ChatSidebar";
import { CHAT_SPACES, spaceForPath, type ChatSpace } from "./chatSpaces";

/**
 * Os grupos das Configurações no chat (prancheta 5). As mesmas seções da página, em três grupos com
 * título em vez dos dois separados por linha.
 */
export const CHAT_SETTINGS_GROUPS: { titleKey: string; items: SettingsSectionId[] }[] = [
  { titleKey: "chat.settingsNav.app", items: ["general", "appearance", "chat", "shortcuts"] },
  { titleKey: "chat.settingsNav.agents", items: ["agents", "accounts", "memory", "decisions"] },
  { titleKey: "chat.settingsNav.tools", items: ["terminal", "advanced"] },
];

/** O nome de uma seção (as chaves da página; "Modo chat" é a da seção nova). */
export function settingsLabelKey(id: SettingsSectionId): string {
  return id === "chat" ? "chat.settings.title" : `settings.${id}`;
}

const rowCls = (current: boolean) => `w-full flex items-center gap-2 h-8 px-2 rounded-md text-[14px] text-left
  ${current ? "bg-white dark:bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] font-medium text-gray-900 dark:text-white"
    : "text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/[0.05]"}`;

function Aside({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <aside aria-label={label} style={{ width: CHAT_SIDEBAR_W }}
      className="shrink-0 h-full flex flex-col text-[14px] bg-gray-50 dark:bg-black border-r border-gray-200 dark:border-white/[0.08]">
      {children}
    </aside>
  );
}

/** A sidebar com as seções das Configurações, "Voltar ao chat" e a busca. */
export function SettingsSidebar({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLocaleLowerCase();
  const groups = CHAT_SETTINGS_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((id) => !q || t(settingsLabelKey(id)).toLocaleLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
  return (
    <Aside label={t("chat.settingsNav.label")}>
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-5 select-none"><WindowLights /></div>
      <div className="px-2 pb-2 flex flex-col">
        <button type="button" onClick={onBack}
          className="flex items-center gap-2 h-8 px-2 rounded-md font-medium text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-white">
          <ChevronLeftIcon className="w-4 h-4" />{t("chat.page.back")}
        </button>
        <label className="flex items-center gap-2 h-8 px-2 rounded-md text-gray-500 dark:text-white/45 focus-within:ring-1 focus-within:ring-accent-500/70">
          <SearchIcon className="w-4 h-4 shrink-0" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("chat.settingsNav.search")} aria-label={t("chat.settingsNav.search")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && groups[0]) setSection(groups[0].items[0]);
              if (e.key === "Escape" && filter) { e.stopPropagation(); setFilter(""); }
            }}
            className="flex-1 min-w-0 bg-transparent outline-none text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/45" />
        </label>
      </div>
      <nav aria-label={t("settings.title")} className="flex-1 min-h-0 cc-scroll px-2 flex flex-col gap-px">
        {groups.length === 0 && <p className="px-2 py-3 text-[12px] text-gray-400 dark:text-white/35">{t("settings.searchEmpty")}</p>}
        {groups.map((g) => (
          <div key={g.titleKey} className="flex flex-col gap-px">
            <div className="px-2 pt-3 pb-1 text-[12px] font-medium text-gray-400 dark:text-white/35">{t(g.titleKey)}</div>
            {g.items.map((id) => (
              <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined} className={rowCls(section === id)}>
                {t(settingsLabelKey(id))}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </Aside>
  );
}

/** A sidebar das outras telas: Conversas, os Espaços e o rodapé de sempre (prancheta 6). */
export function SpacesSidebar({ activeCount, onBack }: { activeCount: number; onBack: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const current = spaceForPath(pathname);
  const open = (space: ChatSpace) => {
    if (space.settingsSection) setSettingsSection(space.settingsSection);
    navigate(space.path);
  };
  return (
    <Aside label={t("chat.spaces.label")}>
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-2 pl-5 select-none">
        <WindowLights />
        <span data-tauri-drag-region className="ml-[46px] font-semibold text-gray-900 dark:text-white">
          ADE <span className="font-medium text-gray-500 dark:text-white/50">AGS</span>
        </span>
      </div>
      <nav aria-label={t("chat.spaces.label")} className="px-2 py-1 flex flex-col gap-px">
        <button type="button" onClick={onBack} className={rowCls(false)}>
          <ChatBubbleIcon className="w-4 h-4" />{t("chat.spaces.conversations")}
          <span className="ml-auto text-[12px] text-gray-400 dark:text-white/35">{t("chat.spaces.active", { count: activeCount })}</span>
        </button>
        <div className="px-2 pt-3.5 pb-1 text-[12px] font-medium text-gray-400 dark:text-white/35">{t("chat.spaces.title")}</div>
        {CHAT_SPACES.map((space) => (
          <button key={space.id} type="button" onClick={() => open(space)} aria-current={current?.id === space.id ? "page" : undefined}
            className={rowCls(current?.id === space.id)}>
            <span aria-hidden="true" className="w-4 inline-flex justify-center text-gray-500 dark:text-white/45">{space.glyph}</span>
            <span className="truncate">{t(space.labelKey)}</span>
          </button>
        ))}
      </nav>
      <span className="flex-1" />
      <p className="mx-2 mb-2 p-2.5 rounded-lg border border-dashed border-gray-200 dark:border-white/[0.1] text-[12px] leading-[1.45] text-gray-500 dark:text-white/45">
        {t("chat.spaces.tip")}
      </p>
      <div className="flex items-center gap-0.5 px-2 pt-1.5 pb-2.5">
        <FooterButton label={t("sidebar.settings")} onClick={() => navigate("/settings")}><SettingsIcon className="w-4 h-4" /></FooterButton>
        <FooterButton label={t("chat.sidebar.pullRequests")} onClick={() => navigate("/forge")}><PullRequestIcon className="w-4 h-4" /></FooterButton>
        <FooterButton label={t("chat.sidebar.usage")} onClick={() => { setSettingsSection("accounts"); navigate("/settings"); }}><UsageIcon className="w-4 h-4" /></FooterButton>
      </div>
    </Aside>
  );
}
