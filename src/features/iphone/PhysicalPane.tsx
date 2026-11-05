import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { deviceFrame } from "@/features/chat/devicesModel";
import { setPanelDevice } from "@/features/chat/store";
import { AlertaToast } from "@/shared/ui/alerts";

import { ConnectHint } from "./ConnectHint";
import { isReady, physicalScreen } from "./model";
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

/**
 * O aparelho físico no painel direito do modo chat: o seletor (o mesmo do simulador, que vem pronto em `picker`), a
 * linha de estado e a tela espelhada na moldura. Só ver: sem a coluna de controles do simulador nem a chave dos
 * agentes. O aparelho não vai para os agentes (`setPanelDevice` fica vazio no iOS).
 */
export function PhysicalPane({ device, picker }: { device: string; picker: ReactNode }) {
  const { t } = useTranslation();
  const devices = useIphoneStore((s) => s.devices);
  const loaded = useIphoneStore((s) => s.loaded);
  const status = useMirrorStatus(device);
  const current = devices.find((d) => d.id === device);
  const anyReady = devices.some(isReady);
  // Sem o aparelho escolhido por perto, a lista fica em dia para o estado vazio.
  usePhysicalDevices(loaded && !current);
  useEffect(() => { void refreshPhysical(); }, []);
  useEffect(() => { setPanelDevice("ios", null, null); }, []);
  const { ref, size } = useBoxSize();
  const fail = useCallback((e: unknown) => { void AlertaToast(current?.name ?? t("iphone.section.devices"), String(e), "error", 5000); }, [current?.name, t]);

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
      </div>
      <p className="m-0 shrink-0 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-caption text-gray-500 dark:text-white/50">
        {t("iphone.viewOnly")}
      </p>
    </div>
  );
}
