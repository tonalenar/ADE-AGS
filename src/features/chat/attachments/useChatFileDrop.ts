import { useEffect, type RefObject } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { terminalTabAt } from "@/features/terminal/useFileDropToTerminal";

import { activeDropSink, insideRect, setDropHighlight } from "./dropRegistry";

/**
 * O arrasto nativo de arquivos do Finder para a coluna do chat inteira (o `target`): realça "Solte para
 * anexar" enquanto passa e, ao soltar, entrega os CAMINHOS ao composer à vista. Só os caminhos: nada é lido
 * aqui. Soltar sobre um terminal continua colando o caminho no terminal (`useFileDropToTerminal`).
 */
export function useChatFileDrop(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") { setDropHighlight(false); return; }
        const ratio = window.devicePixelRatio || 1;
        const x = p.position.x / ratio;
        const y = p.position.y / ratio;
        const el = target.current;
        const accepts = !!el && insideRect(el.getBoundingClientRect(), x, y) && terminalTabAt(x, y) === null && activeDropSink() !== null;
        if (p.type === "drop") {
          setDropHighlight(false);
          if (accepts && p.paths.length > 0) activeDropSink()?.addPaths(p.paths);
          return;
        }
        setDropHighlight(accepts);
      })
      .then((fn) => { if (disposed) fn(); else off = fn; })
      .catch(console.error);
    return () => { disposed = true; off?.(); setDropHighlight(false); };
  }, [target]);
}
