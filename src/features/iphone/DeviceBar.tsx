import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { usePopover } from "@/features/chat/usePopover";
import { ScreenRecordButton } from "@/features/recording/ScreenRecordButton";
import { AlertaToast } from "@/shared/ui/alerts";

import { iphoneAppSwitcher, iphoneCopyImage, iphoneGesture, iphoneScreenshot } from "./ipc";
import { statusView, type MirrorStatus } from "./model";
import { PhysicalMenu } from "./PhysicalControls";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="h-[16px] w-[16px]" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICON = {
  home: <Icon><path d="M3 11 12 4l9 7v9H5v-9" /></Icon>,
  apps: <Icon><rect x="3" y="6" width="7" height="12" rx="1.5" /><rect x="14" y="6" width="7" height="12" rx="1.5" /></Icon>,
  shot: <Icon><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></Icon>,
  more: <Icon><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>,
};

const btn = "nodrag inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-600 dark:text-white/70 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:pointer-events-none";
const DOT: Record<"ok" | "wait" | "off", string> = {
  ok: "bg-emerald-500 dark:bg-emerald-400",
  wait: "bg-amber-400 animate-pulse motion-reduce:animate-none",
  off: "bg-gray-400 dark:bg-white/35",
};

/**
 * A pílula embaixo do aparelho: estado ao vivo, início, alternador de apps, foto, gravação e "⋯" com Sistema e
 * Botões. A orientação do aparelho físico acompanha o próprio iPhone; a rotação por comando fica no simulador.
 */
export function DeviceBar({ device, name, status, ready, composerTarget }: { device: string; name: string; status: MirrorStatus | undefined; ready: boolean; composerTarget?: string | null }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [shot, setShot] = useState<string | null>(null);
  const view = statusView(status);
  const fail = (e: unknown) => { void AlertaToast(name, String(e), "error", 5000); };
  const live = view.tone === "ok" ? t("iphone.bar.live") : t(view.key);

  const takeShot = () => {
    iphoneScreenshot(device)
      .then((path) => {
        setShot(path);
        window.setTimeout(() => setShot((current) => (current === path ? null : current)), 8000);
      })
      .catch(fail);
  };

  return (
    <div className="relative flex flex-col items-center gap-1.5">
      <div role="toolbar" aria-label={t("iphone.controls")}
        className="flex items-center gap-0.5 rounded-full px-1.5 py-1 bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)]">
        <span role="status" className="mx-1.5 inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-gray-700 dark:text-white/80" title={status?.error ?? live}>
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT[view.tone]}`} />
          {live}
        </span>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-gray-200 dark:bg-white/10" />
        <button type="button" className={btn} disabled={!ready} title={t("iphone.home")} aria-label={t("iphone.home")}
          onClick={() => iphoneGesture(device, "home").catch(fail)}>{ICON.home}</button>
        <button type="button" className={btn} disabled={!ready} title={t("iphone.bar.apps")} aria-label={t("iphone.bar.apps")}
          onClick={() => iphoneAppSwitcher(device).catch(fail)}>{ICON.apps}</button>
        <button type="button" className={btn} disabled={view.tone !== "ok"} title={t("iphone.bar.shot")} aria-label={t("iphone.bar.shot")}
          onClick={takeShot}>{ICON.shot}</button>
        <ScreenRecordButton className={btn} kind="iphone" target={device} composerTarget={composerTarget} label={name} disabled={!ready || view.tone !== "ok"} />
        <div ref={ref} className="relative">
          <button type="button" className={`${btn} ${open ? "bg-gray-200 dark:bg-white/10" : ""}`} title={t("chat.devices.more")} aria-label={t("chat.devices.more")}
            aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{ICON.more}</button>
          {open && (
            <div role="menu" className="absolute bottom-full right-0 z-50 mb-2 w-[260px] rounded-xl p-1.5 text-chat-note bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
              <PhysicalMenu device={device} name={name} tone="panel" ready={ready} onDone={() => setOpen(false)} />
            </div>
          )}
        </div>
      </div>
      {shot && (
        <div role="status" className="flex items-center gap-2 rounded-full px-3 py-1 text-[11.5px] bg-gray-900 text-white dark:bg-surface-overlay">
          <span className="max-w-[220px] truncate" title={shot}>{t("iphone.bar.shotSaved")}</span>
          <button type="button" className="font-medium text-accent-300 hover:text-accent-200"
            onClick={() => iphoneCopyImage(shot).then(() => { setShot(null); void AlertaToast(name, t("iphone.bar.copied"), "success", 2500); }).catch(fail)}>
            {t("iphone.bar.copy")}
          </button>
        </div>
      )}
    </div>
  );
}
