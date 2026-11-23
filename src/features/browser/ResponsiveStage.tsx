import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { breakpointOf, clampViewport, fillLayout, fitScale, isFillViewport, isPhoneViewport, type Viewport } from "./viewport";
import { clampZoom, stageSize } from "./zoom";
import { DEVICE_BEZEL, type DeviceSpec } from "./devices";
import { PHONE_MODELS, cutoutBox, modelFor, type PhoneModel } from "./deviceCatalog";
import { buttonRects, miniScale, monitorFrame } from "./phoneGeometry";
import { PhoneChrome, type Platform } from "./PhoneChrome";
import type { PhoneActions } from "./deviceActions";
import { NativeCornerRadius } from "./nativeCorner";
import { useChatStore } from "@/features/chat/store";

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
export function ResponsiveStage({ viewport, onResize, zoom = 1, device = null, platform = null, url = "", actions, floatingPreview = false, children }: {
  viewport: Viewport | null;
  /** "Celular solto": só o aparelho, centrado no espaço, sem o quadro, as alças nem o rótulo. A árvore é a mesma
   *  dos outros modos, para o iframe não recarregar ao trocar. */
  device?: DeviceSpec | null;
  onResize: (viewport: Viewport) => void;
  /** Num tamanho de celular, o sistema que o aparelho imita: desenha a barra de status e o Safari/Chrome em volta da página. */
  platform?: Platform | null;
  /** O endereço mostrado na barra do Safari/Chrome do mockup. */
  url?: string;
  /** Os botões da moldura do celular (barra do Chrome do Android). */
  actions?: PhoneActions;
  /** O zoom da página. Sem marco, a página é desenhada maior/menor e escalada de volta; com marco, multiplica a escala. */
  zoom?: number;
  /** Na miniatura flutuante: só o aparelho, centrado, sem o pontilhado, as alças nem o rótulo, com a margem mínima
   *  para a moldura. */
  floatingPreview?: boolean;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  /** O espaço inteiro do palco (sem a margem do quadro): é o que a página ocupa no modo de preencher. */
  const floatRect = useChatStore((s) => floatingPreview ? s.browserFloatRect : null);
  const [box, setBox] = useState<Viewport>(() => {
    if (floatingPreview) {
      const fr = useChatStore.getState().browserFloatRect;
      if (fr && fr.width > 0 && fr.height > 0) return { width: fr.width, height: fr.height };
    }
    return { width: 0, height: 0 };
  });
  /** Enquanto flutuante, o palco acompanha diretamente o retângulo da miniatura sem atraso de medição. */
  const effectiveBox: Viewport = floatingPreview && floatRect && floatRect.width > 0 && floatRect.height > 0
    ? { width: floatRect.width, height: floatRect.height }
    : box;
  /** Mientras se arrastra: el tamaño en curso y la escala congelada al empezar. Si la
   *  escala se recalculara con cada movimiento, el borde se escaparía del puntero. */
  const [drag, setDrag] = useState<{ draft: Viewport; scale: number } | null>(null);

  const stageMode = device ? "device" : (!drag && isFillViewport(viewport)) ? "fill" : (floatingPreview && !!viewport && !isFillViewport(viewport)) ? "mini" : viewport ? "framed" : "free";

  // Mede antes de pintar: sem isso o primeiro quadro saía com o palco 0×0, a escala caía em 1 e o celular aparecia
  // gigante por um instante (e a vista nativa ia junto). O ResizeObserver fica conectado uma única vez no mount.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const update = (width: number, height: number) => {
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    const observer = new ResizeObserver(([entry]) => {
      update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const width = Math.max(0, el.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
    const height = Math.max(0, el.clientHeight - px(style.paddingTop) - px(style.paddingBottom));
    setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [stageMode]);

  const shown = drag?.draft ?? viewport;
  const z = clampZoom(zoom);
  const phoneShown = !!shown && isPhoneViewport(shown);
  const mini = floatingPreview && !!shown && !isFillViewport(shown) && !device;
  // O aparelho (a moldura sai da tela em volta): o modelo dá o raio, a moldura, a ilha e os botões.
  const model: PhoneModel = device
    ? (PHONE_MODELS.find((m) => m.id === device.id) ?? modelFor(device.cutout === "punch" ? "android" : "ios", device))
    : modelFor(platform ?? "ios", shown);
  // El padding del escenario y el rótulo de abajo no son espacio para el marco. Na miniatura, só a margem da moldura.
  const available: Viewport = mini
    ? { width: effectiveBox.width, height: effectiveBox.height }
    : { width: effectiveBox.width - 56, height: effectiveBox.height - 64 };
  // `overflow: clip` (não `hidden`): `hidden` ainda é um contêiner de rolagem, e o navegador o rola sozinho (foco ou scrollIntoView
  // dentro do iframe), deslocando a página para fora da coluna; `clip` não rola.
  // 1920×1080 preenche a janela inteira, sem margem (ver `FILL_VIEWPORT`); arrastar o quadro sai desse modo.
  const fill = !drag && isFillViewport(viewport);
  const filled = fill && viewport ? fillLayout(viewport, effectiveBox, z) : null;
  // Na miniatura do celular a escala conta a moldura: o aparelho inteiro ocupa justo o retângulo da miniatura.
  const miniPhone = mini && phoneShown && !!shown;
  const scale = shown
    ? (drag?.scale ?? (miniPhone ? miniScale(shown, available, model, MINI_MARGIN) * z : Math.max(0.1, fitScale(shown, available) * z)))
    : 1;
  // Num tamanho de celular o quadro vira o aparelho (moldura, cantos, ilha, botões), como num mockup.
  const phone = !!shown && !fill && isPhoneViewport(shown);
  const landscape = !!shown && shown.width > shown.height;
  // Com o sistema escolhido, o aparelho desenha o próprio topo e rodapé (a ilha vai dentro da barra de status).
  const chrome: Platform | null = phone && !device ? platform : null;
  // No celular solto a escala é a que cabe o aparelho inteiro (com a moldura) no espaço do palco.
  const pad = (DEVICE_BEZEL + 10) * 2;
  const deviceScale = device ? Math.max(0.1, Math.min((effectiveBox.width - pad) / device.width, (effectiveBox.height - pad) / device.height)) : 1;
  // Os cantos da tela, em px da janela, para a vista nativa não vazar pelos cantos arredondados.
  const cornerRadius = device ? device.radius * deviceScale : phone ? model.radius * scale : 0;

  // Fora do chassi: as alças e o rótulo ficam depois da moldura e dos botões, sem pisar neles.
  const handleGap = phone ? Math.ceil(monitorFrame(model, scale).bezel + monitorFrame(model, scale).rim) + 6 : 0;

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
        : mini
        ? "relative flex-1 min-h-0 flex items-center justify-center overflow-visible bg-transparent"
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
              ...phoneScreen(deviceScale, device.radius, model),
            }
            : filled
            ? {
              width: filled.width ?? "100%", height: filled.height ?? "100%",
              transform: filled.scale === 1 ? undefined : `scale(${filled.scale})`, transformOrigin: "0 0",
            }
            : shown
              ? {
                width: shown.width, height: shown.height, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "0 0",
                ...(phone ? phoneScreen(scale, model.radius, model) : {}),
              }
              : { ...stageSize(z), transform: z === 1 ? undefined : `scale(${z})`, transformOrigin: "0 0" }}
          className={device || phone ? `relative ${chrome === "android" ? "bg-white dark:bg-surface" : "bg-black"}` : shown && !fill ? "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_32px_-12px_rgba(0,0,0,0.35)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_12px_32px_-12px_rgba(0,0,0,0.8)]" : undefined}
        >
          <NativeCornerRadius.Provider value={Math.round(cornerRadius * 10) / 10}>
            <PhoneChrome platform={chrome} landscape={landscape} url={url} actions={actions}>{children}</PhoneChrome>
          </NativeCornerRadius.Provider>
          {(device || (phone && !chrome)) && <PhoneOverlay model={model} landscape={!device && landscape} cutout={device?.cutout ?? "island"} />}
        </div>
        {(device || phone) && (
          <PhoneButtons model={model} landscape={!device && landscape} scale={device ? deviceScale : scale}
            w={(device ? device.width : shown!.width) * (device ? deviceScale : scale)}
            h={(device ? device.height : shown!.height) * (device ? deviceScale : scale)} />
        )}

        {shown && !fill && !device && !mini && (
          <>
            <Handle edge="x" gap={handleGap} onPointerDown={startDrag("x")} />
            <Handle edge="y" gap={handleGap} onPointerDown={startDrag("y")} />
            <Handle edge="xy" gap={handleGap} onPointerDown={startDrag("xy")} />
            <div className="absolute left-0 right-0 top-full flex justify-center pointer-events-none" style={{ marginTop: handleGap + 4 }}>
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

function Handle({ edge, gap = 0, onPointerDown }: { edge: Edge; gap?: number; onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  const place = edge === "x"
    ? "top-0 w-4 h-full cursor-ew-resize flex items-center justify-center"
    : edge === "y"
      ? "left-0 h-4 w-full cursor-ns-resize flex items-center justify-center"
      : "w-4 h-4 cursor-nwse-resize";
  const offset: React.CSSProperties = edge === "x" ? { right: -16 - gap } : edge === "y" ? { bottom: -16 - gap } : { right: -16 - gap, bottom: -16 - gap };
  const grip = edge === "x" ? "w-1 h-8" : edge === "y" ? "h-1 w-8" : "w-1.5 h-1.5";
  return (
    <div role="separator" aria-orientation={edge === "y" ? "horizontal" : "vertical"} onPointerDown={onPointerDown}
      className={`group absolute z-10 touch-none ${place}`} style={offset}>
      <span className={`block rounded-full bg-gray-400/70 dark:bg-white/25 group-hover:bg-accent-500 ${grip}
        ${edge === "xy" ? "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" : ""}`} />
    </div>
  );
}

/** A folga, em px, entre o aparelho inteiro e a borda da miniatura. */
const MINI_MARGIN = 6;

/** A tela do aparelho: cantos arredondados que recortam a página e a moldura em volta (por sombra, para não mudar o
 *  tamanho que a página mede). A moldura é proporcional ao aparelho (pt do modelo × escala), com um mínimo legível, e
 *  as cores vêm dos tokens do tema. Pura. */
export function phoneScreen(scale: number, radius = 62, frame: { bezel: number; rim: number } = { bezel: 10, rim: 2 }): React.CSSProperties {
  const px = (n: number) => `${n / Math.max(scale, 0.05)}px`;
  const f = monitorFrame(frame, scale);
  return {
    borderRadius: radius,
    overflow: "hidden",
    boxShadow: `0 0 0 ${px(f.bezel)} var(--color-device-bezel), 0 0 0 ${px(f.bezel + f.rim)} var(--color-device-rim), 0 ${px(22)} ${px(54)} rgb(0 0 0 / 0.45)`,
  };
}

/** O que fica por cima da página: a ilha (no topo, ou à esquerda com o aparelho deitado) e a barra de início. Não
 *  pega clique: a página continua respondendo embaixo. */
function PhoneOverlay({ model, landscape, cutout = "island" }: { model: PhoneModel; landscape: boolean; cutout?: "island" | "punch" }) {
  // A ilha do iPhone, ou o furo da câmera dos Android, nas medidas do modelo.
  const box = cutoutBox(cutout === model.cutout.kind ? model : { ...model, cutout: { ...model.cutout, kind: cutout } }, landscape);
  const home = { width: landscape ? model.home.landscape : model.home.portrait, height: model.home.height, bottom: model.home.bottom };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute rounded-full bg-black" style={{ left: box.left, top: box.top, width: box.width, height: box.height, translate: box.translate }} />
      <div className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/35" style={home} />
    </div>
  );
}

/** Os botões na lateral do aparelho, na quiralidade real e proporcionais à escala. */
function PhoneButtons({ model, landscape, scale, w, h }: { model: PhoneModel; landscape: boolean; scale: number; w: number; h: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {buttonRects(model, landscape, w, h, scale).map((r) => (
        <span key={r.kind} data-phone-button={r.kind} className="absolute rounded-sm"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height, background: "var(--color-device-button)" }} />
      ))}
    </div>
  );
}
