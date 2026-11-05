import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { KeyboardIcon } from "@/features/chat/chatIcons";
import { setDeviceControl, setPanelDevice, useChatStore } from "@/features/chat/store";
import { usePopover } from "@/features/chat/usePopover";
import { ChatSwitch } from "@/features/settings/SettingsSection";
import { AlertaToast } from "@/shared/ui/alerts";

import { ConnectHint } from "./ConnectHint";
import { DeviceBar } from "./DeviceBar";
import { DeviceFrame, screenRadiusOf } from "./DeviceFrame";
import { iphoneType } from "./ipc";
import { canTouch, fitScale, frameLayout, isReady, physicalScreen, stepZoom } from "./model";
import { MirrorStatusLine, PhysicalMirror, TransportBadge } from "./PhysicalParts";
import { refreshPhysical, useIphoneStore, useMirrorStatus, usePhysicalDevices } from "./store";

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

const ibCls = "w-8 h-8 inline-flex items-center justify-center rounded-lg text-[12px] font-medium text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:pointer-events-none";
const fieldCls = "h-8 min-w-0 px-2.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-chat-note text-gray-900 dark:text-white outline-none focus:border-accent-500";

/** Digitar no aparelho por um campo (o teclado do Mac também digita direto com a tela em foco). */
function KeyboardButton({ device, name, ready }: { device: string; name: string; ready: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [text, setText] = useState("");
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={t("iphone.keyboard")} title={t("iphone.keyboard")} aria-expanded={open} disabled={!ready}
        onClick={() => setOpen(!open)} className={`${ibCls} ${open ? "bg-gray-100 dark:bg-white/[0.06] text-gray-900 dark:text-white" : ""}`}>
        <KeyboardIcon className="w-[17px] h-[17px]" />
      </button>
      {open && (
        <form role="dialog" aria-label={t("iphone.keyboard")}
          className="absolute z-50 right-full top-0 mr-2 w-[280px] flex flex-col gap-2 rounded-xl p-2 text-chat-note bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (text) iphoneType(device, text).then(() => { setText(""); setOpen(false); }).catch((err) => { void AlertaToast(name, String(err), "error", 5000); });
          }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.devices.typePlaceholder")} aria-label={t("chat.devices.typePlaceholder")} className={fieldCls} />
          <p className="m-0 text-chat-caption text-gray-500 dark:text-white/50">{t("iphone.keyboardHint")}</p>
          <button type="submit" disabled={!text} className="self-end h-8 px-3 rounded-lg bg-accent-600 text-white text-chat-note font-medium disabled:opacity-40">{t("chat.devices.type")}</button>
        </form>
      )}
    </div>
  );
}

/**
 * O aparelho físico no painel direito do modo chat: o seletor (o mesmo do simulador, que vem pronto em `picker`) e a
 * linha de estado; no meio, a moldura do modelo com os botões da lateral funcionando, a tela espelhada (clique e
 * arraste tocam, a rolagem com dois dedos rola, a pinça amplia; com a tela em foco, o teclado digita) e a pílula com
 * início, alternador de apps, foto e o "⋯"; à direita, teclado e zoom. O aparelho vai para os agentes como o
 * simulador: só com a chave, e cada ação deles pergunta à pessoa até ela dizer "sempre neste aparelho".
 */
