import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { popupOwnsEscape } from "@/app/RouteModal";
import { useUiStore } from "@/app/uiStore";
import { WindowControls, WindowLights } from "@/app/WindowLights";
import { hasOpenDialog } from "@/shared/ui/openDialog";
import { useFocusInside } from "@/shared/ui/useFocusInside";

import { MinimizeIcon, SidebarIcon } from "./chatIcons";
import { SETTINGS_PAGE_LABEL_KEYS } from "@/features/settings/settingsNav";
import { IconButton } from "./ChatSidebar";
import { isSettingsRoute, spaceForPath } from "./chatSpaces";

/**
 * Uma tela cheia (Configurações, Missões, Skills…) dentro da casca do chat, no lugar da conversa:
 * cabeçalho de 52 px com o caminho e o conteúdo de sempre por baixo. Escape volta à conversa, com as
 * mesmas exceções do `RouteModal` (um diálogo ou um popup aberto é o dono do Escape).
 */
export function ChatPage({ onClose, sidebarOpen, onExpandSidebar, fullscreen = false, children }: {
  onClose: () => void;
  sidebarOpen: boolean;
  /** Tela cheia de verdade (a prancheta): sem a sidebar e com «Sair da tela cheia» sempre à vista (e o Esc). */
  fullscreen?: boolean;
  onExpandSidebar: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const section = useUiStore((s) => s.settingsSection);
  useFocusInside(frameRef, pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hasOpenDialog() || popupOwnsEscape(document.activeElement)) return;
      // Corta aqui: senão o Escape segue até o terminal da conversa, por baixo.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  const settings = isSettingsRoute(pathname);
  const space = spaceForPath(pathname);
  const title = settings ? t(SETTINGS_PAGE_LABEL_KEYS[section]) : space ? t(space.labelKey) : null;

  return (
    <main ref={frameRef} tabIndex={-1} className="relative flex-1 min-w-[360px] flex flex-col outline-none cc-fade">
      <header data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-3 pl-5 pr-3 text-chat-ui select-none">
        {!sidebarOpen && (
          <>
            <WindowLights />
            {!fullscreen && <IconButton label={t("chat.sidebar.expand")} onClick={onExpandSidebar}><SidebarIcon className="w-4 h-4" /></IconButton>}
          </>
        )}
        <span data-tauri-drag-region className="flex-1 min-w-0 flex items-center gap-3 truncate">
          {settings && <span className="text-gray-500 dark:text-white/50">{t("sidebar.settings")}</span>}
          {settings && title && <span aria-hidden="true" className="text-gray-300 dark:text-white/25">/</span>}
          {title && <span className="font-medium truncate">{title}</span>}
        </span>
        {fullscreen && (
          <button type="button" onClick={onClose} title={`${t("chat.page.exitFullscreen")} (Esc)`}
            className="shrink-0 h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-chat-caption font-medium text-gray-700 dark:text-white/80 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-100 dark:hover:bg-white/[0.07]">
            <MinimizeIcon className="w-3.5 h-3.5" />{t("chat.page.exitFullscreen")}
          </button>
        )}
        <WindowControls className="-mr-3" />
      </header>
      {/* As telas são de altura completa e rolam por dentro (como no `RouteModal`). */}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </main>
  );
}
