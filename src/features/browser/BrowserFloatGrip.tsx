import { useState } from "react";
import { useChatStore } from "@/features/chat/store";
import { BrowserMiniControls } from "./BrowserMiniControls";

/**
 * Os controles da miniatura. O buraco que eles abrem na página nativa é fixo: sempre presente enquanto a
 * miniatura existe (`data-over-webview`), não só com o mouse por cima. Assim o clique cai no botão mesmo que o
 * primeiro movimento ainda não tenha chegado ao motor. O hover só muda a aparência.
 */
export function BrowserFloatGrip({ viewId }: { viewId: string }) {
  const miniHover = useChatStore((state) => state.browserMiniHover[viewId] ?? false);
  const [domHover, setDomHover] = useState(false);
  const hover = miniHover || domHover;
  return (
    <div
      className="group absolute right-2.5 top-2.5 z-40 pointer-events-auto"
      data-browser-mini-controls
      data-over-webview
      data-hover={hover}
      onPointerEnter={() => setDomHover(true)}
      onPointerLeave={() => setDomHover(false)}
    >
      <BrowserMiniControls />
    </div>
  );
}