export function PhysicalPane({ device, picker }: { device: string; picker: ReactNode }) {
  const { t } = useTranslation();
  const devices = useIphoneStore((s) => s.devices);
  const loaded = useIphoneStore((s) => s.loaded);
  const status = useMirrorStatus(device);
  const control = useChatStore((s) => s.deviceControl);
  const current = devices.find((d) => d.id === device);
  const anyReady = devices.some(isReady);
  // Sem o aparelho escolhido por perto, a lista fica em dia para o estado vazio.
  usePhysicalDevices(loaded && !current);
  useEffect(() => { void refreshPhysical(); }, []);
  const name = current?.name ?? t("iphone.section.devices");
  useEffect(() => { setPanelDevice("ios", device, current?.name ?? null); }, [device, current?.name]);
  const { ref, size } = useBoxSize();
  const fail = useCallback((e: unknown) => { void AlertaToast(name, String(e), "error", 5000); }, [name]);
  const ready = canTouch(status);
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const family = current?.family ?? "iphone";
  const points = physicalScreen(status?.display ?? null, family);
  const layout = frameLayout(current?.model ?? "", family);
  // A pílula e o respiro em volta ficam fora do espaço do aparelho.
  const box = { w: size.w - 48, h: size.h - 96 };
  const fit = fitScale(points, box, layout.bezel);
  const scale = zoom === "fit" ? fit : zoom;
  const screen = { width: Math.round(points.width * scale), height: Math.round(points.height * scale) };
  const missing = loaded && !current;

  return (
    <div className="h-full flex flex-col">
      <div className="@container shrink-0 border-b border-gray-200 dark:border-white/[0.08]">
        <div className="h-12 flex items-center gap-2 px-3 text-chat-note whitespace-nowrap">
          {picker}
          {!missing && <MirrorStatusLine status={status} className="text-gray-600 dark:text-white/60" />}
          <span className="flex-1" />
          {current && <span className="hidden @[30rem]:inline-flex"><TransportBadge transport={current.transport} tone="panel" /></span>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex bg-gray-100 dark:bg-white/[0.02]">
        <div ref={ref} className="flex-1 min-w-0 overflow-auto cc-scroll">
          {missing && !anyReady ? (
            <div className="flex h-full items-center justify-center p-5"><ConnectHint tone="panel" /></div>
          ) : size.w > 0 && (
            <div className="flex min-h-full min-w-full w-max flex-col items-center justify-center gap-4 px-6 py-5">
              <DeviceFrame device={device} name={name} layout={layout} screen={screen} enabled={ready}>
                <PhysicalMirror screenId="chat-devices-physical" device={device} known={!missing} status={status} radius={screenRadiusOf(layout, screen.width)} onError={fail} />
              </DeviceFrame>
              <DeviceBar device={device} name={name} status={status} ready={ready} />
            </div>
          )}
        </div>

        <nav aria-label={t("iphone.controls")} className="w-[52px] shrink-0 flex flex-col items-center gap-1 py-3 border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep">
          <KeyboardButton device={device} name={name} ready={ready} />
          <span aria-hidden="true" className="w-5 h-px my-1 bg-gray-200 dark:bg-white/[0.08]" />
          <button type="button" className={ibCls} title={t("iphone.zoom.in")} aria-label={t("iphone.zoom.in")} onClick={() => setZoom(stepZoom(scale, 1))}>+</button>
          <button type="button" className={ibCls} title={t("iphone.zoom.out")} aria-label={t("iphone.zoom.out")} onClick={() => setZoom(stepZoom(scale, -1))}>−</button>
          <button type="button" className={`${ibCls} ${zoom === "fit" ? "bg-gray-100 dark:bg-white/[0.06] text-gray-900 dark:text-white" : ""}`} aria-pressed={zoom === "fit"}
            title={t("iphone.zoom.fit")} aria-label={t("iphone.zoom.fit")} onClick={() => setZoom("fit")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="w-[16px] h-[16px]" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
          <button type="button" className={`${ibCls} ${zoom === 1 ? "bg-gray-100 dark:bg-white/[0.06] text-gray-900 dark:text-white" : ""}`} aria-pressed={zoom === 1}
            title={t("iphone.zoom.actual")} aria-label={t("iphone.zoom.actual")} onClick={() => setZoom(1)}>1:1</button>
          <span className="flex-1" />
          <span className="text-[10.5px] tabular-nums text-gray-400 dark:text-white/40">{Math.round(scale * 100)}%</span>
        </nav>
      </div>

      <div className="shrink-0 flex items-center gap-3 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-note">
        <div className="flex-1 min-w-0">
          <b className="font-medium text-gray-900 dark:text-white">{t("chat.devices.agentControl")}</b>
          <div className="text-chat-caption text-gray-500 dark:text-white/50">
            {t("iphone.agentHint.before")}<span className="font-mono">ags device</span>{t("iphone.agentHint.after")}
          </div>
        </div>
        <ChatSwitch label={t("chat.devices.agentControl")} checked={control} onChange={setDeviceControl} />
      </div>
    </div>
  );
}
