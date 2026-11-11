import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { presentDeviceTool } from "@/features/chat/deviceDemand";
import { KeyboardIcon } from "@/features/chat/chatIcons";
import { usePopover } from "@/features/chat/usePopover";
import { ScreenRecordButton } from "@/features/recording/ScreenRecordButton";
import { AlertaToast } from "@/shared/ui/alerts";

import { iphoneAppSwitcher, iphoneCopyImage, iphoneGesture, iphoneScreenshot, iphoneType } from "./ipc";
import { statusView, stepZoom, type MirrorStatus } from "./model";
import { PhysicalMenu } from "./PhysicalControls";

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">{children}</svg>;
}

const ICON = {
  home: <Icon><path d="M3 11 12 4l9 7v9H5v-9" /></Icon>,
  apps: <Icon><rect x="3" y="6" width="7" height="12" rx="1.5" /><rect x="14" y="6" width="7" height="12" rx="1.5" /></Icon>,
  shot: <Icon><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></Icon>,
  rotate: <Icon><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v4h4" /></Icon>,
  more: <Icon><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>,
  refresh: <Icon><path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4" /></Icon>,
  fit: <Icon><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>,
  fullscreen: <Icon><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" /></Icon>,
  pause: <Icon><path d="M9 6.5v11M15 6.5v11" strokeWidth={2.8} /></Icon>,
  play: <Icon><path d="M9 6.5v11l9-5.5-9-5.5Z" fill="currentColor" stroke="none" /></Icon>,
};

const btn = "nodrag inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-gray-600 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-40";
const dotClass = { ok: "bg-emerald-500 dark:bg-emerald-400", wait: "bg-amber-400 animate-pulse motion-reduce:animate-none", off: "bg-gray-400 dark:bg-white/35" } as const;

function KeyboardButton({ device, name, ready, title }: { device: string; name: string; ready: boolean; title: string }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [text, setText] = useState("");
  const fail = (e: unknown) => { void AlertaToast(name, String(e), "error", 5000); };
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={title} title={title} aria-expanded={open} disabled={!ready} onClick={() => setOpen(!open)} className={`${btn} ${open ? "bg-gray-100 dark:bg-white/[0.06]" : ""}`}>
        <KeyboardIcon className="h-4 w-4" />
      </button>
      {open && (
        <form role="dialog" aria-label={t("iphone.keyboard")} className="absolute bottom-full right-0 z-50 mb-2 flex w-[280px] flex-col gap-2 rounded-xl bg-white p-2 text-chat-note shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)] dark:bg-surface-raised"
          onSubmit={(e) => { e.preventDefault(); if (text) iphoneType(device, text).then(() => { setText(""); setOpen(false); }).catch(fail); }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.devices.typePlaceholder")} aria-label={t("chat.devices.typePlaceholder")} className="h-8 min-w-0 rounded-lg border border-gray-200 bg-white px-2.5 text-chat-note text-gray-900 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
          <p className="m-0 text-chat-caption text-gray-500 dark:text-white/50">{t("iphone.keyboardHint")}</p>
          <button type="submit" disabled={!text} className="h-8 self-end rounded-lg bg-accent-600 px-3 text-chat-note font-medium text-white disabled:opacity-40">{t("chat.devices.type")}</button>
        </form>
      )}
    </div>
  );
}

