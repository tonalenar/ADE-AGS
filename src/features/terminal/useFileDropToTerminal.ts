import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "@/i18n";
import { useTabsStore } from "@/features/tabs/store";
import { focusTab, pasteIntoTab } from "./terminalRegistry";
import { formatPathsForAgent } from "./formatPathsForAgent";
import { showBotToast } from "@/shared/brand/botToastStore";

/** La tab de la terminal bajo el punto (en píxeles lógicos), o `null`. */
export function terminalTabAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-terminal-tab]");
  return el?.dataset.terminalTab || null;
}

/**
 * Soltar archivos del sistema sobre una terminal escribe sus rutas en el prompt del agente,
 * sin Enter. Solo se usan las rutas: no se lee el contenido. Se monta una sola vez.
 */
export function useFileDropToTerminal(): void {
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop" || p.paths.length === 0) return;
        const ratio = window.devicePixelRatio || 1;
        const tabId = terminalTabAt(p.position.x / ratio, p.position.y / ratio);
        if (!tabId) return;
        const agentId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.agentId;
        if (pasteIntoTab(tabId, formatPathsForAgent(agentId, p.paths), false)) {
          focusTab(tabId);
          showBotToast({ title: i18n.t("terminal.attach.title"), text: i18n.t("terminal.attach.files", { count: p.paths.length }), ms: 2500 });
        }
      })
      .then((fn) => { if (disposed) fn(); else off = fn; })
      .catch(console.error);
    return () => { disposed = true; off?.(); };
  }, []);
}
