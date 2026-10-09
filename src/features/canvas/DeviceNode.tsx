import { PopupSelect } from "@/shared/ui/PopupSelect";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { NodeResizer, Position } from "@xyflow/react";
import { CordPort } from "./cords";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

import { PHONE_MIN, type CanvasPortal } from "./board";
import { NOTE_HEADER_H } from "./geometry";
import { canvasActions, useActiveBoardKey } from "./store";

interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
}

interface AndroidList {
  devices: AndroidDevice[];
  avds: string[];
  adb: boolean;
}

interface Frame {
  png: string;
  width: number;
  height: number;
}

/** Cada cuánto se vuelve a pedir la pantalla: `screencap` tarda, no tiene sentido pedir más rápido. */
const FRAME_EVERY_MS = 700;
/** Cada cuánto se vuelve a mirar qué dispositivos hay. */
const LIST_EVERY_MS = 4000;
/** Lo que hay que moverse para que un gesto sea un deslizamiento y no un toque. */
const SWIPE_PX = 12;

/**
 * Dónde cae un punto de la imagen mostrada (`object-contain`, con franjas a los lados) en la
 * pantalla real del dispositivo. `null` = cayó en una franja, fuera de la pantalla. Pura, para
 * probarla.
 */
export function toDevicePoint(
  box: { left: number; top: number; width: number; height: number },
  device: { width: number; height: number },
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || device.width <= 0 || device.height <= 0) return null;
  const scale = Math.min(box.width / device.width, box.height / device.height);
  const drawnW = device.width * scale;
  const drawnH = device.height * scale;
  const offsetX = box.left + (box.width - drawnW) / 2;
  const offsetY = box.top + (box.height - drawnH) / 2;
  const px = (x - offsetX) / scale;
  const py = (y - offsetY) / scale;
  if (px < 0 || py < 0 || px > device.width || py > device.height) return null;
  return { x: Math.round(px), y: Math.round(py) };
}

/**
 * La pantalla de un Android (emulador o teléfono por USB) como nodo del canvas. Un clic es un
 * toque, arrastrar es deslizar; abajo, los botones de sistema y un campo para escribir.
 * Los agentes conectados lo manejan con `ags device …`.
 *
 * Todo va por `adb` desde el backend (ver `android.rs`): acá solo se pide un cuadro cada tanto
 * y se mandan los gestos.
 */