/** Barra única do espelho: estado/sessão, ações, digitação e zoom ficam agrupados sob o aparelho. */
export function DeviceBar({ device, name, status, ready, disconnected, composerTarget, zoom, onZoom, onRefresh, refreshing, onSession, sessionBusy, fullscreen, onFullscreen }: {
  device: string; name: string; status: MirrorStatus | undefined; ready: boolean; disconnected: boolean;
  composerTarget?: string | null; zoom: number | "fit"; onZoom: (next: number | "fit") => void;
  onRefresh: () => void; refreshing: boolean; onSession: () => void; sessionBusy: boolean;
  fullscreen: boolean; onFullscreen: () => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [shot, setShot] = useState<string | null>(null);
  const view = statusView(status);
  const label = disconnected ? t("iphone.status.paused") : t(view.key);
  const fail = (e: unknown) => { void AlertaToast(name, String(e), "error", 5000); };
  const home = presentDeviceTool(DESKTOP_OS, "ios-physical", "home", ready, t("iphone.home"), t);
  const apps = presentDeviceTool(DESKTOP_OS, "ios-physical", "appSwitcher", ready, t("iphone.bar.apps"), t);
  const shotAction = presentDeviceTool(DESKTOP_OS, "ios-physical", "screenshot", view.tone === "ok", t("iphone.bar.shot"), t);
  const keyboard = presentDeviceTool(DESKTOP_OS, "ios-physical", "keyboard", ready, t("iphone.keyboard"), t);

  const takeShot = () => iphoneScreenshot(device).then((path) => {
    setShot(path);
    window.setTimeout(() => setShot((current) => current === path ? null : current), 8000);
  }).catch(fail);

  return (
    <div className="relative flex max-w-full flex-col items-center gap-1.5">
      <div role="toolbar" aria-label={t("iphone.controls")} className="flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-2xl bg-white px-2 py-1.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-gray-200 dark:bg-surface-raised dark:ring-white/10">
        <span role="status" className="mx-1.5 inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium text-gray-700 dark:text-white/80" title={status?.error ?? label}>
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${disconnected ? dotClass.off : dotClass[view.tone]}`} />
          {label}{!disconnected && view.transport ? ` · ${t(view.transport)}` : ""}
          {status?.state === "live" && status.fps != null ? <span className="text-gray-500 dark:text-white/50">· {t("iphone.status.fps", { count: status.fps })}</span> : null}
        </span>
        <button type="button" className={btn} disabled={refreshing} title={t("iphone.search")} aria-label={t("iphone.search")} onClick={onRefresh}><span className={refreshing ? "animate-spin" : ""}>{ICON.refresh}</span></button>
        <button type="button" className={btn} disabled={sessionBusy} title={t(disconnected ? "iphone.session.connect" : "iphone.session.disconnect")} aria-label={t(disconnected ? "iphone.session.connect" : "iphone.session.disconnect")} aria-pressed={disconnected} onClick={onSession}>{disconnected ? ICON.play : ICON.pause}</button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
        <button type="button" className={btn} disabled={home.disabled} title={home.label} aria-label={home.label} onClick={() => iphoneGesture(device, "home").catch(fail)}>{ICON.home}</button>
        <button type="button" className={btn} disabled={apps.disabled} title={apps.label} aria-label={apps.label} onClick={() => iphoneAppSwitcher(device).catch(fail)}>{ICON.apps}</button>
        <button type="button" className={btn} disabled={shotAction.disabled} title={shotAction.label} aria-label={shotAction.label} onClick={takeShot}>{ICON.shot}</button>
        <ScreenRecordButton className={btn} kind="iphone" target={device} composerTarget={composerTarget} label={name} disabled={!ready} />
        <button type="button" className={btn} title={t("iphone.bar.rotateHint")} aria-label={t("iphone.bar.rotateHint")} onClick={() => void AlertaToast(name, t("iphone.bar.rotateHint"), "info", 6000)}>{ICON.rotate}</button>
        <KeyboardButton device={device} name={name} ready={!keyboard.disabled} title={keyboard.label} />
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
        <button type="button" className={btn} title={t("iphone.zoom.out")} aria-label={t("iphone.zoom.out")} onClick={() => onZoom(typeof zoom === "number" ? stepZoom(zoom, -1) : 0.9)}>−</button>
        <span className="min-w-9 text-center font-mono text-[10.5px] tabular-nums text-gray-500 dark:text-white/50">{zoom === "fit" ? t("iphone.zoom.fitShort") : `${Math.round(zoom * 100)}%`}</span>
        <button type="button" className={btn} title={t("iphone.zoom.in")} aria-label={t("iphone.zoom.in")} onClick={() => onZoom(typeof zoom === "number" ? stepZoom(zoom, 1) : 1.1)}>+</button>
        <button type="button" className={`${btn} ${zoom === "fit" ? "bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white" : ""}`} aria-pressed={zoom === "fit"} title={t("iphone.zoom.fit")} aria-label={t("iphone.zoom.fit")} onClick={() => onZoom("fit")}>{ICON.fit}</button>
        <button type="button" className={`${btn} ${zoom === 1 ? "bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white" : ""}`} aria-pressed={zoom === 1} title={t("iphone.zoom.actual")} aria-label={t("iphone.zoom.actual")} onClick={() => onZoom(1)}>1:1</button>
        <button type="button" className={btn} title={t(fullscreen ? "iphone.fullscreen.exit" : "iphone.fullscreen.enter")} aria-label={t(fullscreen ? "iphone.fullscreen.exit" : "iphone.fullscreen.enter")} aria-pressed={fullscreen} onClick={onFullscreen}>{ICON.fullscreen}</button>
        <div ref={ref} className="relative">
          <button type="button" className={`${btn} ${open ? "bg-gray-100 dark:bg-white/[0.08]" : ""}`} title={t("chat.devices.more")} aria-label={t("chat.devices.more")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{ICON.more}</button>
          {open && <div role="menu" className="absolute bottom-full right-0 z-50 mb-2 w-[260px] rounded-xl bg-white p-1.5 text-chat-note shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)] dark:bg-surface-raised"><PhysicalMenu device={device} name={name} tone="panel" ready={ready} onDone={() => setOpen(false)} /></div>}
        </div>
      </div>
      {shot && <div role="status" className="flex items-center gap-2 rounded-full bg-gray-900 px-3 py-1 text-[11.5px] text-white dark:bg-surface-overlay"><span className="max-w-[220px] truncate" title={shot}>{t("iphone.bar.shotSaved")}</span><button type="button" className="font-medium text-accent-300 hover:text-accent-200" onClick={() => iphoneCopyImage(shot).then(() => { setShot(null); void AlertaToast(name, t("iphone.bar.copied"), "success", 2500); }).catch(fail)}>{t("iphone.bar.copy")}</button></div>}
    </div>
  );
}
