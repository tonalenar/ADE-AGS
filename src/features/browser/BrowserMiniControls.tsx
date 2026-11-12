import { useTranslation } from "react-i18next";
import { closeChatBrowserFloating, setRightPanel, useChatStore } from "@/features/chat/store";
import { PanelRightIcon, WindowOpenIcon, XIcon } from "@/features/chat/chatIcons";

/** Ações da miniatura; nenhuma delas desmonta a vista persistente do navegador. */
export function BrowserMiniControls() {
  const { t } = useTranslation();
  return (
    <div data-over-webview role="toolbar" aria-label={t("browser.mini.controls")}
      className="relative flex h-9 items-center gap-0.5 rounded-xl border border-gray-200/90 bg-white/95 p-1 opacity-0 shadow-lg backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[hover=true]:opacity-100 dark:border-white/12 dark:bg-gray-900/95">
      <button type="button" aria-label={t("browser.mini.openPanel")} title={t("browser.mini.openPanel")}
        onPointerDown={(event) => event.stopPropagation()} onClick={() => setRightPanel("browser")}
        className="flex size-7 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10">
        <PanelRightIcon />
      </button>
      <button type="button" aria-label={t("browser.mini.openWindow")} title={t("browser.mini.openWindow")}
        onPointerDown={(event) => event.stopPropagation()} onClick={() => {
          setRightPanel("browser");
          useChatStore.setState({ panelMaximized: true });
        }}
        className="flex size-7 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10">
        <WindowOpenIcon />
      </button>
      <button type="button" aria-label={t("browser.mini.close")} title={t("browser.mini.close")}
        onPointerDown={(event) => event.stopPropagation()} onClick={closeChatBrowserFloating}
        className="flex size-7 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10">
        <XIcon />
      </button>
    </div>
  );
}