export const DeviceNode = memo(function DeviceNode({ id, portal, links, selected }: {
  id: string;
  portal: CanvasPortal;
  links: number;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const [armed, setArmed] = useState(false);
  const [list, setList] = useState<AndroidList | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typing, setTyping] = useState("");
  const [starting, setStarting] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-emerald-400! dark:bg-emerald-500!";

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  // Qué hay conectado: se mira cada pocos segundos (un emulador tarda en aparecer).
  useEffect(() => {
    let alive = true;
    const load = () => invoke<AndroidList>("android_list").then((l) => alive && setList(l)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, LIST_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // El dispositivo que se ve: el elegido si está listo, o el único que haya.
  const ready = (list?.devices ?? []).filter((d) => d.state === "device");
  const chosen = portal.serial && ready.some((d) => d.serial === portal.serial)
    ? portal.serial
    : ready.length === 1 ? ready[0].serial : null;

  // Un cuadro tras otro, sin superponer pedidos y sin gastar nada con la ventana oculta.
  useEffect(() => {
    if (!chosen) {
      setFrame(null);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const f = await invoke<Frame>("android_frame", { serial: chosen });
          if (alive) {
            setFrame(f);
            setProblem(null);
          }
        } catch (e) {
          if (alive) setProblem(String(e));
        }
      }
      if (alive) timer = window.setTimeout(tick, FRAME_EVERY_MS);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [chosen]);

  const fail = (e: unknown) => AlertaToast(portal.name, String(e), "error", 5000);

  const startAvd = async (avd: string) => {
    setStarting(true);
    canvasActions.updatePortal(key ?? "", id, { avd });
    try {
      await invoke("android_start_avd", { name: avd });
    } catch (e) {
      fail(e);
    } finally {
      // El emulador tarda en aparecer: el aviso de "iniciando" se apaga solo cuando hay dispositivo.
      window.setTimeout(() => setStarting(false), 20000);
    }
  };
  useEffect(() => {
    if (ready.length > 0) setStarting(false);
  }, [ready.length]);

  const point = (e: React.PointerEvent) => {
    const el = img.current;
    if (!el || !frame) return null;
    const r = el.getBoundingClientRect();
    return toDevicePoint({ left: r.left, top: r.top, width: r.width, height: r.height }, frame, e.clientX, e.clientY);
  };

  const onDown = (e: React.PointerEvent) => {
    down.current = point(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onUp = (e: React.PointerEvent) => {
    const from = down.current;
    down.current = null;
    const to = point(e);
    if (!chosen || !from || !to) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) > SWIPE_PX * (frame ? frame.width / 360 : 1)) {
      invoke("android_swipe", { serial: chosen, x1: from.x, y1: from.y, x2: to.x, y2: to.y }).catch(fail);
    } else {
      invoke("android_tap", { serial: chosen, x: to.x, y: to.y }).catch(fail);
    }
  };

  const press = useCallback(
    (keyName: string) => chosen && invoke("android_key", { serial: chosen, keyName }).catch(fail),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen],
  );

  const send = () => {
    const text = typing;
    if (!text || !chosen) return;
    setTyping("");
    invoke("android_text", { serial: chosen, text }).catch((e) => {
      setTyping(text);
      fail(e);
    });
  };

  const small = `cc-t nodrag shrink-0 h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-gray-300
    hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-40`;

  return (
    <div
      className={`h-full w-full flex flex-col rounded-lg overflow-hidden border bg-white dark:bg-surface
        ${selected
          ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]"
          : "border-emerald-300/80 dark:border-emerald-200/20"}`}
    >
      <NodeResizer isVisible={selected} minWidth={PHONE_MIN.w} minHeight={PHONE_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2! h-2! rounded-[3px]! bg-white! dark:bg-surface! border-[1.5px]! border-accent-500! shadow-sm!" />
      <CordPort id="l" type="source" position={Position.Left} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} className={handle} />
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />

      <div
        className="ade-node-drag flex items-center gap-2 pl-3 pr-1.5 shrink-0 cursor-grab active:cursor-grabbing
          border-b border-emerald-200 dark:border-emerald-100/10 bg-emerald-50 dark:bg-emerald-100/5"
        style={{ height: NOTE_HEADER_H }}
      >
        <PhoneIcon className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-300/80" />
        <input
          value={portal.name}
          onChange={(e) => key && canvasActions.updatePortal(key, id, { name: e.target.value })}
          aria-label={t("canvas.device.name")}
          spellCheck={false}
          className="nodrag min-w-0 flex-1 bg-transparent outline-none text-[12.5px] font-medium
            text-gray-800 dark:text-gray-100 focus:bg-white/60 dark:focus:bg-white/5 rounded px-1 -mx-1"
        />
        {links > 0 && (
          <span className="shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full
            bg-emerald-200/70 dark:bg-white/8 text-emerald-800 dark:text-gray-400" title={t("canvas.links", { count: links })}>
            ⇄ {links}
          </span>
        )}
        <Button variant="custom"
          onClick={() => {
            if (!key) return;
            if (armed) canvasActions.removePortal(key, id);
            else setArmed(true);
          }}
          title={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          aria-label={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          className={`nodrag cc-t shrink-0 flex items-center justify-center h-6 rounded-md
            ${armed
              ? "px-2 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
              : "w-6 text-gray-400 hover:text-red-500 hover:bg-emerald-200/60 dark:hover:bg-white/8"}`}
        >
          {armed ? t("canvas.portalDeleteConfirm") : <CloseIcon className="w-3 h-3" />}
        </Button>
      </div>

      {/* Qué dispositivo, y cómo arrancar un emulador. */}
      <div className="nodrag flex items-center gap-1.5 px-2 py-1 shrink-0 border-b border-gray-100 dark:border-white/6">
        <PopupSelect
          value={chosen ?? ""}
          onChange={(e) => key && canvasActions.updatePortal(key, id, { serial: e.target.value || undefined })}
          aria-label={t("canvas.device.pick")}
          className="min-w-0 flex-1"
        >
          <option value="">{ready.length === 0 ? t("canvas.device.none") : t("canvas.device.choose")}</option>
          {ready.map((d) => <option key={d.serial} value={d.serial}>{d.model || d.serial} · {d.serial}</option>)}
        </PopupSelect>
        {(list?.avds.length ?? 0) > 0 && (
          <PopupSelect
            value=""
            disabled={starting}
            onChange={(e) => e.target.value && void startAvd(e.target.value)}
            aria-label={t("canvas.device.start")}
            title={t("canvas.device.start")}
            className="shrink-0 w-20"
          >
            <option value="">{starting ? "…" : `▶ ${t("canvas.device.emulator")}`}</option>
            {list?.avds.map((a) => <option key={a} value={a}>{a}</option>)}
          </PopupSelect>
        )}
      </div>

      {/* La pantalla. `nowheel nopan`: dentro de ella, arrastrar es deslizar y no mover el canvas. */}
      <div className="nodrag nowheel nopan relative flex-1 min-h-0 bg-black flex items-center justify-center">
        {frame && chosen ? (
          <img
            ref={img}
            src={`data:image/png;base64,${frame.png}`}
            alt={portal.name}
            draggable={false}
            onPointerDown={onDown}
            onPointerUp={onUp}
            className="max-w-full max-h-full object-contain select-none cursor-pointer touch-none"
          />
        ) : (
          <p className="px-4 text-center text-[11.5px] leading-relaxed text-gray-400">
            {list && !list.adb
              ? t("canvas.device.noAdb")
              : problem ?? (ready.length === 0 ? t("canvas.device.empty") : t("canvas.device.choose"))}
          </p>
        )}
      </div>

      <div className="nodrag flex items-center gap-1 px-2 py-1 shrink-0 border-t border-gray-100 dark:border-white/6">
        <Button variant="custom" className={small} disabled={!chosen} onClick={() => press("back")} title={t("canvas.device.back")}>◀</Button>
        <Button variant="custom" className={small} disabled={!chosen} onClick={() => press("home")} title={t("canvas.device.home")}>●</Button>
        <Button variant="custom" className={small} disabled={!chosen} onClick={() => press("recents")} title={t("canvas.device.recents")}>▢</Button>
        <input
          value={typing}
          disabled={!chosen}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("canvas.device.type")}
          aria-label={t("canvas.device.type")}
          spellCheck={false}
          className="min-w-0 flex-1 h-6 rounded-md px-2 text-[11.5px] outline-none bg-gray-50 dark:bg-white/5
            border border-gray-200 dark:border-white/10 focus:border-accent-400 text-gray-800 dark:text-gray-100 disabled:opacity-40"
        />
        <Button variant="custom" className={small} disabled={!chosen} onClick={() => press("enter")} title="Enter">↵</Button>
      </div>
    </div>
  );
});

export function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </svg>
  );
}
