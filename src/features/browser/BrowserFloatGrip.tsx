import { useState } from "react";
import { useChatStore } from "@/features/chat/store";
import { BrowserMiniControls } from "./BrowserMiniControls";

/**
 * Os controles da miniatura. Sem hover/foco ficam em `opacity-0` e usam `data-over-webview="hit"` para
 * receber o primeiro clique/hover sem abrir um retângulo visual branco na página nativa. Quando ficam
 * visíveis (`hover || focused`), abrem o recorte visual normal (`""`).
 */
export function BrowserFloatGrip({ viewId }: { viewId: string }) {
  const miniHover = useChatStore((state) => state.browserMiniHover[viewId] ?? false);
  const [domHover, setDomHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const hover = miniHover || domHover;
  const controlsVisible = hover || focused;
  return (
    <div
      className="group absolute right-2.5 top-2.5 z-40 pointer-events-auto"
      data-browser-mini-controls
      data-over-webview={controlsVisible ? "" : "hit"}
      data-hover={hover}
      onPointerEnter={() => setDomHover(true)}
      onPointerLeave={() => setDomHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <BrowserMiniControls />
    </div>
  );
}
