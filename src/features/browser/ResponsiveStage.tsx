import { useEffect, useRef, useState, type ReactNode } from "react";

import { breakpointOf, clampViewport, fillLayout, fitScale, isFillViewport, isPhoneViewport, type Viewport } from "./viewport";
import { clampZoom, stageSize } from "./zoom";
import { DEVICE_BEZEL, type DeviceSpec } from "./devices";

type Edge = "x" | "y" | "xy";

/**
 * Donde se muestra la página: ocupando toda la tab o, con un tamaño elegido, en un marco
 * de ese tamaño que se agarra de los bordes para cambiarlo.
 *
 * El iframe (`children`) va SIEMPRE en el mismo lugar del árbol, con o sin marco: si React
 * lo desmontara al prender el modo responsive, la página se recargaría y perdería su
 * estado — justo lo que se quiere probar en otro ancho.
 *
 * Un tamaño más grande que el espacio se muestra achicado, pero la página sigue midiendo
 * lo que se pidió: las media queries ven 1440 px aunque en pantalla ocupe la mitad.
 */
export function ResponsiveStage({ viewport, onResize, zoom = 1, device = null, children }: {
  viewport: Viewport | null;
  /** "Celular solto": só o aparelho, centrado no espaço, sem o quadro, as alças nem o rótulo. A árvore é a mesma
   *  dos outros modos, para o iframe não recarregar ao trocar. */
  device?: DeviceSpec | null;
  onResize: (viewport: Viewport) => void;
  /** O zoom da página. Sem marco, a página é desenhada maior/menor e escalada de volta; com marco, multiplica a escala. */
  zoom?: number;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<Viewport>({ width: 0, height: 0 });
  /** O espaço inteiro do palco (sem a margem do quadro): é o que a página ocupa no modo de preencher. */
  const [box, setBox] = useState<Viewport>({ width: 0, height: 0 });
  /** Mientras se arrastra: el tamaño en curso y la escala congelada al empezar. Si la
   *  escala se recalculara con cada movimiento, el borde se escaparía del puntero. */
  const [drag, setDrag] = useState<{ draft: Viewport; scale: number } | null>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      // El padding del escenario y el rótulo de abajo no son espacio para el marco.
      setAvailable({ width: entry.contentRect.width - 56, height: entry.contentRect.height - 64 });
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = drag?.draft ?? viewport;
  const z = clampZoom(zoom);
  // `overflow: clip` (não `hidden`): `hidden` ainda é um contêiner de rolagem, e o navegador o rola sozinho (foco ou scrollIntoView
  // dentro do iframe), deslocando a página para fora da coluna; `clip` não rola.
  // 1920×1080 preenche a janela inteira, sem margem (ver `FILL_VIEWPORT`); arrastar o quadro sai desse modo.
  const fill = !drag && isFillViewport(viewport);
  const filled = fill && viewport ? fillLayout(viewport, box, z) : null;
  const scale = shown ? (drag?.scale ?? Math.max(0.1, fitScale(shown, available) * z)) : 1;
  // Num tamanho de celular o quadro vira o aparelho (moldura, cantos, ilha, botões), como num mockup.
  const phone = !!shown && !fill && isPhoneViewport(shown);
  const landscape = !!shown && shown.width > shown.height;
  // No celular solto a escala é a que cabe o aparelho inteiro (com a moldura) no espaço do palco.
  const pad = (DEVICE_BEZEL + 10) * 2;
  const deviceScale = device ? Math.max(0.1, Math.min((box.width - pad) / device.width, (box.height - pad) / device.height)) : 1;

  const startDrag = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!viewport || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const origin = { x: e.clientX, y: e.clientY, viewport, scale };
    let draft = viewport;
    setDrag({ draft, scale });

    const move = (ev: PointerEvent) => {
      // El marco está centrado a lo ancho: el borde se mueve la mitad de lo que crece, así
      // que el ancho suma el doble del desplazamiento para que el borde siga al puntero.
      const dx = ((ev.clientX - origin.x) * 2) / origin.scale;
      const dy = (ev.clientY - origin.y) / origin.scale;
      draft = clampViewport({
        width: edge === "y" ? origin.viewport.width : origin.viewport.width + dx,
        height: edge === "x" ? origin.viewport.height : origin.viewport.height + dy,
      });
      setDrag({ draft, scale: origin.scale });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDrag(null);
      onResize(draft);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div
      ref={stage}
      className={device
        ? "relative flex-1 min-h-0 flex items-center justify-center bg-transparent"
        : fill
        ? "relative flex-1 min-h-0 overflow-clip bg-white"
        : shown
          ? "relative flex-1 min-h-0 overflow-auto px-7 pt-5 pb-11 bg-gray-100 dark:bg-surface-deep bg-[radial-gradient(circle,rgba(120,130,150,0.22)_1px,transparent_1px)] [background-size:16px_16px]"
          : "relative flex-1 min-h-0 bg-white"}
    >
      <div
        className={device ? "ade-device-in" : undefined}
        style={device
          ? { position: "relative", width: device.width * deviceScale, height: device.height * deviceScale, flexShrink: 0 }
          : fill
          ? { position: "absolute", inset: 0, overflow: "clip" }
          : shown
            ? { position: "relative", width: shown.width * scale, height: shown.height * scale, margin: "0 auto", flexShrink: 0 }
            : { position: "absolute", inset: 0, overflow: "clip" }}
      >
        <div
          style={device
            ? {
              width: device.width, height: device.height, transform: `scale(${deviceScale})`, transformOrigin: "0 0",
              ...phoneScreen(deviceScale, device.radius),
            }
            : filled
            ? {
              width: filled.width ?? "100%", height: filled.height ?? "100%",
              transform: filled.scale === 1 ? undefined : `scale(${filled.scale})`, transformOrigin: "0 0",
            }
            : shown
              ? {
                width: shown.width, height: shown.height, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "0 0",
                ...(phone ? phoneScreen(scale) : {}),
              }
              : { ...stageSize(z), transform: z === 1 ? undefined : `scale(${z})`, transformOrigin: "0 0" }}
          className={device || phone ? "relative bg-white" : shown && !fill ? "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_32px_-12px_rgba(0,0,0,0.35)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_12px_32px_-12px_rgba(0,0,0,0.8)]" : undefined}
        >
          {children}
          {(device || phone) && <PhoneOverlay landscape={!device && landscape} cutout={device?.cutout ?? "island"} />}
        </div>
        {(device || phone) && <PhoneButtons landscape={!device && landscape} />}

        {shown && !fill && !device && (
          <>
            <Handle edge="x" onPointerDown={startDrag("x")} />
            <Handle edge="y" onPointerDown={startDrag("y")} />
            <Handle edge="xy" onPointerDown={startDrag("xy")} />
            <div className="absolute left-0 right-0 top-full mt-2.5 flex justify-center pointer-events-none">
              <span className={`px-2 h-5 rounded-full font-mono text-[10.5px] leading-5 tabular-nums
                ${drag ? "bg-accent-600 text-white" : "bg-white/90 dark:bg-white/8 text-gray-600 dark:text-white/55 ring-1 ring-gray-200 dark:ring-white/10"}`}>
                {shown.width} × {shown.height}
                <span className="opacity-60"> · {breakpointOf(shown.width)}{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}</span>
              </span>
            </div>
          </>
        )}
      </div>
      {/* Mientras se arrastra, el iframe no puede quedarse con el puntero: si el mouse pasa
          por encima de la página, los eventos se irían a ella y el arrastre se cortaría. */}
      {drag && <div className="fixed inset-0 z-50" style={{ cursor: "grabbing" }} />}
    </div>
  );
}

function Handle({ edge, onPointerDown }: { edge: Edge; onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  const place = edge === "x"
    ? "top-0 -right-4 w-4 h-full cursor-ew-resize flex items-center justify-center"
    : edge === "y"
      ? "left-0 -bottom-4 h-4 w-full cursor-ns-resize flex items-center justify-center"
      : "-right-4 -bottom-4 w-4 h-4 cursor-nwse-resize";
  const grip = edge === "x" ? "w-1 h-8" : edge === "y" ? "h-1 w-8" : "w-1.5 h-1.5";
  return (
    <div role="separator" aria-orientation={edge === "y" ? "horizontal" : "vertical"} onPointerDown={onPointerDown}
      className={`group absolute z-10 touch-none ${place}`}>
      <span className={`block rounded-full bg-gray-400/70 dark:bg-white/25 group-hover:bg-accent-500 ${grip}
        ${edge === "xy" ? "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" : ""}`} />
    </div>
  );
}

/** A moldura do aparelho em pixels de TELA: a página é escalada, então a espessura é dividida pela escala. */
const BEZEL = DEVICE_BEZEL;
/** O raio da tela do aparelho, em pixels da página (como um iPhone recente). */
const SCREEN_RADIUS = 52;

/** A tela do aparelho: cantos arredondados que recortam a página e a moldura preta em volta (por sombra, para não
 *  mudar o tamanho que a página mede). Pura. */
export function phoneScreen(scale: number, radius = SCREEN_RADIUS): React.CSSProperties {
  const px = (n: number) => `${n / Math.max(scale, 0.05)}px`;
  return {
    borderRadius: radius,
    overflow: "hidden",
    boxShadow: `0 0 0 ${px(BEZEL)} #0b0b0d, 0 0 0 ${px(BEZEL + 1.5)} #3a3a3e, 0 ${px(22)} ${px(54)} rgba(0,0,0,0.45)`,
  };
}

/** O que fica por cima da página: a ilha (no topo, ou à esquerda com o aparelho deitado) e a barra de início. Não
 *  pega clique: a página continua respondendo embaixo. */
function PhoneOverlay({ landscape, cutout = "island" }: { landscape: boolean; cutout?: "island" | "punch" }) {
  // A ilha do iPhone, ou o furo da câmera dos Android.
  const island: React.CSSProperties = cutout === "punch"
    ? (landscape
      ? { left: 14, top: "50%", transform: "translateY(-50%)", width: 13, height: 13 }
      : { top: 14, left: "50%", transform: "translateX(-50%)", width: 13, height: 13 })
    : landscape
      ? { left: 12, top: "50%", transform: "translateY(-50%)", width: 34, height: 118 }
      : { top: 12, left: "50%", transform: "translateX(-50%)", width: 118, height: 34 };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute rounded-full bg-black" style={island} />
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 h-[5px] w-[134px] rounded-full bg-black/35" />
    </div>
  );
}

/** Os botões na lateral do aparelho (volume à esquerda, liga/desliga à direita), em pixels de tela. */
function PhoneButtons({ landscape }: { landscape: boolean }) {
  const side = (style: React.CSSProperties) => <span className="absolute rounded-sm bg-[#2a2a2e]" style={style} />;
  const out = -(BEZEL + 4);
  return landscape ? (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {side({ top: out, left: "18%", width: 28, height: 3 })}
      {side({ top: out, left: "26%", width: 46, height: 3 })}
      {side({ top: out, left: "36%", width: 46, height: 3 })}
      {side({ bottom: out, left: "30%", width: 66, height: 3 })}
    </div>
  ) : (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {side({ left: out, top: "16%", width: 3, height: 28 })}
      {side({ left: out, top: "24%", width: 3, height: 46 })}
      {side({ left: out, top: "33%", width: 3, height: 46 })}
      {side({ right: out, top: "27%", width: 3, height: 66 })}
    </div>
  );
}
