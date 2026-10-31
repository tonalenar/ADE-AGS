import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { toDevicePoint } from "@/features/canvas/DeviceNode";
import { AlertaToast } from "@/shared/ui/alerts";
import { phoneOf, DEFAULT_SCREEN, type SimScreen } from "@/features/simulator/geometry";
import { simulatorBoot } from "@/features/simulator/ipc";
import { useSimulatorPrefs } from "@/features/simulator/prefs";
import { SimulatorScreen } from "@/features/simulator/SimulatorScreen";
import { refreshDevices, setDeviceState, useSimulatorStore } from "@/features/simulator/store";

/**
 * A aba "Dispositivos" do painel direito (pranchetas 9 e 10): o simulador iOS e o Android ao lado da
 * conversa, os mesmos do canvas. O iOS é a tela nativa (`SimulatorScreen`, sem copiar quadros); o
 * Android, quadros do `adb` com toque e deslizar, como no nó do canvas. Os agentes seguem pilotando
 * os dois pela CLI (`ags sim …`, `ags device …`).
 */
export function DevicesPane() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"ios" | "android">("ios");
  return (
    <div className="h-full flex flex-col">
      <div role="tablist" aria-label={t("chat.panel.devices")} className="shrink-0 flex items-center gap-1 px-3 h-10 border-b border-gray-200 dark:border-white/[0.08]">
        {(["ios", "android"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={`h-6 px-2.5 rounded-md text-[12px] font-medium
              ${kind === k ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/45 hover:bg-gray-100/60 dark:hover:bg-white/[0.06]"}`}>
            {t(`chat.devices.${k}`)}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">{kind === "ios" ? <IosDevice /> : <AndroidDevice />}</div>
    </div>
  );
}

/** O tamanho de um elemento, acompanhado. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/** A escala que faz o aparelho (com a moldura) caber na caixa. Pura. */
export function fitScale(screen: SimScreen, box: { w: number; h: number }): number {
  const unit = phoneOf(screen, 1);
  if (box.w <= 0 || box.h <= 0) return 0;
  return Math.min(box.w / unit.w, box.h / unit.h, 1.2);
}

function IosDevice() {
  const { t } = useTranslation();
  const devices = useSimulatorStore((s) => s.devices);
  const loaded = useSimulatorStore((s) => s.loaded);
  const error = useSimulatorStore((s) => s.error);
  const light = useSimulatorPrefs((s) => s.light);
  const [udid, setUdid] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const { ref, size } = useBoxSize();
  useEffect(() => { void refreshDevices(); }, []);

  const current = devices.find((d) => d.udid === udid) ?? devices.find((d) => d.state === "booted") ?? devices[0] ?? null;
  const screen: SimScreen = current && current.width > 0 ? { width: current.width, height: current.height, family: current.family } : DEFAULT_SCREEN;
  const phone = phoneOf(screen, fitScale(screen, { w: size.w - 32, h: size.h - 32 }));
  const booted = current?.state === "booted";
  const fail = (e: unknown) => AlertaToast(current?.name ?? t("chat.devices.ios"), String(e), "error", 5000);

  const boot = async () => {
    if (!current) return;
    setBooting(true);
    try {
      await simulatorBoot(current.udid, light);
      setDeviceState(current.udid, "booted");
    } catch (e) {
      fail(e);
    } finally {
      setBooting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2">
        <select value={current?.udid ?? ""} onChange={(e) => setUdid(e.target.value || null)} aria-label={t("simulator.pick")}
          className="flex-1 min-w-0 h-7 px-2 rounded-md text-[12.5px] bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white">
          {devices.length === 0 && <option value="">{loaded ? t("chat.devices.noIos") : t("chat.panel.loading")}</option>}
          {devices.map((d) => <option key={d.udid} value={d.udid}>{d.name} · {d.runtime}</option>)}
        </select>
      </div>
      <div ref={ref} className="flex-1 min-h-0 flex items-center justify-center p-4">
        {error ? <p className="text-[13px] text-gray-500 dark:text-white/45">{error}</p> : current && phone.w > 0 && (
          <div className="relative shrink-0 bg-gradient-to-br from-surface-overlay via-surface to-surface-raised"
            style={{ width: phone.w, height: phone.h, borderRadius: phone.outerRadius, padding: phone.bezel, boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 20px 50px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(0,0,0,0.9)" }}>
            <div className="relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: phone.screenRadius }}>
              {booted && !booting ? (
                <SimulatorScreen screenId="chat-devices" udid={current.udid} radius={phone.screenRadius} onError={fail} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                  <span className="text-[13px] font-semibold text-white">{current.name}</span>
                  <span className="text-[11.5px] leading-snug text-gray-400">{booting ? t("simulator.booting") : `${current.runtime} · ${t("simulator.offHint")}`}</span>
                  {!booting && (
                    <button type="button" onClick={() => void boot()}
                      className="h-8 rounded-lg bg-accent-600 px-4 text-[12.5px] font-medium text-white hover:bg-accent-500">{t("simulator.boot")}</button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AndroidList { devices: { serial: string; state: string; model: string }[]; avds: string[]; adb: boolean }
interface Frame { png: string; width: number; height: number }

/** Os mesmos ritmos do nó do canvas: `screencap` demora, e um emulador demora a aparecer. */
const FRAME_EVERY_MS = 700;
const LIST_EVERY_MS = 4000;
const SWIPE_PX = 12;

function AndroidDevice() {
  const { t } = useTranslation();
  const [list, setList] = useState<AndroidList | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => invoke<AndroidList>("android_list").then((l) => alive && setList(l)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, LIST_EVERY_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const ready = (list?.devices ?? []).filter((d) => d.state === "device");
  const chosen = serial && ready.some((d) => d.serial === serial) ? serial : ready[0]?.serial ?? null;

  useEffect(() => {
    if (!chosen) { setFrame(null); return; }
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const f = await invoke<Frame>("android_frame", { serial: chosen });
          if (alive) { setFrame(f); setProblem(null); }
        } catch (e) {
          if (alive) setProblem(String(e));
        }
      }
      if (alive) timer = window.setTimeout(tick, FRAME_EVERY_MS);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [chosen]);

  const fail = (e: unknown) => AlertaToast(t("chat.devices.android"), String(e), "error", 5000);
  const point = (e: React.PointerEvent) => {
    const el = img.current;
    if (!el || !frame) return null;
    const r = el.getBoundingClientRect();
    return toDevicePoint({ left: r.left, top: r.top, width: r.width, height: r.height }, frame, e.clientX, e.clientY);
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
  const press = (keyName: string) => { if (chosen) invoke("android_key", { serial: chosen, keyName }).catch(fail); };
  const startAvd = (name: string) => { invoke("android_start_avd", { name }).catch(fail); };

  const small = "h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/[0.08] disabled:opacity-40";
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2">
        <select value={chosen ?? ""} onChange={(e) => setSerial(e.target.value || null)} aria-label={t("canvas.device.pick")}
          className="flex-1 min-w-0 h-7 px-2 rounded-md text-[12.5px] bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white">
          {ready.length === 0 && <option value="">{t("canvas.device.none")}</option>}
          {ready.map((d) => <option key={d.serial} value={d.serial}>{d.model || d.serial}</option>)}
        </select>
        {(list?.avds.length ?? 0) > 0 && (
          <select value="" onChange={(e) => e.target.value && startAvd(e.target.value)} aria-label={t("canvas.device.start")}
            className="h-7 px-2 rounded-md text-[12.5px] bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white">
            <option value="">▶ {t("canvas.device.emulator")}</option>
            {list?.avds.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4">
        {frame && chosen ? (
          <img ref={img} alt="" draggable={false} src={`data:image/png;base64,${frame.png}`}
            onPointerDown={(e) => { down.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={onUp}
            className="max-h-full max-w-full object-contain rounded-[18px] shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_20px_50px_rgba(0,0,0,0.35)] select-none cursor-pointer" />
        ) : (
          <p className="max-w-[260px] text-center text-[13px] leading-snug text-gray-500 dark:text-white/45">
            {list && !list.adb ? t("canvas.device.noAdb") : problem ?? t("canvas.device.empty")}
          </p>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-center gap-1 pb-3">
        <button type="button" className={small} disabled={!chosen} onClick={() => press("back")} title={t("canvas.device.back")}>◀</button>
        <button type="button" className={small} disabled={!chosen} onClick={() => press("home")} title={t("canvas.device.home")}>●</button>
        <button type="button" className={small} disabled={!chosen} onClick={() => press("recents")} title={t("canvas.device.recents")}>▢</button>
      </div>
    </div>
  );
}
