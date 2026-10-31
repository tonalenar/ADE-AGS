import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { closeWindowWithSave } from "@/app/closeWithSave";
import { DESKTOP_OS } from "@/app/platform";

/*
 * Cerrar / minimizar / maximizar, nativos de cada sistema.
 *
 * - macOS: los semáforos REALES del AppKit (la ventana usa la barra de título "overlay"). Acá solo
 *   se reserva el lugar (`WindowLights`) y se le dice al backend dónde ponerlos
 *   (`window_controls_place`); al plegar la barra lateral o cambiar de modo, se mueven.
 * - Windows y Linux: la ventana es sin decoración y los botones se dibujan a la derecha, con la
 *   forma de cada sistema (`WindowControls`): los de Windows 11 (46 px, cerrar en rojo) y los
 *   redondos de GNOME.
 */

/** El lugar de los semáforos: 52×12, a la izquierda del encabezado. Fuera del macOS no ocupa nada. */
export function WindowLights() {
  return DESKTOP_OS === "macos" ? <MacLightsSlot /> : null;
}

/** Los botones de Windows o de Linux, al final del encabezado de la derecha. En el macOS no hay nada. */
export function WindowControls({ className = "" }: { className?: string }) {
  if (DESKTOP_OS === "windows") return <WindowsControls className={className} />;
  if (DESKTOP_OS === "linux") return <LinuxControls className={className} />;
  return null;
}

// ─── macOS ───────────────────────────────────────────────────────────────────────────────────────

/** Quanto os semáforos nativos (60×14) passam do lugar reservado (52×12) de cada lado. */
const NATIVE_DX = 4;
const NATIVE_DY = 1;

/** Los lugares montados; el que está a la vista (con tamaño) manda. */
const slots = new Set<HTMLElement>();
let frame = 0;
let sent = "";

/** Le dice al backend dónde van los semáforos (o que se escondan si no hay lugar a la vista). */
function placeLights() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const shown = [...slots].map((el) => el.getBoundingClientRect()).find((r) => r.width > 0 && r.height > 0);
    // Os nativos (macOS 27) ocupam 60×14; o lugar reservado tem 52×12: centraliza neles.
    const place = shown ? { x: Math.round(shown.left - NATIVE_DX), y: Math.round(shown.top - NATIVE_DY), visible: true } : { x: 0, y: 0, visible: false };
    const key = JSON.stringify(place);
    if (key === sent) return;
    sent = key;
    invoke("window_controls_place", place).catch(() => { sent = ""; });
  });
}

if (DESKTOP_OS === "macos" && typeof window !== "undefined") window.addEventListener("resize", placeLights);

function MacLightsSlot() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    slots.add(el);
    placeLights();
    // Mudar de tamanho inclui sumir (`display: none` no modo chat) e voltar.
    const observer = new ResizeObserver(placeLights);
    observer.observe(el);
    return () => {
      observer.disconnect();
      slots.delete(el);
      placeLights();
    };
  }, []);
  return <span ref={ref} aria-hidden="true" data-window-lights="" className="block shrink-0 w-[52px] h-3" />;
}

// ─── Windows e Linux ─────────────────────────────────────────────────────────────────────────────

function useWindowActions() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => { win.isMaximized().then(setMaximized).catch(() => {}); });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, [win]);
  const act = useCallback((key: "close" | "minimize" | "maximize") => {
    // Cerrar guarda todo antes (con la alerta de progreso) y después cierra por el camino de siempre.
    if (key === "close") closeWindowWithSave("button").catch(console.error);
    else if (key === "minimize") win.minimize().catch(console.error);
    else win.toggleMaximize().catch(console.error);
  }, [win]);
  return { maximized, act };
}

function useLabels(maximized: boolean) {
  const { t } = useTranslation();
  return { close: t("window.close"), minimize: t("window.minimize"), maximize: maximized ? t("window.restore") : t("window.maximize") };
}

const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;

/** Windows 11: 46 px de ancho, la altura del encabezado, cerrar en rojo al pasar. */
function WindowsControls({ className }: { className: string }) {
  const { maximized, act } = useWindowActions();
  const label = useLabels(maximized);
  const base = "w-[46px] self-stretch flex items-center justify-center text-gray-700 dark:text-white/80";
  return (
    <div data-tauri-drag-region="false" className={`flex shrink-0 self-stretch ${className}`}>
      <button type="button" onClick={() => act("minimize")} title={label.minimize} aria-label={label.minimize}
        className={`${base} hover:bg-black/[0.06] dark:hover:bg-white/[0.08]`}>
        <svg {...glyph}><path d="M0 5.5h10" /></svg>
      </button>
      <button type="button" onClick={() => act("maximize")} title={label.maximize} aria-label={label.maximize}
        className={`${base} hover:bg-black/[0.06] dark:hover:bg-white/[0.08]`}>
        {maximized
          ? <svg {...glyph}><path d="M2.5 2.5V.5h7v7h-2" /><rect x=".5" y="2.5" width="7" height="7" /></svg>
          : <svg {...glyph}><rect x=".5" y=".5" width="9" height="9" /></svg>}
      </button>
      <button type="button" onClick={() => act("close")} title={label.close} aria-label={label.close}
        className={`${base} hover:bg-red-600 hover:text-white`}>
        <svg {...glyph}><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
      </button>
    </div>
  );
}

/** GNOME (Adwaita): botones redondos de 24 px a la derecha, minimizar · maximizar · cerrar. */
function LinuxControls({ className }: { className: string }) {
  const { maximized, act } = useWindowActions();
  const label = useLabels(maximized);
  const base = "w-6 h-6 rounded-full flex items-center justify-center bg-black/[0.07] dark:bg-white/[0.1] text-gray-800 dark:text-white/85 hover:bg-black/[0.13] dark:hover:bg-white/[0.17]";
  return (
    <div data-tauri-drag-region="false" className={`flex shrink-0 items-center gap-3 px-2.5 ${className}`}>
      <button type="button" onClick={() => act("minimize")} title={label.minimize} aria-label={label.minimize} className={base}>
        <svg {...glyph} strokeWidth={1.5}><path d="M2 7.5h6" /></svg>
      </button>
      <button type="button" onClick={() => act("maximize")} title={label.maximize} aria-label={label.maximize} className={base}>
        {maximized
          ? <svg {...glyph} strokeWidth={1.5}><rect x="2.5" y="2.5" width="5" height="5" /></svg>
          : <svg {...glyph} strokeWidth={1.5}><rect x="2" y="2" width="6" height="6" /></svg>}
      </button>
      <button type="button" onClick={() => act("close")} title={label.close} aria-label={label.close} className={base}>
        <svg {...glyph} strokeWidth={1.5}><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg>
      </button>
    </div>
  );
}
