import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { presentDeviceTool } from "@/features/chat/deviceDemand";
import {
  AppSwitcherIcon, CameraIcon, ExpandIcon, FitIcon, HomeIcon, KeyboardIcon, MoreVerticalIcon, PauseIcon, PlayIcon, ReloadIcon, RotateIcon,
  ShrinkIcon, ZoomInIcon, ZoomOutIcon,
} from "@/features/chat/chatIcons";
import { usePopover } from "@/features/chat/usePopover";
import { ScreenRecordButton } from "@/features/recording/ScreenRecordButton";
import { AlertaToast } from "@/shared/ui/alerts";

import { iphoneAppSwitcher, iphoneCopyImage, iphoneGesture, iphoneScreenshot, iphoneType } from "./ipc";
import { statusView, stepZoom, type MirrorStatus } from "./model";
import { PhysicalMenu } from "./PhysicalControls";

const ic = "h-[17px] w-[17px]";
const btn = "nodrag inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-40";
const dotClass = { ok: "bg-emerald-500 dark:bg-emerald-400", wait: "bg-amber-400 animate-pulse motion-reduce:animate-none", off: "bg-gray-400 dark:bg-white/35" } as const;

function KeyboardButton({ device, name, ready, title }: { device: string; name: string; ready: boolean; title: string }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const [text, setText] = useState("");
  const fail = (e: unknown) => { void AlertaToast(name, String(e), "error", 5000); };
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={title} title={title} aria-expanded={open} disabled={!ready} onClick={() => setOpen(!open)} className={`${btn} ${open ? "bg-gray-100 dark:bg-white/[0.06]" : ""}`}>
        <KeyboardIcon className={ic} />
      </button>
      {open && (
        <form role="dialog" aria-label={t("iphone.keyboard")} className="absolute right-full top-0 z-50 mr-2 flex w-[280px] flex-col gap-2 rounded-xl bg-white p-2 text-chat-note shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)] dark:bg-surface-raised"
          onSubmit={(e) => { e.preventDefault(); if (text) iphoneType(device, text).then(() => { setText(""); setOpen(false); }).catch(fail); }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.devices.typePlaceholder")} aria-label={t("chat.devices.typePlaceholder")} className="h-8 min-w-0 rounded-lg border border-gray-200 bg-white px-2.5 text-chat-note text-gray-900 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white" />
          <p className="m-0 text-chat-caption text-gray-500 dark:text-white/50">{t("iphone.keyboardHint")}</p>
          <button type="submit" disabled={!text} className="h-8 self-end rounded-lg bg-accent-600 px-3 text-chat-note font-medium text-white disabled:opacity-40">{t("chat.devices.type")}</button>
        </form>
      )}
    </div>
  );
}

