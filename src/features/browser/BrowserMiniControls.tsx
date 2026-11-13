import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AndroidIcon, AppleIcon, Tooltip } from "neogestify-ui-components";
import { RotateIcon } from "@/app/icons";
import { closeChatBrowserFloating, setRightPanel, useChatStore } from "@/features/chat/store";
import { ComputerIcon, ExpandIcon, FitIcon, PanelRightIcon, WindowOpenIcon, XIcon } from "@/features/chat/chatIcons";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { isFramedViewport, runBrowserDeviceFull, runBrowserDevicePlatform, runBrowserDeviceRotate } from "./deviceMode";

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

function DockIconButton({
  label,
  placement,
  role,
  checked,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  placement: "top" | "bottom";
  role?: "radio";
  checked?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement={placement}>
      <button
        type="button"
        role={role}
        aria-checked={role === "radio" ? checked : undefined}
        aria-label={label}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClick}
        className={`flex size-7 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 ${
          disabled
            ? "pointer-events-none text-gray-400/50 dark:text-white/25"
            : checked
              ? "bg-gray-900/12 text-gray-900 shadow-xs dark:bg-white/18 dark:text-white"
              : "text-gray-600 hover:bg-gray-900/6 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * Dock flutuante externa à área da vista nativa: controla aparelho, formato, rotação e retorno ao painel
 * no estilo de pílula translúcida do T3 (apenas ícones com tooltip).
 */
export function BrowserMiniDock({
  viewId,
  visible = false,
  placement = "bottom",
}: {
  viewId: string;
  visible?: boolean;
  placement?: "top" | "bottom";
}) {
  const { t } = useTranslation();
  const view = useViewTabsStore((state) => state.views.find((candidate) => candidate.id === viewId));
  const browser = view?.kind === "browser" ? view : null;
  const mobile = browser?.mobile ?? null;
  const framed = isFramedViewport(browser?.viewport);
  const tooltipSide = placement === "top" ? "top" : "bottom";

  return (
    <div
      data-browser-mini-dock
      data-visible={visible ? "true" : "false"}
      role="toolbar"
      aria-label={t("browser.mini.deviceDock")}
      onPointerDown={(event) => event.stopPropagation()}
      className={`flex items-center gap-0.5 rounded-full border border-gray-200/85 bg-white/88 px-1 py-1 shadow-lg backdrop-blur-xl transition-all duration-150 dark:border-white/12 dark:bg-surface-overlay/88 focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100 ${
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : placement === "top"
            ? "pointer-events-none -translate-y-1 opacity-0"
            : "pointer-events-none translate-y-1 opacity-0"
      }`}
    >
      <div role="radiogroup" aria-label={t("browser.viewport.platform")} className="flex items-center gap-0.5">
        <DockIconButton
          role="radio"
          checked={mobile === "ios"}
          label={t("browser.viewport.ios")}
          placement={tooltipSide}
          onClick={() => runBrowserDevicePlatform(viewId, "ios")}
        >
          <AppleIcon className="size-3.5" />
        </DockIconButton>
        <DockIconButton
          role="radio"
          checked={mobile === "android"}
          label={t("browser.viewport.android")}
          placement={tooltipSide}
          onClick={() => runBrowserDevicePlatform(viewId, "android")}
        >
          <AndroidIcon className="size-3.5" />
        </DockIconButton>
        <DockIconButton
          role="radio"
          checked={mobile === null}
          label={t("browser.viewport.desktop")}
          placement={tooltipSide}
          onClick={() => runBrowserDevicePlatform(viewId, null)}
        >
          <ComputerIcon className="size-3.5" />
        </DockIconButton>
      </div>

      <span aria-hidden className="mx-0.5 h-4 w-px bg-gray-200/90 dark:bg-white/12" />

      <div role="radiogroup" aria-label={t("browser.viewport.layout")} className="flex items-center gap-0.5">
        <DockIconButton
          role="radio"
          checked={framed}
          label={t("browser.viewport.frame")}
          placement={tooltipSide}
          onClick={() => runBrowserDeviceFull(viewId, false)}
        >
          <FitIcon className="size-3.5" />
        </DockIconButton>
        <DockIconButton
          role="radio"
          checked={!framed}
          label={t("browser.viewport.full")}
          placement={tooltipSide}
          onClick={() => runBrowserDeviceFull(viewId, true)}
        >
          <ExpandIcon className="size-3.5" />
        </DockIconButton>
      </div>

      <DockIconButton
        label={t("browser.viewport.rotate")}
        placement={tooltipSide}
        disabled={!framed}
        onClick={() => runBrowserDeviceRotate(viewId)}
      >
        <RotateIcon className="size-3.5" />
      </DockIconButton>

      <span aria-hidden className="mx-0.5 h-4 w-px bg-gray-200/90 dark:bg-white/12" />

      <DockIconButton
        label={t("browser.mini.openPanel")}
        placement={tooltipSide}
        onClick={() => setRightPanel("browser")}
      >
        <PanelRightIcon className="size-3.5" />
      </DockIconButton>
    </div>
  );
}
