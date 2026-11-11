import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { WindowLights } from "@/app/WindowLights";
import { useUiStore } from "@/app/uiStore";
import { CHAT_SIDEBAR_W } from "@/features/chat/ChatSidebar";
import { ChevronLeftIcon, SearchIcon } from "@/features/chat/chatIcons";
import { usePendingMemoryStore } from "@/features/memory/pendingStore";
import { badgeText, pendingTotal } from "@/features/settings/memoryBadge";
import {
  NEW_SETTINGS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_PAGE_LABEL_KEYS,
  normalizeSettingsSearch,
  searchSettingsItems,
  settingsPageMatches,
  type SettingsSearchItem,
} from "@/features/settings/settingsNav";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";
import { useTabsStore } from "@/features/tabs/store";

const rowCls = (current: boolean) => `w-full flex items-center gap-2 h-8 px-2 rounded-md text-[14px] text-left
  ${current ? "bg-white dark:bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] font-medium text-gray-900 dark:text-white"
    : "text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/[0.05]"}`;

/** De quanto em quanto tempo o selo da Memória relê as sugestões pendentes. */
const PENDING_REFRESH_MS = 30_000;

/** Só o Linux tem a composição de GPU (e a busca só acha esse ajuste lá). */
const IS_LINUX = typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);

/** As sugestões de memória esperando o OK da pessoa, para o selo da seção Memória. */
function usePendingMemory(): number {
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const total = usePendingMemoryStore((s) => pendingTotal(s.counts));
  useEffect(() => {
    if (!workspaceId) return;
    const load = () => { usePendingMemoryStore.getState().load(workspaceId).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [workspaceId]);
  return workspaceId ? total : 0;
}

/**
 * O menu das Configurações, o mesmo em todos os modos: os grupos do T3 Code e a busca no topo. Com
 * texto, a lista vira os AJUSTES que casam (não só as páginas), cada um com a página ao lado; Enter
 * ou um clique leva à página e rola até o bloco. A tecla "/" põe o cursor na busca.
 *
 * No chat ela vem com os semáforos da janela e o "Voltar ao chat" (`onBack`); nas abas e no canvas a
 * tela já tem o X do modal.
 */
export function SettingsSidebar({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  const pending = usePendingMemory();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const searching = normalizeSettingsSearch(query).length > 0;
  const results = searching ? searchSettingsItems(query, t, { linux: IS_LINUX }) : [];
  const groups = SETTINGS_NAV_GROUPS
    .map((g) => ({ ...g, pages: g.pages.filter((page) => settingsPageMatches(page, query, t)) }))
    .filter((g) => g.pages.length > 0);

  // "/" põe o cursor na busca, como no T3 Code. Não rouba a tecla de quem está digitando.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openItem = (item: SettingsSearchItem) => {
    setSection(item.page);
    useSettingsTargetStore.getState().goTo({ page: item.page, tab: item.tab, anchor: item.anchor });
    setQuery("");
    setActive(0);
    inputRef.current?.blur();
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (query) { setQuery(""); setActive(0); } else inputRef.current?.blur();
      return;
    }
    if (!searching) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (event.key === "Enter" && results[active]) openItem(results[active].item);
  };

  return (
    <aside aria-label={t("chat.settingsNav.label")} style={{ width: CHAT_SIDEBAR_W }}
      className="shrink-0 h-full flex flex-col text-[14px] bg-gray-50 dark:bg-black border-r border-gray-200 dark:border-white/[0.08]">
      {onBack
        ? <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-5 select-none"><WindowLights /></div>
        : <div className="h-3 shrink-0" />}
      <div className="px-2 pb-2 flex flex-col">
        {onBack && (
          <button type="button" onClick={onBack}
            className="flex items-center gap-2 h-8 px-2 rounded-md font-medium text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-white">
            <ChevronLeftIcon className="w-4 h-4" />{t("chat.page.back")}
          </button>
        )}
        <label className="flex items-center gap-2 h-8 px-2 rounded-md text-gray-500 dark:text-white/45 focus-within:ring-1 focus-within:ring-accent-500/70">
          <SearchIcon className="w-4 h-4 shrink-0" />
          <input ref={inputRef} value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onSearchKey}
            placeholder={t("chat.settingsNav.search")} aria-label={t("chat.settingsNav.search")}
            role="combobox" aria-expanded={searching} aria-controls={searching ? "settings-search-results" : undefined}
            aria-activedescendant={searching && results[active] ? `settings-search-${results[active].item.id}` : undefined}
            className="flex-1 min-w-0 bg-transparent outline-none text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/45" />
          {!query && <kbd className="shrink-0 text-[11px] text-gray-400 dark:text-white/35" aria-hidden="true">/</kbd>}
        </label>
      </div>

      {searching ? (
        <div id="settings-search-results" role="listbox" aria-label={t("chat.settingsNav.search")}
          className="flex-1 min-h-0 cc-scroll-hidden px-2 flex flex-col gap-px">
          {results.length === 0 && <p className="px-2 py-3 text-[12px] text-gray-400 dark:text-white/35">{t("settings.searchEmpty")}</p>}
          {results.map(({ item }, index) => (
            <button key={item.id} id={`settings-search-${item.id}`} type="button" role="option" aria-selected={index === active}
              onMouseEnter={() => setActive(index)} onClick={() => openItem(item)}
              className={rowCls(index === active)}>
              <span title={t(item.titleKey)} className="truncate">{t(item.titleKey)}</span>
              <span title={t(SETTINGS_PAGE_LABEL_KEYS[item.page])} className="ml-auto max-w-[45%] truncate text-[12px] text-gray-400 dark:text-white/35">{t(SETTINGS_PAGE_LABEL_KEYS[item.page])}</span>
            </button>
          ))}
        </div>
      ) : (
        <nav aria-label={t("settings.title")} className="flex-1 min-h-0 cc-scroll-hidden px-2 flex flex-col">
          {groups.length === 0 && <p className="px-2 py-3 text-[12px] text-gray-400 dark:text-white/35">{t("settings.searchEmpty")}</p>}
          {groups.map((g, index) => (
            <div key={g.heading ?? `sem-titulo-${index}`} className={`flex flex-col gap-px ${index > 0 ? "pt-3" : ""}`}>
              {g.heading && <div className="px-2 pb-1 text-[12px] font-medium text-gray-400 dark:text-white/35">{t(g.heading)}</div>}
              {g.pages.map((page) => (
                <button key={page} type="button" onClick={() => setSection(page)} aria-current={section === page ? "page" : undefined} className={rowCls(section === page)}>
                  <span title={t(SETTINGS_PAGE_LABEL_KEYS[page])} className="truncate">{t(SETTINGS_PAGE_LABEL_KEYS[page])}</span>
                  {NEW_SETTINGS.has(page) && (
                    <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.04em] text-accent-600 dark:text-accent-400">{t("chat.settingsNav.new")}</span>
                  )}
                  {page === "memory" && pending > 0 && (
                    <span title={t("settings.memoryBadge", { count: pending })}
                      className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-accent-600 text-white text-[10.5px] font-semibold leading-[18px] text-center">
                      {badgeText(pending)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}
    </aside>
  );
}