/** Coluna única do espelho, à direita do aparelho (como a do simulador): estado/sessão, ações, digitação, zoom e menu; os painéizinhos abrem à esquerda. */
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

  const sep = <span aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-gray-200 dark:bg-white/[0.08]" />;
  const statusText = `${label}${!disconnected && view.transport ? ` · ${t(view.transport)}` : ""}${status?.state === "live" && status.fps != null ? ` · ${t("iphone.status.fps", { count: status.fps })}` : ""}`;
  return (
    <div role="toolbar" aria-orientation="vertical" aria-label={t("iphone.controls")} className="relative flex h-full w-[52px] shrink-0 flex-col items-center gap-1 border-l border-gray-200 bg-white py-3 dark:border-white/[0.08] dark:bg-surface-deep">
      <span role="status" title={status?.error ?? statusText} className="flex h-8 w-8 shrink-0 items-center justify-center">
        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${disconnected ? dotClass.off : dotClass[view.tone]}`} />
        <span className="sr-only">{statusText}</span>
      </span>
      <button type="button" className={btn} disabled={refreshing} title={t("iphone.search")} aria-label={t("iphone.search")} onClick={onRefresh}><span className={refreshing ? "animate-spin" : ""}><ReloadIcon className={ic} /></span></button>
      <button type="button" className={btn} disabled={sessionBusy} title={t(disconnected ? "iphone.session.connect" : "iphone.session.disconnect")} aria-label={t(disconnected ? "iphone.session.connect" : "iphone.session.disconnect")} aria-pressed={disconnected} onClick={onSession}>{disconnected ? <PlayIcon className={ic} /> : <PauseIcon className={ic} />}</button>
      {sep}
      <button type="button" className={btn} disabled={home.disabled} title={home.label} aria-label={home.label} onClick={() => iphoneGesture(device, "home").catch(fail)}><HomeIcon className={ic} /></button>
      <button type="button" className={btn} disabled={apps.disabled} title={apps.label} aria-label={apps.label} onClick={() => iphoneAppSwitcher(device).catch(fail)}><AppSwitcherIcon className={ic} /></button>
      <button type="button" className={btn} disabled={shotAction.disabled} title={shotAction.label} aria-label={shotAction.label} onClick={takeShot}><CameraIcon className={ic} /></button>
      <ScreenRecordButton className={btn} kind="iphone" target={device} composerTarget={composerTarget} label={name} disabled={!ready} />
      <button type="button" className={btn} title={t("iphone.bar.rotateHint")} aria-label={t("iphone.bar.rotateHint")} onClick={() => void AlertaToast(name, t("iphone.bar.rotateHint"), "info", 6000)}><RotateIcon className={ic} /></button>
      <KeyboardButton device={device} name={name} ready={!keyboard.disabled} title={keyboard.label} />
      {sep}
      <button type="button" className={btn} title={t("iphone.zoom.in")} aria-label={t("iphone.zoom.in")} onClick={() => onZoom(typeof zoom === "number" ? stepZoom(zoom, 1) : 1.1)}><ZoomInIcon className={ic} /></button>
      {/* No modo ajustar o botão destacado já diz o estado; o número só aparece com zoom manual. */}
      {zoom !== "fit" && <span className="shrink-0 text-center text-[10px] tabular-nums text-gray-500 dark:text-white/50">{Math.round(zoom * 100)}%</span>}
      <button type="button" className={btn} title={t("iphone.zoom.out")} aria-label={t("iphone.zoom.out")} onClick={() => onZoom(typeof zoom === "number" ? stepZoom(zoom, -1) : 0.9)}><ZoomOutIcon className={ic} /></button>
      <button type="button" className={`${btn} ${zoom === "fit" ? "bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white" : ""}`} aria-pressed={zoom === "fit"} title={t("iphone.zoom.fit")} aria-label={t("iphone.zoom.fit")} onClick={() => onZoom("fit")}><FitIcon className={ic} /></button>
      <button type="button" className={`${btn} font-mono text-[10.5px] ${zoom === 1 ? "bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white" : ""}`} aria-pressed={zoom === 1} title={t("iphone.zoom.actual")} aria-label={t("iphone.zoom.actual")} onClick={() => onZoom(1)}>1:1</button>
      <button type="button" className={btn} title={t(fullscreen ? "iphone.fullscreen.exit" : "iphone.fullscreen.enter")} aria-label={t(fullscreen ? "iphone.fullscreen.exit" : "iphone.fullscreen.enter")} aria-pressed={fullscreen} onClick={onFullscreen}>{fullscreen ? <ShrinkIcon className={ic} /> : <ExpandIcon className={ic} />}</button>
      <span className="flex-1" />
      <div ref={ref} className="relative">
        <button type="button" className={`${btn} ${open ? "bg-gray-100 dark:bg-white/[0.08]" : ""}`} title={t("chat.devices.more")} aria-label={t("chat.devices.more")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreVerticalIcon className={ic} /></button>
        {open && <div role="menu" className="absolute bottom-0 right-full z-50 mr-2 max-h-[calc(100vh-96px)] w-[260px] overflow-y-auto rounded-xl bg-white p-1.5 text-chat-note shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)] cc-scroll-hidden dark:bg-surface-raised"><PhysicalMenu device={device} name={name} tone="panel" ready={ready} onDone={() => setOpen(false)} /></div>}
      </div>
      {shot && <div role="status" className="absolute bottom-3 right-full z-40 mr-2 flex items-center gap-2 whitespace-nowrap rounded-full bg-gray-900 px-3 py-1 text-[11.5px] text-white dark:bg-surface-overlay"><span className="max-w-[220px] truncate" title={shot}>{t("iphone.bar.shotSaved")}</span><button type="button" className="font-medium text-accent-300 hover:text-accent-200" onClick={() => iphoneCopyImage(shot).then(() => { setShot(null); void AlertaToast(name, t("iphone.bar.copied"), "success", 2500); }).catch(fail)}>{t("iphone.bar.copy")}</button></div>}
    </div>
  );
}
