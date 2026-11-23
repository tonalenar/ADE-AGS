import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AlertaToast } from "@/shared/ui/alerts";

import { iphoneButtonState } from "./ipc";
import { placeFrameButton, type FrameButton, type FrameLayout, type FrameSide } from "./model";

/** O rótulo de cada botão da lateral, com o atalho do Mac (quando há). */
function labelKey(b: FrameButton): string {
  if (b.kind === "action") return "iphone.frame.action";
  if (b.kind === "switch") return "iphone.frame.switch";
  return `iphone.frame.${b.button}`;
}

/** Um botão físico na borda da moldura: aperta ao descer o ponteiro e solta ao subir (segurar funciona como no
 *  aparelho), acende enquanto apertado e mostra o nome ao lado ao passar o mouse. */
function SideButton({ b, device, name, short, placed, enabled }: { b: FrameButton; device: string; name: string; short: number; placed: { side: FrameSide; start: number; along: number }; enabled: boolean }) {
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);
  // O `down` que já foi ao aparelho. O `up` sai sempre que ele existir: se a sessão cair no meio do aperto (`enabled`
  // vira `false`), o botão do aparelho não pode ficar apertado (volume subindo, Siri aberta) até a próxima interação.
  const downSent = useRef(false);
  const label = t(labelKey(b));
  const send = (down: boolean) => {
    iphoneButtonState(device, b.button, down).catch((e) => { void AlertaToast(name, String(e), "error", 4000); });
  };
  const press = () => {
    if (!enabled) return;
    setPressed(true);
    downSent.current = true;
    send(true);
  };
  const release = () => {
    setPressed(false);
    if (!downSent.current) return;
    downSent.current = false;
    send(false);
  };
  // Se o botão some (o nó fecha, a aba muda) com o dedo ainda no botão, o aparelho também recebe o soltar.
  useEffect(() => () => {
    if (!downSent.current) return;
    downSent.current = false;
    void iphoneButtonState(device, b.button, false).catch(() => undefined);
  }, [device, b.button]);
  // O botão sai da borda só o que sai no aparelho (~0,9% da largura) e tem o mesmo metal do aro; a área de clique é
  // maior que o desenho e avança um pouco sobre o aro, para não exigir mira de pixel.
  const thick = Math.max(2.5, short * 0.009);
  const grab = 6;
  const { side } = placed;
  const along = placed.side === "top" || placed.side === "bottom" ? Math.max(14, placed.along) : Math.max(12, placed.along);
  const start = placed.start;
  const horizontal = side === "top" || side === "bottom";
  const pos: React.CSSProperties = horizontal
    ? { left: start, width: along, height: thick + 2 + grab, [side]: -thick - 2 }
    : { top: start, height: along, width: thick + 2 + grab, [side]: -thick - 2 };
  const toward = side === "left" || side === "top" ? 1 : -1;
  const visual: React.CSSProperties = horizontal
    ? { left: 0, right: 0, height: thick + 1, [side]: 2,
      borderRadius: side === "top" ? `${thick}px ${thick}px 0 0` : `0 0 ${thick}px ${thick}px`,
      transform: pressed ? `translateY(${toward * thick * 0.6}px)` : undefined }
    : { top: 0, bottom: 0, width: thick + 1, [side]: 2,
      borderRadius: side === "left" ? `${thick}px 0 0 ${thick}px` : `0 ${thick}px ${thick}px 0`,
      transform: pressed ? `translateX(${toward * thick * 0.6}px)` : undefined };
  return (
    <>
      <button type="button" aria-label={label} title={label} disabled={!enabled}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); press(); }}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        className="nodrag group absolute z-[2] cursor-pointer disabled:cursor-default focus-visible:outline-none" style={pos}>
        <span aria-hidden="true" style={visual}
          className={`absolute transition-[transform,filter] duration-100 motion-reduce:transition-none ${horizontal ? "bg-gradient-to-b" : "bg-gradient-to-r"}
            from-gray-400 via-gray-200 to-gray-400 dark:from-gray-600 dark:via-gray-400 dark:to-gray-600 shadow-[0_0_0_0.5px_rgba(0,0,0,0.25)]
            group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-accent-500 ${pressed ? "brightness-90" : ""} group-disabled:opacity-70`} />
      </button>
      {hover && (
        <span role="tooltip" className="pointer-events-none absolute z-20 w-max max-w-[calc(100%_-_24px)] whitespace-normal break-words rounded-md px-2 py-1 text-[11px] font-medium
          bg-gray-900 text-white dark:bg-surface-raised dark:ring-1 dark:ring-white/10 shadow-lg"
          // Por dentro da moldura (à direita dos botões da esquerda, à esquerda do da direita, abaixo do superior): fora
          // dela a legenda passava da borda do painel e era cortada. Por cima da tela nativa, o `role="tooltip"` abre um
          // buraco na camada (ver `browser/nativeSurface.ts::OVERLAYS`).
          style={horizontal
            ? { [side]: thick + 8, left: "50%", transform: "translateX(-50%)" }
            : { top: start + along / 2 - 12, ...(side === "left" ? { left: thick + 10 } : { right: thick + 10 }) }}>
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
  // Tudo sai do LADO MENOR da tela: girar o aparelho não muda a moldura, os cantos nem a ilha, só os leva de lugar.
  const short = Math.min(screen.width, screen.height);
  const landscape = screen.width > screen.height;
  const pad = Math.round(short * layout.bezel);
  const screenRadius = Math.round(short * layout.radius);
  const outer = { width: screen.width + 2 * pad, height: screen.height + 2 * pad };
  const rim = Math.max(2, Math.round(short * 0.011));
  const islandLong = Math.round(short * 0.29);
  const islandShort = Math.round(short * 0.085);
  const islandBox: React.CSSProperties = landscape
    ? { left: Math.round(short * 0.027), top: "50%", transform: "translateY(-50%)", width: islandShort, height: islandLong }
    : { top: Math.round(short * 0.027), left: "50%", transform: "translateX(-50%)", width: islandLong, height: islandShort };
  return (
    <div className="relative shrink-0" style={outer}>
      {layout.buttons.map((b) => (
        <SideButton key={`${b.side}-${b.button}`} b={b} device={device} name={name} short={Math.min(outer.width, outer.height)}
          placed={placeFrameButton(b, landscape, outer)} enabled={enabled} />
      ))}
      {/* O aro de metal (fino, com brilho em cima e sombra embaixo), a borda preta e a tela. Os botões ficam por cima, encostados no aro. */}
      <div className="absolute inset-0 z-[1] bg-gradient-to-b from-gray-200 via-gray-400 to-gray-300 dark:from-gray-500 dark:via-gray-700 dark:to-gray-600
        shadow-[0_30px_60px_-24px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.6)]"
        style={{ borderRadius: screenRadius + pad, padding: rim }}>
        <div className="h-full w-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" style={{ borderRadius: screenRadius + pad - rim, padding: pad - rim }}>
          <div className="relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: screenRadius }}>
            {children}
            {layout.island && (
              <span aria-hidden="true" className="pointer-events-none absolute rounded-full bg-black" style={islandBox} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** O raio dos cantos da tela, em px, para a tela nativa (`PhysicalMirror`). */
export function screenRadiusOf(layout: FrameLayout, screenWidth: number, screenHeight = screenWidth): number {
  return Math.round(Math.min(screenWidth, screenHeight) * layout.radius);
}
