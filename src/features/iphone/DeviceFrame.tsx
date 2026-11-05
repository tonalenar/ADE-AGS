import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

import { iphoneButtonState } from "./ipc";
import type { FrameButton, FrameLayout } from "./model";

/** O rótulo de cada botão da lateral, com o atalho do Mac (quando há). */
function labelKey(b: FrameButton): string {
  if (b.kind === "action") return "iphone.frame.action";
  if (b.kind === "switch") return "iphone.frame.switch";
  return `iphone.frame.${b.button}`;
}

/** Um botão físico na borda da moldura: aperta ao descer o ponteiro e solta ao subir (segurar funciona como no
 *  aparelho), acende enquanto apertado e mostra o nome ao lado ao passar o mouse. */
function SideButton({ b, device, name, height, width, enabled }: { b: FrameButton; device: string; name: string; height: number; width: number; enabled: boolean }) {
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);
  const label = t(labelKey(b));
  const send = (down: boolean) => {
    if (!enabled) return;
    iphoneButtonState(device, b.button, down).catch((e) => { void AlertaToast(name, String(e), "error", 4000); });
  };
  const release = () => {
    if (!pressed) return;
    setPressed(false);
    send(false);
  };
  const thick = Math.max(3, Math.round(width * 0.012));
  const pos = b.side === "top"
    ? { top: -thick, left: Math.round(b.top * width), width: Math.max(12, Math.round(b.height * width)), height: thick + 1 }
    : { top: Math.round(b.top * height), height: Math.max(10, Math.round(b.height * height)), width: thick + 1, [b.side]: -thick };
  return (
    <>
      <button type="button" aria-label={label} disabled={!enabled}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setPressed(true); send(true); }}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        className={`nodrag absolute z-10 rounded-[2px] transition-colors motion-reduce:transition-none ring-1 ring-black/40
          ${pressed ? "bg-accent-500" : "bg-gray-400 dark:bg-surface-overlay hover:bg-gray-500 dark:hover:bg-gray-500"} disabled:opacity-60`}
        style={pos} />
      {hover && (
        <span role="tooltip" className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium
          bg-gray-900 text-white dark:bg-surface-raised dark:ring-1 dark:ring-white/10 shadow-lg"
          style={b.side === "top"
            ? { top: -thick - 30, left: pos.left }
            : { top: (pos.top as number) + (pos.height as number) / 2 - 12, ...(b.side === "left" ? { right: `calc(100% + ${thick + 8}px)` } : { left: `calc(100% + ${thick + 8}px)` }) }}>
          {label}
        </span>
      )}
    </>
  );
}

/**
 * A moldura realista do aparelho físico (clara ou escura com o tema), com a Ilha Dinâmica e os botões da lateral
 * funcionando. `screen` = o tamanho da tela em px; a moldura cresce em volta pela borda do modelo. `children` = a tela.
 */
export function DeviceFrame({ device, name, layout, screen, enabled, children }: {
  device: string;
  name: string;
  layout: FrameLayout;
  screen: { width: number; height: number };
  /** O toque está pronto: os botões funcionam. */
  enabled: boolean;
  children: ReactNode;
}) {
  const pad = Math.round(screen.width * layout.bezel);
  const screenRadius = Math.round(screen.width * layout.radius);
  const outer = { width: screen.width + 2 * pad, height: screen.height + 2 * pad };
  const island = { width: Math.round(screen.width * 0.29), height: Math.round(screen.width * 0.085), top: Math.round(screen.width * 0.027) };
  return (
    <div className="relative shrink-0" style={outer}>
      {layout.buttons.map((b) => (
        <SideButton key={`${b.side}-${b.button}`} b={b} device={device} name={name} height={outer.height} width={outer.width} enabled={enabled} />
      ))}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-300 via-gray-200 to-gray-400 dark:from-surface-overlay dark:via-surface-raised dark:to-surface-overlay
        shadow-[0_24px_48px_-20px_rgba(0,0,0,0.45)] ring-1 ring-gray-400 dark:ring-white/10"
        style={{ borderRadius: screenRadius + pad, padding: Math.max(2, Math.round(pad * 0.18)) }}>
        <div className="h-full w-full bg-black" style={{ borderRadius: screenRadius + pad - Math.max(2, Math.round(pad * 0.18)), padding: pad - Math.max(2, Math.round(pad * 0.18)) }}>
          <div className="relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: screenRadius }}>
            {children}
            {layout.island && (
              <span aria-hidden="true" className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
                style={{ top: island.top, width: island.width, height: island.height }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** O raio dos cantos da tela, em px, para a tela nativa (`PhysicalMirror`). */
export function screenRadiusOf(layout: FrameLayout, screenWidth: number): number {
  return Math.round(screenWidth * layout.radius);
}
