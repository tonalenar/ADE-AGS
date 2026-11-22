import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { isAppDark } from "@/features/canvas/design/artboardBridge";
import { resetFrameErrors, snapshotOf, useArtboardStorage, useFrameErrors } from "@/features/canvas/design/artboardStore";
import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";
import { useDesignFrame } from "@/shared/ipc/designFrame";

import { FrameErrorBadge, type StudioBoard } from "./ArtboardFrame";
import { focusFrame } from "./focusGeometry";
import { postToFrame, studioSrcdoc } from "./frameBridge";

/**
 * O modo focado: uma prancheta só, viva como protótipo clicável (links entre pranchetas navegam, e o Play
 * fica ligado). Preencher = a janela; Caber = a prancheta inteira, reduzida. A largura escolhida (desktop,
 * tablet, celular) redimensiona o frame; sem escolha, vale a largura original da prancheta.
 */
export function FocusedView({ board, fit, width, register }: {
  board: StudioBoard;
  fit: "fill" | "fit";
  /** Largura de `FRAME_WIDTHS`, ou `null` para a original. */
  width: number | null;
  register: (el: HTMLIFrameElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const { ready, epoch } = useArtboardStorage(board.id, true);
  const errors = useFrameErrors(board.id);
  const srcDoc = useMemo(
    () => (ready ? studioSrcdoc(board.html, { storage: snapshotOf(board.id), dark: isAppDark() }) : ""),
    [board.id, board.html, ready, epoch],
  );
  useLayoutEffect(() => { resetFrameErrors(board.id); }, [srcDoc, board.id]);
  const frameDoc = useDesignFrame(srcDoc || null, "design");
  const frame = useRef<HTMLIFrameElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const f = focusFrame({ board: { w: board.w, h: board.h }, fit, width, box });
  return (
    <div ref={ref} className="relative flex-1 min-h-0 overflow-hidden bg-gray-100 dark:bg-surface-sunken">
      {box.w > 0 && frameDoc.ready && (
        <div className={`absolute bg-white overflow-clip ${fit === "fit" ? "shadow-[0_2px_4px_rgba(24,24,27,0.07),0_6px_16px_rgba(24,24,27,0.08)] ring-1 ring-gray-200 dark:ring-white/10" : ""}`}
          style={{
            width: f.w, height: f.h, left: f.left, top: f.top,
            transform: f.k !== 1 ? `scale(${f.k})` : undefined, transformOrigin: "0 0", borderRadius: fit === "fit" ? board.radius : 0,
          }}>
          <iframe key={board.id} title={board.title} sandbox={DESIGN_SANDBOX} src={frameDoc.src} srcDoc={frameDoc.srcDoc} referrerPolicy="no-referrer" data-artboard-id={board.id}
            ref={(el) => { frame.current = el; register(el); }}
            onLoad={() => postToFrame(frame.current, { kind: "mode", mode: "play" })}
            className="block border-0 w-full h-full" />
        </div>
      )}
      {errors.length > 0 && <div className="absolute left-3 bottom-3"><FrameErrorBadge errors={errors} /></div>}
    </div>
  );
}
