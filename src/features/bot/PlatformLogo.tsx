import { useEffect, useRef } from "react";

import { LOGO_SIZE, logoPixels, type LogoKind } from "./platformLogos";

/** O logo pixel-art 12x12 de uma plataforma, desenhado num canvas (sem imagens externas). */
export function PlatformLogo({ kind, size = LOGO_SIZE }: { kind: LogoKind; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = ref.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, LOGO_SIZE, LOGO_SIZE);
    for (const [x, y, color] of logoPixels(kind)) {
      context.fillStyle = color;
      context.fillRect(x, y, 1, 1);
    }
  }, [kind]);
  return (
    <canvas ref={ref} width={LOGO_SIZE} height={LOGO_SIZE} aria-hidden="true" className="ags-live__logo"
      style={{ width: size, height: size, imageRendering: "pixelated" }} />
  );
}
