import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { shouldProbeDevices } from "@/features/chat/deviceDemand";
import { setDeviceControl, setPanelDevice, useChatStore } from "@/features/chat/store";
import { ChatSwitch } from "@/features/settings/SettingsSection";
import { AlertaToast } from "@/shared/ui/alerts";

import { ConnectHint } from "./ConnectHint";
import { DeviceBar } from "./DeviceBar";
import { DeviceFrame, screenRadiusOf } from "./DeviceFrame";
import { iphoneMirrorConnect, iphoneMirrorDisconnect } from "./ipc";
import { canTouch, fitScale, frameLayout, isReady, physicalScreen, statusView } from "./model";
import { PhysicalMirror } from "./PhysicalParts";
import { RevokeTrust } from "./RevokeTrust";
import { refreshPhysical, setMirrorDisconnected, useIphoneStore, useMirrorStatus, usePhysicalDevices } from "./store";

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

/**
 * O aparelho físico no painel direito do modo chat: o seletor (o mesmo do simulador, que vem pronto em `picker`) e a
 * barra única com estado, sessão, busca, ações, teclado, zoom e menu; no centro, a moldura e a tela espelhada (clique
 * e arraste tocam, a rolagem com dois dedos rola, a pinça amplia; com a tela em foco, o teclado digita). O aparelho vai para os agentes como o
 * simulador: só com a chave; ações que mudam o aparelho pedem confirmação até a pessoa autorizar sempre.
 */
export function PhysicalPane({ device, picker, composerTarget }: { device: string; picker: ReactNode; composerTarget?: string | null }) {
  const { t } = useTranslation();
  const devices = useIphoneStore((s) => s.devices);
  const loaded = useIphoneStore((s) => s.loaded);
  const disconnected = useIphoneStore((s) => s.disconnectedDevices.includes(device));
  const probe = shouldProbeDevices(true, DESKTOP_OS, "ios-physical");
  const status = useMirrorStatus(probe ? device : null);
  const control = useChatStore((s) => s.deviceControl);
  const current = devices.find((d) => d.id === device);
  const anyReady = devices.some(isReady);
  // Sem o aparelho escolhido por perto, a lista fica em dia para o estado vazio. Fora do macOS não há busca.
  usePhysicalDevices(probe && loaded && !current);
  useEffect(() => {
    if (!probe) {
      useIphoneStore.setState({ loaded: true, unavailable: "platform" });
      return;
    }
    void refreshPhysical();
  }, [probe]);
  const name = current?.name ?? t("iphone.section.devices");
  useEffect(() => { setPanelDevice("ios", device, current?.name ?? null); }, [device, current?.name]);
  const { ref, size } = useBoxSize();
  const paneRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const fail = useCallback((e: unknown) => { void AlertaToast(name, String(e), "error", 5000); }, [name]);
  const ready = !disconnected && canTouch(status);
  const view = statusView(status);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [searching, setSearching] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === paneRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const searchDevices = async () => {
    setSearching(true);
    try {
      await refreshPhysical(true);
    } catch (e) {
      fail(e);
    } finally {
      setSearching(false);
    }
  };

  const toggleSession = async () => {
    setSessionBusy(true);
    try {
      if (disconnected) {
        await iphoneMirrorConnect(device);
        setMirrorDisconnected(device, false);
      } else {
        await iphoneMirrorDisconnect(device);
        setMirrorDisconnected(device, true);
      }
    } catch (e) {
      fail(e);
    } finally {
      setSessionBusy(false);
    }
  };
  const toggleFullscreen = () => {
    const pane = paneRef.current;
    if (!pane) return;
    if (document.fullscreenElement === pane) void document.exitFullscreen().catch(fail);
    else void pane.requestFullscreen().catch(fail);
  };

  const family = current?.family ?? "iphone";
  const points = physicalScreen(status?.display ?? null, family);
  const layout = frameLayout(current?.model ?? "", family);
  // O respiro em volta fica fora do espaço do aparelho (a coluna de controles já está fora da área medida).
  const box = { w: size.w - 48, h: size.h - 40 };
  const fit = fitScale(points, box, layout.bezel);
  const scale = zoom === "fit" ? fit : zoom;
  const screen = { width: Math.round(points.width * scale), height: Math.round(points.height * scale) };
  const missing = loaded && !current;
  return (
    <div ref={paneRef} className="h-full flex flex-col bg-white dark:bg-surface-deep">
      <div className="@container shrink-0 border-b border-gray-200 dark:border-white/[0.08]">
        <div className="h-12 flex items-center gap-2 px-3 text-chat-note whitespace-nowrap">
          <div className="min-w-0 flex-1">{picker}</div>
          {current && (
            <span aria-hidden="true" className="hidden @[26rem]:inline-flex shrink-0 items-center gap-1.5 text-chat-caption text-gray-500 dark:text-white/50">
              <span className={`h-2 w-2 rounded-full ${disconnected ? "bg-gray-400 dark:bg-white/35" : view.tone === "ok" ? "bg-emerald-500 dark:bg-emerald-400" : view.tone === "wait" ? "bg-amber-400" : "bg-gray-400 dark:bg-white/35"}`} />
              {disconnected ? t("iphone.status.paused") : t(view.key)}
              {!disconnected && status?.state === "live" && status.fps != null ? ` · ${t("iphone.status.fps", { count: status.fps })}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex bg-gray-100 dark:bg-white/[0.02]">
        <div ref={ref} className="flex-1 min-w-0 overflow-auto cc-scroll">
          {missing && !anyReady ? (
            <div className="flex h-full items-center justify-center p-5"><ConnectHint tone="panel" /></div>
          ) : size.w > 0 && (
            <div className="flex min-h-full min-w-full w-max flex-col items-center justify-center gap-4 px-6 py-5">
              <DeviceFrame device={device} name={name} layout={layout} screen={screen} enabled={ready}>
                <PhysicalMirror screenId="chat-devices-physical" device={device} known={!missing} status={status} radius={screenRadiusOf(layout, screen.width)} onError={fail} engaged={probe} showStatus={false} />
              </DeviceFrame>
            </div>
          )}
        </div>
        <DeviceBar device={device} name={name} status={status} ready={ready} disconnected={disconnected} composerTarget={composerTarget}
            zoom={zoom} onZoom={setZoom} onRefresh={() => { void searchDevices(); }} refreshing={searching}
            onSession={() => { void toggleSession(); }} sessionBusy={sessionBusy} fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
      </div>

      <div className="shrink-0 flex items-center gap-3 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-note">
        <div className="flex-1 min-w-0">
          <b className="font-medium text-gray-900 dark:text-white">{t("chat.devices.agentControl")}</b>
          <div className="text-chat-caption text-gray-500 dark:text-white/50">
            {t("iphone.agentHint.before")}<span className="font-mono">ags device</span>{t("iphone.agentHint.after")}
          </div>
          <RevokeTrust />
        </div>
        <ChatSwitch label={t("chat.devices.agentControl")} checked={control} onChange={setDeviceControl} />
      </div>
    </div>
  );
}
