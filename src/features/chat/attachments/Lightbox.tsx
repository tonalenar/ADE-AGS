import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";

import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FitIcon, MinusIcon, PanelRightIcon, PenIcon, PlusIcon, TrashIcon, UndoIcon, XIcon } from "../chatIcons";
import { commentsForMessage, filterMedia, nextMediaIndex, resizeDimensions, undoStroke, type ImageComment, type MarkPoint, type MarkStroke, type MediaFilter } from "./mediaViewerModel";
import { setImageContext } from "./imageContext";
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
export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number; onIndex: (next: number) => void; onClose: () => void }) {
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
  const [strokes, setStrokes] = useState<MarkStroke[]>([]);
  const [redo, setRedo] = useState<MarkStroke[]>([]);
  const [draftStroke, setDraftStroke] = useState<MarkStroke | null>(null);
  const [comments, setComments] = useState<ImageComment[]>([]);
  const [commentDraft, setCommentDraft] = useState<{ point: MarkPoint; text: string } | null>(null);
  const [showResize, setShowResize] = useState(false);
  const [resizeWidth, setResizeWidth] = useState("");
  const [resizeHeight, setResizeHeight] = useState("");
  const [dockPosition, setDockPosition] = useState({ x: 0, y: 0 });
  const [dragDock, setDragDock] = useState(false);
  const [filter, setFilter] = useState<MediaFilter>("all");
  const dockStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    setEditedSrc(null); setZoom(1); setOffset({ x: 0, y: 0 }); setStrokes([]); setRedo([]); setComments([]);
    setTool("view"); setCommentDraft(null);
  }, [current.path]);

  const go = (step: 1 | -1) => onIndex(stepIndex(index, step, images.length));
  const visibleMedia = filterMedia(images.map((image) => ({ ...image, kind: image.kind ?? "image" })), filter);
  const goVisible = (step: 1 | -1) => {
    const currentVisibleIndex = visibleMedia.findIndex((item) => item.path === current.path);
    const next = visibleMedia[nextMediaIndex(Math.max(0, currentVisibleIndex), step, visibleMedia.length)];
    if (next) onIndex(images.findIndex((item) => item.path === next.path));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom((value) => Math.min(4, value + 0.1)); }
    else if (e.key === "-") { e.preventDefault(); setZoom((value) => Math.max(0.2, value - 0.1)); }
    else if (e.key === "Tab") {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const undo = () => { const result = undoStroke(strokes); if (result.undone) { setStrokes(result.strokes); setRedo((old) => [...old, result.undone!]); } };
  const imagePoint = (event: React.PointerEvent): MarkPoint => {
    const rect = imageRef.current?.getBoundingClientRect();
    return rect ? { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) } : { x: 0.5, y: 0.5 };
  };
  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "view") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = imagePoint(event);
    if (tool === "comment") { setCommentDraft({ point, text: "" }); return; }
    setDraftStroke([point]);
  };
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draftStroke) return;
    setDraftStroke((stroke) => stroke ? [...stroke, imagePoint(event)] : stroke);
  };
  const pointerUp = () => { if (draftStroke) { setStrokes((old) => [...old, draftStroke]); setRedo([]); setDraftStroke(null); } };
  const flattenMarks = (): string | null => {
    const image = imageRef.current;
    if (!image || !src) return null;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) return null;
    context.drawImage(image, 0, 0);
    context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim(); context.lineWidth = Math.max(3, image.naturalWidth / 350); context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of strokes) { context.beginPath(); stroke.forEach((p, i) => i ? context.lineTo(p.x * canvas.width, p.y * canvas.height) : context.moveTo(p.x * canvas.width, p.y * canvas.height)); context.stroke(); }
    comments.forEach((comment, i) => {
      const x = comment.x * canvas.width; const y = comment.y * canvas.height; const radius = Math.max(15, canvas.width / 80);
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim(); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-white").trim(); context.font = `bold ${radius}px sans-serif`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(i + 1), x, y);
    });
    const flattened = canvas.toDataURL("image/png");
    setEditedSrc(flattened);
    return flattened;
  };
  const resizeImage = (axis: "width" | "height") => {
    const image = imageRef.current; if (!image) return;
    const requested = axis === "width" ? Number(resizeWidth) : Number(resizeHeight);
    if (!Number.isFinite(requested) || requested < 1) return;
    const dimensions = resizeDimensions(image.naturalWidth, image.naturalHeight, axis === "width" ? { width: requested } : { height: requested });
    const canvas = document.createElement("canvas"); canvas.width = dimensions.width; canvas.height = dimensions.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    setEditedSrc(canvas.toDataURL("image/png")); setShowResize(false);
  };
  const download = () => {
    if (!src) return;
    const link = document.createElement("a"); link.href = strokes.length > 0 || comments.length > 0 ? flattenMarks() ?? src : src; link.download = current.name; link.click();
  };
  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setEditedSrc(canvas.toDataURL("image/png"));
  };
  const currentComments = commentsForMessage(comments);
  const surfaceButton = "rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-gray-100 hover:bg-gray-200/80 dark:hover:bg-white/10 disabled:opacity-40";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("chat.attach.lightbox.label", { index: index + 1, count: images.length, name: current.name })}
      onKeyDown={onKeyDown} onWheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom((value) => Math.min(4, Math.max(0.2, value - Math.sign(event.deltaY) * 0.08))); } }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-[10060] flex flex-col bg-surface-1/85 text-gray-900 backdrop-blur-xl dark:bg-gray-950/75 dark:text-white motion-reduce:transition-none">
      <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-gray-200/60 bg-surface-1/60 px-4 dark:border-white/10 dark:bg-gray-950/50">
        <label className="relative">
          <span className="sr-only">{t("chat.attach.lightbox.filter")}</span>
          <select className={surfaceButton} value={filter} onChange={(event) => setFilter(event.target.value as MediaFilter)}>
            <option value="image">{t("chat.attach.lightbox.images")}</option><option value="video">{t("chat.attach.lightbox.videos")}</option><option value="all">{t("chat.attach.lightbox.all")}</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomOut")} onClick={() => setZoom((value) => Math.max(0.2, value - 0.1))}><MinusIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => setZoom(1)} aria-label={t("chat.attach.lightbox.zoomReset")}>{Math.round(zoom * 100)}%</button>
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomIn")} onClick={() => setZoom((value) => Math.min(4, value + 0.1))}><PlusIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label={t("chat.attach.lightbox.fit")}><FitIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={download} aria-label={t("chat.attach.lightbox.download")}><DownloadIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.sidePanel")}><PanelRightIcon className="h-4 w-4" /></button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("chat.attach.lightbox.close")} className={surfaceButton}><XIcon className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {visibleMedia.length > 1 && <aside aria-label={t("chat.attach.lightbox.gallery")} className="z-10 flex w-[4.5rem] shrink-0 flex-col gap-2 overflow-y-auto border-r border-gray-200/60 p-2 dark:border-white/10">
          {visibleMedia.map((image) => { const i = images.findIndex((item) => item.path === image.path); return <button key={image.path} type="button" onClick={() => onIndex(i)} aria-label={t("chat.attach.lightbox.goTo", { name: image.name })} aria-current={i === index ? "true" : undefined}
            className={`h-14 w-14 overflow-hidden rounded-lg ring-2 ${i === index ? "ring-accent-500" : "ring-transparent opacity-70 hover:opacity-100"}`}>
            {image.preview ? <img src={image.preview} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-gray-200 text-xs dark:bg-white/10">{image.kind === "video" ? "▶" : i + 1}</span>}
          </button>; })}
        </aside>}
        <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6" onPointerDown={(event) => { if (zoom > 1 && tool === "view") { const start = { x: event.clientX, y: event.clientY, offset }; const move = (e: PointerEvent) => setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y }); const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); } }}>
          {images.length > 1 && <button type="button" onClick={() => goVisible(-1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) <= 0} aria-label={t("chat.attach.lightbox.prev")} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 dark:bg-white/10"><ChevronLeftIcon className="h-5 w-5" /></button>}
          {src && (current.kind !== "video" || Boolean(editedSrc)) ? <div className="relative flex max-h-full max-w-full items-center justify-center" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
            <img ref={imageRef} src={src} alt={current.name} draggable={false} className="max-h-[calc(100vh-13rem)] max-w-[calc(100vw-10rem)] select-none rounded-lg object-contain shadow-2xl" />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={t("chat.attach.lightbox.markLayer")} className={`absolute inset-0 h-full w-full touch-none ${tool === "view" ? "pointer-events-none" : "cursor-crosshair"}`}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
              {[...strokes, ...(draftStroke ? [draftStroke] : [])].map((stroke, i) => <polyline key={i} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={tool === "erase" ? "var(--color-surface-1)" : "var(--color-accent-500)"} strokeWidth="0.004" strokeLinecap="round" strokeLinejoin="round" />)}
            </svg>
            {comments.map((comment, i) => <span key={i} className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white shadow" style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }}>{i + 1}</span>)}
          </div> : current.kind === "video" ? <div className="flex max-h-full max-w-full flex-col gap-3"><video ref={videoRef} src={convertFileSrc(current.path)} controls playsInline className="max-h-[calc(100vh-13rem)] max-w-[calc(100vw-10rem)] rounded-lg shadow-2xl" /><button type="button" className={surfaceButton} onClick={captureFrame}>{t("chat.attach.lightbox.captureFrame")}</button></div> : <p className="text-sm text-gray-500 dark:text-white/60">{missing ? t("chat.attach.missing") : t("chat.attach.loading")}</p>}
          {images.length > 1 && <button type="button" onClick={() => goVisible(1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) < 0 || visibleMedia.findIndex((item) => item.path === current.path) === visibleMedia.length - 1} aria-label={t("chat.attach.lightbox.next")} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 dark:bg-white/10"><ChevronRightIcon className="h-5 w-5" /></button>}
        </main>
      </div>
      <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-3">
        <div role="toolbar" aria-label={t("chat.attach.lightbox.tools")} onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; setDragDock(true); dockStart.current = { x: e.clientX, y: e.clientY, left: dockPosition.x, top: dockPosition.y }; }} onPointerMove={(e) => { if (dragDock && dockStart.current) setDockPosition({ x: dockStart.current.left + e.clientX - dockStart.current.x, y: dockStart.current.top + e.clientY - dockStart.current.y }); }} onPointerUp={() => setDragDock(false)}
          className="flex cursor-grab items-center gap-1 rounded-xl border border-white/10 bg-gray-950/90 p-2 text-white shadow-xl active:cursor-grabbing" style={{ transform: `translate(${dockPosition.x}px, ${dockPosition.y}px)` }}>
          <button type="button" className="rounded-md p-2 hover:bg-white/10" onClick={() => setTool("draw")} aria-label={t("chat.attach.lightbox.mark")}><PenIcon className="h-4 w-4" /></button>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10" onClick={() => { setTool("comment"); }} aria-label={t("chat.attach.lightbox.comment")}>{t("chat.attach.lightbox.comment")}</button>
          <button type="button" className="rounded-md px-2 py-2 text-sm opacity-50" disabled title={t("chat.attach.lightbox.removeBackgroundUnavailable")} aria-label={t("chat.attach.lightbox.removeBackground")}><span aria-hidden>◩</span> {t("chat.attach.lightbox.removeBackground")}</button>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10" onClick={() => setTool("erase")} aria-label={t("chat.attach.lightbox.erase")}>{t("chat.attach.lightbox.erase")}</button>
          <button type="button" className="rounded-md px-2 py-2 text-sm hover:bg-white/10" onClick={() => { setResizeWidth(String(imageRef.current?.naturalWidth ?? "")); setResizeHeight(String(imageRef.current?.naturalHeight ?? "")); setShowResize((value) => !value); }} aria-label={t("chat.attach.lightbox.resize")}>{t("chat.attach.lightbox.resize")}</button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={undo} disabled={strokes.length === 0} aria-label={t("chat.attach.lightbox.undo")}><UndoIcon className="h-4 w-4" /></button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={() => { const stroke = redo[redo.length - 1]; if (stroke) { setRedo((old) => old.slice(0, -1)); setStrokes((old) => [...old, stroke]); } }} disabled={redo.length === 0} aria-label={t("chat.attach.lightbox.redo")}><UndoIcon className="h-4 w-4 scale-x-[-1]" /></button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" onClick={() => { setStrokes([]); setComments([]); }} disabled={strokes.length + comments.length === 0} aria-label={t("chat.attach.lightbox.clear")}><TrashIcon className="h-4 w-4" /></button>
        </div>
        {commentDraft && <form className="flex items-center gap-2 rounded-xl bg-surface-1 p-2 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); if (commentDraft.text.trim()) setComments((old) => { const next = [...old, { ...commentDraft.point, text: commentDraft.text.trim() }]; setImageContext(current.path, next); return next; }); setCommentDraft(null); setTool("view"); }}>
          <input autoFocus value={commentDraft.text} onChange={(e) => setCommentDraft({ ...commentDraft, text: e.target.value })} aria-label={t("chat.attach.lightbox.commentText")} placeholder={t("chat.attach.lightbox.commentText")} className="rounded-md bg-gray-100 px-3 py-2 text-sm dark:bg-white/10" />
          <button className="rounded-md bg-accent-500 px-3 py-2 text-sm text-white" type="submit">{t("chat.attach.lightbox.saveComment")}</button>
        </form>}
        {showResize && <form className="flex items-end gap-2 rounded-xl bg-surface-1 p-3 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); resizeImage("width"); }}>
          <label className="text-xs">{t("chat.attach.lightbox.width")}<input type="number" min="1" value={resizeWidth} onChange={(e) => setResizeWidth(e.target.value)} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <label className="text-xs">{t("chat.attach.lightbox.height")}<input type="number" min="1" value={resizeHeight} onChange={(e) => setResizeHeight(e.target.value)} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <button type="submit" className="rounded bg-accent-500 px-3 py-2 text-sm text-white">{t("chat.attach.lightbox.applyResize")}</button>
        </form>}
        {currentComments && <p className="max-w-[70vw] whitespace-pre-line rounded-lg bg-surface-1/90 px-3 py-2 text-xs shadow dark:bg-gray-900/90">{currentComments}</p>}
        <button type="button" onClick={flattenMarks} className="sr-only" aria-label={t("chat.attach.lightbox.flattenMarks")}>{t("chat.attach.lightbox.flattenMarks")}</button>
      </div>
    </div>,
    document.body,
  );
}
