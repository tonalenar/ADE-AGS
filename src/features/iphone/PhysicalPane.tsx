import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { HomeIcon, MoreHorizontalIcon } from "@/features/chat/chatIcons";
import { deviceFrame } from "@/features/chat/devicesModel";
import { setDeviceControl, setPanelDevice, useChatStore } from "@/features/chat/store";
import { usePopover } from "@/features/chat/usePopover";
import { ChatSwitch } from "@/features/settings/SettingsSection";
import { AlertaToast } from "@/shared/ui/alerts";

import { ConnectHint } from "./ConnectHint";
import { canTouch, isReady, physicalScreen } from "./model";
import { PhysicalMenu, useDeviceActions } from "./PhysicalControls";
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

const ibCls = "w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:pointer-events-none";
const popCls = "absolute z-50 right-full bottom-0 mr-2 w-[260px] max-h-[calc(100vh-96px)] overflow-y-auto rounded-xl p-1.5 text-chat-note bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]";

/** O "⋯" da coluna: Sistema e Botões. */
function MoreButton({ device, name, ready }: { device: string; name: string; ready: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={t("chat.devices.more")} title={t("chat.devices.more")} aria-expanded={open} onClick={() => setOpen(!open)}
        className={`${ibCls} ${open ? "bg-gray-100 dark:bg-white/[0.06] text-gray-900 dark:text-white" : ""}`}>
        <MoreHorizontalIcon className="w-[17px] h-[17px]" />
      </button>
      {open && (
        <div role="menu" aria-label={t("chat.devices.more")} className={popCls}>
          <PhysicalMenu device={device} name={name} tone="panel" ready={ready} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * O aparelho físico no painel direito do modo chat: o seletor (o mesmo do simulador, que vem pronto em `picker`), a
 * linha de estado, a tela espelhada na moldura (clique e arraste tocam; com a tela em foco, o teclado digita) e a
 * coluna com início e o "⋯" (Sistema e Botões). O aparelho vai para os agentes como o simulador: só com a chave
 * "Permitir que agentes controlem dispositivos", e cada ação deles ainda pede a confirmação da pessoa até ela dizer
 * "sempre neste aparelho".
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
  const act = useDeviceActions(device, name);
  const ready = canTouch(status);

  const screen = physicalScreen(status?.display ?? null, current?.family ?? "iphone");
  const frame = deviceFrame(screen.family === "ipad" ? "ipad" : "ios", { w: screen.width, h: screen.height }, { w: size.w - 40, h: size.h - 40 });
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
        <div ref={ref} className="flex-1 min-w-0 flex items-center justify-center p-5">
          {missing && !anyReady ? (
            <ConnectHint tone="panel" />
          ) : frame.outerW > 0 && (
            <div className="shrink-0 box-border bg-gray-900 shadow-[0_0_0_2px_rgba(58,58,60,1),0_24px_48px_-20px_rgba(0,0,0,0.45)]"
              style={{ width: frame.outerW, height: frame.outerH, padding: frame.pad, borderRadius: frame.outerRadius }}>
              <div className="relative h-full w-full overflow-hidden bg-black" style={{ borderRadius: frame.screenRadius }}>
                <PhysicalMirror screenId="chat-devices-physical" device={device} known={!missing} status={status} radius={frame.screenRadius} onError={fail} />
              </div>
            </div>
          )}
        </div>

        <nav aria-label={t("iphone.controls")} className="w-[52px] shrink-0 flex flex-col items-center gap-1 py-3 border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep">
          <button type="button" aria-label={t("iphone.home")} title={t("iphone.home")} disabled={!ready} onClick={act.home} className={ibCls}>
            <HomeIcon className="w-[17px] h-[17px]" />
          </button>
          <span className="flex-1" />
          <MoreButton device={device} name={name} ready={ready} />
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
