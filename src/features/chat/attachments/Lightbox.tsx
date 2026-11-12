import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { savePastedImage } from "@/features/terminal/ipc";

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CutoutIcon, DownloadIcon, FitIcon, GripIcon, MaximizeIcon, MinusIcon, PanelRightIcon, PenIcon, PlayIcon, PlusIcon, TrashIcon, UndoIcon, XIcon, FilePlusIcon } from "../chatIcons";
import { attachToComposer, insertIntoComposer, setRightPanel } from "../store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { insideCwd } from "./openAttachment";
import { commentFromSelection, commentsForMessage, filterMedia, nextMediaIndex, resizeDimensions, undoStroke, type ImageCommentWithRegion, type MarkPoint, type MarkStroke, type MediaFilter } from "./mediaViewerModel";
import { setImageContext } from "./imageContext";
import { backgroundRemovalAvailable, removeImageBackground } from "./ipc";
import { useImagePreview } from "./useImagePreview";

export interface LightboxImage {
  path: string;
  name: string;
  /** A prévia que já se tem (imagem colada). */
  preview: string | null;
  kind?: "image" | "video";
}

export function stepIndex(index: number, step: 1 | -1, count: number): number {
  return nextMediaIndex(index, step, count);
}

/** Visualizador em portal: o conteúdo por trás segue montado, inclusive terminais e navegadores. */
export function Lightbox({ images, index, composerTarget = null, cwd = null, onIndex, onClose }: { images: LightboxImage[]; index: number; composerTarget?: string | null; cwd?: string | null; onIndex: (next: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const current = images[index]!;
  const { src: loadedSrc, missing } = useImagePreview(current.path, current.preview);
  const [editedSrc, setEditedSrc] = useState<string | null>(null);
  const src = editedSrc ?? loadedSrc;
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<"view" | "draw" | "comment" | "erase">("view");
  const [strokeWidth, setStrokeWidth] = useState(0.004);
  const [strokes, setStrokes] = useState<MarkStroke[]>([]);
  const [eraseStrokes, setEraseStrokes] = useState<MarkStroke[]>([]);
  const [redo, setRedo] = useState<Array<{ mode: "draw" | "erase"; stroke: MarkStroke }>>([]);
  const [draftStroke, setDraftStroke] = useState<MarkStroke | null>(null);
  const [comments, setComments] = useState<ImageCommentWithRegion[]>([]);
  const [commentDraft, setCommentDraft] = useState<{ point: MarkPoint; text: string } | null>(null);
  const [commentSelection, setCommentSelection] = useState<{ start: MarkPoint; end: MarkPoint } | null>(null);
  const [showResize, setShowResize] = useState(false);
  const [resizeWidth, setResizeWidth] = useState("");
  const [resizeHeight, setResizeHeight] = useState("");
  const [dockPosition, setDockPosition] = useState({ x: 0, y: 0 });
  const [dragDock, setDragDock] = useState(false);
  const [filter, setFilter] = useState<MediaFilter>(current.kind === "video" ? "video" : "image");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canRemoveBackground, setCanRemoveBackground] = useState(false);
  const dockStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    void backgroundRemovalAvailable().then((available) => { if (mounted) setCanRemoveBackground(available); }).catch(() => { if (mounted) setCanRemoveBackground(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setEditedSrc(null); setZoom(1); setOffset({ x: 0, y: 0 }); setStrokes([]); setEraseStrokes([]); setRedo([]); setComments([]); setCommentSelection(null);
    setTool("view"); setCommentDraft(null); setFilter(current.kind === "video" ? "video" : "image");
  }, [current.path, current.kind]);

  const go = (step: 1 | -1) => onIndex(stepIndex(index, step, images.length));
  const visibleMedia = filterMedia(images.map((image) => ({ ...image, kind: image.kind ?? "image" })), filter);
  const goVisible = (step: 1 | -1) => {
    const currentVisibleIndex = visibleMedia.findIndex((item) => item.path === current.path);
    const next = visibleMedia[nextMediaIndex(Math.max(0, currentVisibleIndex), step, visibleMedia.length)];
    if (next) onIndex(images.findIndex((item) => item.path === next.path));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName) && e.key.startsWith("Arrow")) return;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
    else if (current.kind === "video" && (e.key === "," || e.key === ".")) { e.preventDefault(); stepVideoFrame(e.key === "," ? -1 : 1); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom((value) => Math.min(4, value + 0.1)); }
    else if (e.key === "-") { e.preventDefault(); setZoom((value) => Math.max(0.2, value - 0.1)); }
    else if (e.key === "Tab") {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), summary")];
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const undo = () => {
    if (tool === "erase" && eraseStrokes.length > 0) {
      const stroke = eraseStrokes[eraseStrokes.length - 1]!;
      setEraseStrokes((old) => old.slice(0, -1)); setRedo((old) => [...old, { mode: "erase", stroke }]); return;
    }
    const result = undoStroke(strokes); if (result.undone) { setStrokes(result.strokes); setRedo((old) => [...old, { mode: "draw", stroke: result.undone! }]); }
  };
  const imagePoint = (event: React.PointerEvent): MarkPoint => {
    const rect = imageRef.current?.getBoundingClientRect();
    return rect ? { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) } : { x: 0.5, y: 0.5 };
  };
  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "view") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = imagePoint(event);
    if (tool === "comment") { setCommentDraft({ point, text: "" }); setCommentSelection({ start: point, end: point }); return; }
    setDraftStroke([point]);
  };
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "comment" && commentDraft) {
      const point = imagePoint(event);
      setCommentSelection((selection) => selection ? { ...selection, end: point } : selection);
      return;
    }
    if (!draftStroke) return;
    setDraftStroke((stroke) => stroke ? [...stroke, imagePoint(event)] : stroke);
  };
  const pointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "comment" && commentDraft) {
      const point = imagePoint(event);
      setCommentSelection((selection) => selection ? { ...selection, end: point } : selection);
      return;
    }
    if (draftStroke) {
      if (tool === "erase") setEraseStrokes((old) => [...old, draftStroke]);
      else setStrokes((old) => [...old, draftStroke]);
      setRedo([]); setDraftStroke(null);
    }
  };
  const flattenMarks = (): string | null => {
    const image = imageRef.current;
    if (!image || !src) return null;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) return null;
    context.drawImage(image, 0, 0);
    context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim(); context.lineWidth = Math.max(3, image.naturalWidth * strokeWidth); context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of strokes) { context.beginPath(); stroke.forEach((p, i) => i ? context.lineTo(p.x * canvas.width, p.y * canvas.height) : context.moveTo(p.x * canvas.width, p.y * canvas.height)); context.stroke(); }
    comments.forEach((comment, i) => {
      if (comment.region) {
        context.lineWidth = Math.max(2, canvas.width / 700);
        context.strokeRect(comment.region.x * canvas.width, comment.region.y * canvas.height, comment.region.width * canvas.width, comment.region.height * canvas.height);
      }
      const x = comment.x * canvas.width; const y = comment.y * canvas.height; const radius = Math.max(15, canvas.width / 80);
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim(); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-white").trim(); context.font = `bold ${radius}px sans-serif`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(i + 1), x, y);
    });
    const flattened = canvas.toDataURL("image/png");
    setEditedSrc(flattened);
    return flattened;
  };
  const commitResize = (requested: { width?: number; height?: number }) => {
    const image = imageRef.current; if (!image) return;
    const dimensions = resizeDimensions(image.naturalWidth, image.naturalHeight, requested);
    const canvas = document.createElement("canvas"); canvas.width = dimensions.width; canvas.height = dimensions.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    setEditedSrc(canvas.toDataURL("image/png")); setShowResize(false);
  };
  const resizeImage = (axis: "width" | "height") => {
    const requested = axis === "width" ? Number(resizeWidth) : Number(resizeHeight);
    if (!Number.isFinite(requested) || requested < 1) return;
    commitResize(axis === "width" ? { width: requested } : { height: requested });
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = current.kind === "video" && !editedSrc ? convertFileSrc(current.path) : strokes.length > 0 || comments.length > 0 ? flattenMarks() ?? src ?? "" : src ?? "";
    link.download = current.kind === "video" && !editedSrc ? current.name : current.name.replace(/\.[^.]+$/, ".png");
    link.click();
  };
  const saveToComposer = async () => {
    if (!src) return;
    setSaveError(null);
    if (!editedSrc && strokes.length === 0 && comments.length === 0 && !isInlineImage(current.path)) {
      setImageContext(current.path, comments);
      attachToComposer([current.path], composerTarget);
      return;
    }
    const dataUrl = strokes.length > 0 || comments.length > 0 || isInlineImage(current.path) ? flattenMarks() ?? src : src;
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
      const path = await savePastedImage(bytes, "image/png");
      setImageContext(path, comments);
      attachToComposer([path], composerTarget);
    } catch (error) {
      setSaveError(String(error));
      throw error;
    }
  };
  const sendEraseRequest = async () => {
    const image = imageRef.current;
    if (!image || eraseStrokes.length === 0) return;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) return;
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-gray-950").trim();
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-white").trim();
    context.lineWidth = Math.max(8, canvas.width * strokeWidth * 3); context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of eraseStrokes) { context.beginPath(); stroke.forEach((point, i) => i ? context.lineTo(point.x * canvas.width, point.y * canvas.height) : context.moveTo(point.x * canvas.width, point.y * canvas.height)); context.stroke(); }
    const encoded = canvas.toDataURL("image/png").split(",")[1] ?? "";
    const binary = atob(encoded);
    const maskPath = await savePastedImage(Uint8Array.from(binary, (character) => character.charCodeAt(0)), "image/png");
    attachToComposer([await ensureLocalImagePath(), maskPath], composerTarget);
    insertIntoComposer(t("chat.attach.lightbox.eraseRequest"), composerTarget);
    onClose();
  };
  const removeBackground = async () => {
    setSaveError(null);
    try {
      const path = await removeImageBackground(await ensureLocalImagePath());
      attachToComposer([path], composerTarget);
      onClose();
    } catch (error) {
      setSaveError(String(error));
    }
  };
  const ensureLocalImagePath = async (): Promise<string> => {
    if (!isInlineImage(current.path)) return current.path;
    const image = imageRef.current;
    if (!image) throw new Error("A imagem ainda está carregando");
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Não foi possível preparar a imagem");
    context.drawImage(image, 0, 0);
    const encoded = canvas.toDataURL("image/png").split(",")[1] ?? "";
    const binary = atob(encoded);
    return savePastedImage(Uint8Array.from(binary, (character) => character.charCodeAt(0)), "image/png");
  };
  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setEditedSrc(canvas.toDataURL("image/png"));
  };
  const stepVideoFrame = (step: -1 | 1) => {
    const video = videoRef.current;
    if (video) { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + step / 30)); }
  };
  const toggleVideoFullscreen = () => { const video = videoRef.current; if (video) void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(() => undefined); };
  const currentComments = commentsForMessage(comments);
  const surfaceButton = "rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-gray-100 hover:bg-gray-200/80 dark:hover:bg-white/10 disabled:opacity-40";
  const canEditImage = current.kind !== "video" || Boolean(editedSrc);
  const openInSidePanel = () => {
    if (!insideCwd(cwd, current.path)) return;
    useViewTabsStore.getState().openFile(cwd!, current.path);
    setRightPanel("files");
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("chat.attach.lightbox.label", { index: index + 1, count: images.length, name: current.name })}
      onKeyDown={onKeyDown} onWheel={(event) => {
        const overImage = event.target instanceof HTMLElement && Boolean(event.target.closest("main")) && current.kind !== "video";
        if (overImage || event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom((value) => Math.min(4, Math.max(0.2, value - Math.sign(event.deltaY) * 0.08))); }
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-[10060] flex flex-col bg-surface-1/85 text-gray-900 backdrop-blur-xl dark:bg-gray-950/75 dark:text-white motion-reduce:transition-none">
      <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-gray-200/60 bg-surface-1/60 px-4 dark:border-white/10 dark:bg-gray-950/50">
        <label className="relative">
          <span className="sr-only">{t("chat.attach.lightbox.filter")}</span>
          <select className={surfaceButton} value={filter} onChange={(event) => {
            const nextFilter = event.target.value as MediaFilter;
            setFilter(nextFilter);
            const matching = filterMedia(images.map((image) => ({ ...image, kind: image.kind ?? "image" })), nextFilter);
            if (!matching.some((image) => image.path === current.path) && matching[0]) onIndex(images.findIndex((image) => image.path === matching[0]!.path));
          }}>
            <option value="image">{t("chat.attach.lightbox.images")}</option><option value="video">{t("chat.attach.lightbox.videos")}</option><option value="all">{t("chat.attach.lightbox.all")}</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomOut")} onClick={() => setZoom((value) => Math.max(0.2, value - 0.1))}><MinusIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => setZoom(1)} aria-label={t("chat.attach.lightbox.zoomReset")}>{Math.round(zoom * 100)}%</button>
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomIn")} onClick={() => setZoom((value) => Math.min(4, value + 0.1))}><PlusIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label={t("chat.attach.lightbox.fit")}><FitIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={download} aria-label={t("chat.attach.lightbox.download")}><DownloadIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => { void saveToComposer().catch(console.error); }} aria-label={t("chat.attach.lightbox.attachResult")}><FilePlusIcon className="h-4 w-4" /></button>
          <details className="relative">
            <summary className={`${surfaceButton} list-none cursor-pointer`}>{t("chat.attach.lightbox.open")} <ChevronDownIcon className="ml-1 inline h-4 w-4" /></summary>
            <div className="absolute right-0 top-full z-30 mt-1 flex min-w-48 flex-col rounded-lg border border-gray-200 bg-surface-1 p-1 shadow-xl dark:border-white/10 dark:bg-gray-900">
              <button type="button" disabled={isInlineImage(current.path)} className="rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40" onClick={() => { void openPath(current.path).catch(console.error); }}>{t("chat.attach.lightbox.openDefault")}</button>
              <button type="button" disabled={isInlineImage(current.path)} className="rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40" onClick={() => { void revealItemInDir(current.path).catch(console.error); }}>{t("chat.attach.lightbox.reveal")}</button>
            </div>
          </details>
          <button type="button" className={surfaceButton} disabled={!insideCwd(cwd, current.path)} onClick={openInSidePanel} aria-label={t("chat.attach.lightbox.sidePanel")}><PanelRightIcon className="h-4 w-4" /></button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("chat.attach.lightbox.close")} className={surfaceButton}><XIcon className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {visibleMedia.length > 1 && <aside aria-label={t("chat.attach.lightbox.gallery")} className="z-10 flex w-[4.5rem] shrink-0 flex-col gap-2 overflow-y-auto border-r border-gray-200/60 p-2 dark:border-white/10">
          {visibleMedia.map((image) => { const i = images.findIndex((item) => item.path === image.path); return <button key={image.path} type="button" onClick={() => onIndex(i)} aria-label={t("chat.attach.lightbox.goTo", { name: image.name })} aria-current={i === index ? "true" : undefined}
            className={`h-14 w-14 overflow-hidden rounded-lg ring-2 ${i === index ? "ring-accent-500" : "ring-transparent opacity-70 hover:opacity-100"}`}>
            {image.preview ? <img src={image.preview} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-gray-200 text-xs dark:bg-white/10">{image.kind === "video" ? <PlayIcon className="h-5 w-5" /> : i + 1}</span>}
          </button>; })}
        </aside>}
        <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6" onPointerDown={(event) => { if (zoom > 1 && tool === "view") { const start = { x: event.clientX, y: event.clientY, offset }; const move = (e: PointerEvent) => setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y }); const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); } }}>
          {images.length > 1 && <button type="button" onClick={() => goVisible(-1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) <= 0} aria-label={t("chat.attach.lightbox.prev")} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 dark:bg-white/10"><ChevronLeftIcon className="h-5 w-5" /></button>}
          {src && (current.kind !== "video" || Boolean(editedSrc)) ? <div className="relative flex max-h-full max-w-full items-center justify-center" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
            <img ref={imageRef} src={src} alt={current.name} draggable={false} className="max-h-[calc(100vh-13rem)] max-w-[calc(100vw-10rem)] select-none rounded-lg object-contain shadow-2xl" />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={t("chat.attach.lightbox.markLayer")} className={`absolute inset-0 h-full w-full touch-none ${tool === "view" ? "pointer-events-none" : "cursor-crosshair"}`}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
            {[...strokes, ...(draftStroke && tool !== "erase" ? [draftStroke] : [])].map((stroke, i) => <polyline key={`mark-${i}`} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--color-accent-500)" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />)}
            {[...eraseStrokes, ...(draftStroke && tool === "erase" ? [draftStroke] : [])].map((stroke, i) => <polyline key={`erase-${i}`} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--color-red-500)" strokeWidth={Math.max(0.006, strokeWidth * 3)} strokeLinecap="round" strokeLinejoin="round" />)}
            {commentSelection && (() => { const x = Math.min(commentSelection.start.x, commentSelection.end.x); const y = Math.min(commentSelection.start.y, commentSelection.end.y); return <rect x={x} y={y} width={Math.abs(commentSelection.end.x - commentSelection.start.x)} height={Math.abs(commentSelection.end.y - commentSelection.start.y)} fill="var(--color-accent-500)" fillOpacity=".16" stroke="var(--color-accent-500)" strokeWidth="0.003" />; })()}
            </svg>
            {comments.map((comment, i) => <span key={i} className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white shadow" style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }}>{i + 1}</span>)}
          </div> : current.kind === "video" ? <div className="flex max-h-full max-w-full flex-col items-center gap-3"><video ref={videoRef} src={convertFileSrc(current.path)} controls playsInline className="max-h-[calc(100vh-16rem)] max-w-[calc(100vw-10rem)] rounded-lg shadow-2xl" /><div className="flex items-center gap-2"><button type="button" className={surfaceButton} onClick={() => stepVideoFrame(-1)} aria-label={t("chat.attach.lightbox.framePrevious")}>−1</button><button type="button" className={surfaceButton} onClick={() => stepVideoFrame(1)} aria-label={t("chat.attach.lightbox.frameNext")}>+1</button><label className="text-xs">{t("chat.attach.lightbox.speed")}<select aria-label={t("chat.attach.lightbox.speed")} defaultValue="1" className="ml-2 rounded-md bg-gray-100 px-2 py-1 dark:bg-white/10" onChange={(event) => { if (videoRef.current) videoRef.current.playbackRate = Number(event.target.value); }}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button type="button" className={surfaceButton} onClick={toggleVideoFullscreen} aria-label={t("chat.attach.lightbox.fullscreen")}><MaximizeIcon className="h-4 w-4" /></button><button type="button" className={surfaceButton} onClick={captureFrame}>{t("chat.attach.lightbox.captureFrame")}</button></div></div> : <p className="text-sm text-gray-500 dark:text-white/60">{missing ? t("chat.attach.missing") : t("chat.attach.loading")}</p>}
          {images.length > 1 && <button type="button" onClick={() => goVisible(1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) < 0 || visibleMedia.findIndex((item) => item.path === current.path) === visibleMedia.length - 1} aria-label={t("chat.attach.lightbox.next")} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 dark:bg-white/10"><ChevronRightIcon className="h-5 w-5" /></button>}
        </main>
      </div>
      <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-3">
        <div role="toolbar" aria-label={t("chat.attach.lightbox.tools")} onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; setDragDock(true); dockStart.current = { x: e.clientX, y: e.clientY, left: dockPosition.x, top: dockPosition.y }; }} onPointerMove={(e) => { if (dragDock && dockStart.current) setDockPosition({ x: dockStart.current.left + e.clientX - dockStart.current.x, y: dockStart.current.top + e.clientY - dockStart.current.y }); }} onPointerUp={() => setDragDock(false)}
          className="flex cursor-grab items-center gap-1 rounded-xl border border-white/10 bg-gray-950/90 p-2 text-white shadow-xl active:cursor-grabbing" style={{ transform: `translate(${dockPosition.x}px, ${dockPosition.y}px)` }}>
          <GripIcon className="h-4 w-4 shrink-0 text-white/55" />
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" disabled={!canEditImage} onClick={() => setTool("draw")} aria-label={t("chat.attach.lightbox.mark")}><PenIcon className="h-4 w-4" /></button>
          <label className="flex items-center px-1"><span className="sr-only">{t("chat.attach.lightbox.strokeWidth")}</span><input type="range" min="0.002" max="0.02" step="0.001" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} aria-label={t("chat.attach.lightbox.strokeWidth")} className="h-1 w-14 accent-accent-500" /></label>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10 disabled:opacity-40" disabled={!canEditImage} onClick={() => { setTool("comment"); }} aria-label={t("chat.attach.lightbox.comment")}>{t("chat.attach.lightbox.comment")}</button>
          <button type="button" className="flex items-center gap-1 rounded-md px-2 py-2 text-sm hover:bg-white/10 disabled:opacity-50" disabled={!canRemoveBackground || current.kind === "video"} onClick={() => { void removeBackground(); }} title={!canRemoveBackground ? t("chat.attach.lightbox.removeBackgroundUnavailable") : undefined} aria-label={t("chat.attach.lightbox.removeBackground")}><CutoutIcon className="h-4 w-4" /> {t("chat.attach.lightbox.removeBackground")}</button>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10 disabled:opacity-40" disabled={!canEditImage} onClick={() => setTool("erase")} aria-label={t("chat.attach.lightbox.erase")}>{t("chat.attach.lightbox.erase")}</button>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10 disabled:opacity-40" disabled={!canEditImage} onClick={() => { setResizeWidth(String(imageRef.current?.naturalWidth ?? "")); setResizeHeight(String(imageRef.current?.naturalHeight ?? "")); setShowResize((value) => !value); }} aria-label={t("chat.attach.lightbox.resize")}>{t("chat.attach.lightbox.resize")}</button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={undo} disabled={strokes.length === 0 && eraseStrokes.length === 0} aria-label={t("chat.attach.lightbox.undo")}><UndoIcon className="h-4 w-4" /></button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={() => { const item = redo[redo.length - 1]; if (item) { setRedo((old) => old.slice(0, -1)); if (item.mode === "erase") setEraseStrokes((old) => [...old, item.stroke]); else setStrokes((old) => [...old, item.stroke]); } }} disabled={redo.length === 0} aria-label={t("chat.attach.lightbox.redo")}><UndoIcon className="h-4 w-4 scale-x-[-1]" /></button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={() => { setStrokes([]); setEraseStrokes([]); setRedo([]); setComments([]); setCommentSelection(null); }} disabled={strokes.length + eraseStrokes.length + comments.length === 0} aria-label={t("chat.attach.lightbox.clear")}><TrashIcon className="h-4 w-4" /></button>
          {tool === "erase" && <button type="button" className="rounded-md bg-accent-500 px-3 py-2 text-sm text-white disabled:opacity-40" onClick={() => { void sendEraseRequest().catch((error) => setSaveError(String(error))); }} disabled={eraseStrokes.length === 0}>{t("chat.attach.lightbox.sendEraseRequest")}</button>}
        </div>
        {commentDraft && <form className="flex items-center gap-2 rounded-xl bg-surface-1 p-2 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); if (commentDraft.text.trim()) setComments((old) => { const next = [...old, commentSelection ? commentFromSelection(commentSelection.start, commentSelection.end, commentDraft.text.trim()) : { ...commentDraft.point, text: commentDraft.text.trim() }]; setImageContext(current.path, next); return next; }); setCommentDraft(null); setCommentSelection(null); setTool("view"); }}>
          <input autoFocus value={commentDraft.text} onChange={(e) => setCommentDraft({ ...commentDraft, text: e.target.value })} aria-label={t("chat.attach.lightbox.commentText")} placeholder={t("chat.attach.lightbox.commentText")} className="rounded-md bg-gray-100 px-3 py-2 text-sm dark:bg-white/10" />
          <button className="rounded-md bg-accent-500 px-3 py-2 text-sm text-white" type="submit">{t("chat.attach.lightbox.saveComment")}</button>
        </form>}
        {showResize && <form className="flex items-end gap-2 rounded-xl bg-surface-1 p-3 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); resizeImage("width"); }}>
          <label className="text-xs">{t("chat.attach.lightbox.width")}<input type="number" min="1" value={resizeWidth} onChange={(e) => { const width = e.target.value; setResizeWidth(width); const image = imageRef.current; if (image && Number(width) > 0) setResizeHeight(String(Math.round(Number(width) * image.naturalHeight / image.naturalWidth))); }} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <label className="text-xs">{t("chat.attach.lightbox.height")}<input type="number" min="1" value={resizeHeight} onChange={(e) => { const height = e.target.value; setResizeHeight(height); const image = imageRef.current; if (image && Number(height) > 0) setResizeWidth(String(Math.round(Number(height) * image.naturalWidth / image.naturalHeight))); }} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <button type="submit" className="rounded bg-accent-500 px-3 py-2 text-sm text-white">{t("chat.attach.lightbox.applyResize")}</button>
          <div className="flex gap-1">{[25, 50, 75, 100].map((percent) => <button key={percent} type="button" className="rounded px-2 py-2 text-xs hover:bg-gray-100 dark:hover:bg-white/10" onClick={() => { const image = imageRef.current; if (image) { commitResize({ width: Math.max(1, Math.round(image.naturalWidth * percent / 100)) }); } }}>{percent}%</button>)}</div>
        </form>}
        {currentComments && <p className="max-w-[70vw] whitespace-pre-line rounded-lg bg-surface-1/90 px-3 py-2 text-xs shadow dark:bg-gray-900/90">{currentComments}</p>}
        {saveError && <p role="alert" className="max-w-[70vw] rounded-lg bg-surface-1/90 px-3 py-2 text-xs text-red-700 shadow dark:bg-gray-900/90 dark:text-red-300">{t("chat.attach.lightbox.saveError", { error: saveError })}</p>}
        <button type="button" onClick={flattenMarks} className="sr-only" aria-label={t("chat.attach.lightbox.flattenMarks")}>{t("chat.attach.lightbox.flattenMarks")}</button>
      </div>
    </div>,
    document.body,
  );
}

function isInlineImage(path: string): boolean {
  return /^data:image\//i.test(path);
}
