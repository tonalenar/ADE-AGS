import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { savePastedImage } from "@/features/terminal/ipc";

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CutoutIcon, DownloadIcon, FitIcon, FilePlusIcon, GripIcon, MaximizeIcon, MinusIcon, MoreHorizontalIcon, PanelRightIcon, PenIcon, PlayIcon, PlusIcon, TrashIcon, XIcon } from "../chatIcons";
import { attachToComposer, insertIntoComposer, setRightPanel } from "../store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { insideCwd } from "./openAttachment";
import { commentFromSelection, commentsForMessage, filterMedia, nextMediaIndex, resizeDimensions, type ImageCommentWithRegion, type MarkPoint, type MarkStroke, type MediaFilter } from "./mediaViewerModel";
import { ANNOTATION_COLORS, arrowHead, boxOf, colorVar, eraseAt, isDegenerate, nextStepNumber, paintAnnotations, type Annotation, type AnnotationColor, type BoxMark, type AnnotationTool } from "./annotations";
import { ArrowToolIcon, BlurToolIcon, ClipboardToolIcon, CommentToolIcon, EllipseToolIcon, EraserToolIcon, HighlighterIcon, MagicEraseIcon, RectToolIcon, RedoIcon, ResizeToolIcon, SaveCopyIcon, StepToolIcon, TextToolIcon, UndoIcon2 } from "./annotateIcons";
import { setImageContext } from "./imageContext";
import { backgroundRemovalAvailable, removeImageBackground, saveAnnotatedCopy } from "./ipc";
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

type Tool = "view" | AnnotationTool | "comment" | "erase";
interface Snapshot { marks: Annotation[]; eraseStrokes: MarkStroke[] }

/** As ferramentas de marcação, na ordem da dock, com o atalho de teclado de cada uma. */
const DRAW_TOOLS: Array<{ tool: AnnotationTool; key: string; icon: (p: { className?: string }) => ReactNode }> = [
  { tool: "pen", key: "P", icon: PenIcon },
  { tool: "highlighter", key: "H", icon: HighlighterIcon },
  { tool: "arrow", key: "A", icon: ArrowToolIcon },
  { tool: "rect", key: "R", icon: RectToolIcon },
  { tool: "ellipse", key: "O", icon: EllipseToolIcon },
  { tool: "text", key: "T", icon: TextToolIcon },
  { tool: "step", key: "N", icon: StepToolIcon },
  { tool: "blur", key: "B", icon: BlurToolIcon },
  { tool: "eraser", key: "X", icon: EraserToolIcon },
];

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

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
  const [natural, setNatural] = useState<{ width: number; height: number }>({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<Tool>("view");
  const [color, setColor] = useState<AnnotationColor>("red-500");
  const [strokeWidth, setStrokeWidth] = useState(0.004);
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [eraseStrokes, setEraseStrokes] = useState<MarkStroke[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [eraseDraft, setEraseDraft] = useState<MarkStroke | null>(null);
  const [textDraft, setTextDraft] = useState<{ at: MarkPoint; text: string; edit?: number } | null>(null);
  const [comments, setComments] = useState<ImageCommentWithRegion[]>([]);
  const [commentDraft, setCommentDraft] = useState<{ point: MarkPoint; text: string } | null>(null);
  const [commentSelection, setCommentSelection] = useState<{ start: MarkPoint; end: MarkPoint } | null>(null);
  const [showResize, setShowResize] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [resizeWidth, setResizeWidth] = useState("");
  const [resizeHeight, setResizeHeight] = useState("");
  const [dockPosition, setDockPosition] = useState({ x: 0, y: 0 });
  const [dragDock, setDragDock] = useState(false);
  const [filter, setFilter] = useState<MediaFilter>(current.kind === "video" ? "video" : "image");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canRemoveBackground, setCanRemoveBackground] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);
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
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setEditedSrc(null); setZoom(1); setOffset({ x: 0, y: 0 }); setMarks([]); setEraseStrokes([]); setPast([]); setFuture([]); setComments([]); setCommentSelection(null);
    setTool("view"); setCommentDraft(null); setTextDraft(null); setDraft(null); setNotice(null); setFilter(current.kind === "video" ? "video" : "image");
  }, [current.path, current.kind]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** Guarda o estado atual no histórico e aplica o novo (desfazer/refazer únicos para marcas e máscara). */
  const commit = (next: Partial<Snapshot>) => {
    setPast((old) => [...old, { marks, eraseStrokes }]);
    setFuture([]);
    if (next.marks) setMarks(next.marks);
    if (next.eraseStrokes) setEraseStrokes(next.eraseStrokes);
  };
  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast((old) => old.slice(0, -1)); setFuture((old) => [...old, { marks, eraseStrokes }]);
    setMarks(previous.marks); setEraseStrokes(previous.eraseStrokes);
  };
  const redo = () => {
    const next = future[future.length - 1];
    if (!next) return;
    setFuture((old) => old.slice(0, -1)); setPast((old) => [...old, { marks, eraseStrokes }]);
    setMarks(next.marks); setEraseStrokes(next.eraseStrokes);
  };
  const clearAll = () => { commit({ marks: [], eraseStrokes: [] }); setComments([]); setCommentSelection(null); };

  const isVideo = current.kind === "video";
  const showingImage = Boolean(src) && (!isVideo || Boolean(editedSrc));
  /** No vídeo, escolher uma ferramenta congela o quadro atual e passa a anotar sobre ele. */
  const pickTool = (next: Tool) => {
    if (next !== "view" && isVideo && !editedSrc && !captureFrame()) return;
    setTool((value) => (value === next && next !== "view" ? "view" : next));
    setShowStyle(false); setShowMore(false);
  };

  const go = (step: 1 | -1) => onIndex(stepIndex(index, step, images.length));
  const visibleMedia = filterMedia(images.map((image) => ({ ...image, kind: image.kind ?? "image" })), filter);
  const goVisible = (step: 1 | -1) => {
    const currentVisibleIndex = visibleMedia.findIndex((item) => item.path === current.path);
    const next = visibleMedia[nextMediaIndex(Math.max(0, currentVisibleIndex), step, visibleMedia.length)];
    if (next) onIndex(images.findIndex((item) => item.path === next.path));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (textDraft || commentDraft) { setTextDraft(null); setCommentDraft(null); setCommentSelection(null); return; }
      if (tool !== "view") { setTool("view"); return; }
      onClose();
    }
    else if (typing && (e.key.startsWith("Arrow") || e.key.length === 1)) return;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(1); }
    else if (isVideo && !editedSrc && (e.key === "," || e.key === ".")) { e.preventDefault(); stepVideoFrame(e.key === "," ? -1 : 1); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && hasMarks) { e.preventDefault(); void copyToClipboard(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom((value) => Math.min(4, value + 0.1)); }
    else if (e.key === "-") { e.preventDefault(); setZoom((value) => Math.max(0.2, value - 0.1)); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      const key = e.key.toUpperCase();
      const draw = DRAW_TOOLS.find((item) => item.key === key);
      if (draw) { e.preventDefault(); pickTool(draw.tool); }
      else if (key === "V") { e.preventDefault(); pickTool("view"); }
      else if (key === "C") { e.preventDefault(); pickTool("comment"); }
    }
    else if (e.key === "Tab") {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), summary")];
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const imagePoint = (event: React.PointerEvent): MarkPoint => {
    const rect = imageRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) } : { x: 0.5, y: 0.5 };
  };
  const aspect = natural.height / Math.max(1, natural.width);
  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "view") return;
    // Sem isto, o mousedown que vem depois tira o foco do campo de texto recém-aberto (o SVG não é focável),
    // o blur confirma o rascunho vazio e o campo some na hora: a ferramenta de texto "não fazia nada".
    event.preventDefault();
    if (textDraft) { submitText(); return; }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = imagePoint(event);
    switch (tool) {
      case "comment": setCommentDraft({ point, text: "" }); setCommentSelection({ start: point, end: point }); return;
      case "erase": setEraseDraft([point]); return;
      case "eraser": { const result = eraseAt(marks, point, aspect); if (result.removed) commit({ marks: result.marks }); return; }
      case "text": {
        // Clicar (ou dar duplo clique) num texto que já existe reabre ele para editar.
        const hit = textHitIndex(marks, point, aspect);
        const existing = hit >= 0 ? marks[hit] : undefined;
        setTextDraft(existing && existing.kind === "text" ? { at: existing.at, text: existing.text, edit: hit } : { at: point, text: "" });
        return;
      }
      case "step": commit({ marks: [...marks, { kind: "step", color, width: strokeWidth, at: point, n: nextStepNumber(marks) }] }); return;
      case "pen": case "highlighter": setDraft({ kind: tool, color, width: strokeWidth, points: [point] }); return;
      default: setDraft({ kind: tool, color, width: strokeWidth, from: point, to: point });
    }
  };
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "comment" && commentDraft) { const point = imagePoint(event); setCommentSelection((selection) => selection ? { ...selection, end: point } : selection); return; }
    if (tool === "eraser" && event.buttons === 1) { const result = eraseAt(marks, imagePoint(event), aspect); if (result.removed) commit({ marks: result.marks }); return; }
    if (eraseDraft) { setEraseDraft((stroke) => stroke ? [...stroke, imagePoint(event)] : stroke); return; }
    if (!draft) return;
    const point = imagePoint(event);
    setDraft((mark) => !mark ? mark : "points" in mark ? { ...mark, points: [...mark.points, point] } : "to" in mark ? { ...mark, to: point } : mark);
  };
  const pointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "comment" && commentDraft) { const point = imagePoint(event); setCommentSelection((selection) => selection ? { ...selection, end: point } : selection); return; }
    if (eraseDraft) { commit({ eraseStrokes: [...eraseStrokes, eraseDraft] }); setEraseDraft(null); return; }
    if (draft) { if (!isDegenerate(draft)) commit({ marks: [...marks, draft] }); setDraft(null); }
  };
  const submitText = () => {
    if (!textDraft) return;
    const text = textDraft.text.trim();
    const rest = textDraft.edit === undefined ? marks : marks.filter((_, i) => i !== textDraft.edit);
    const previous = textDraft.edit === undefined ? undefined : marks[textDraft.edit];
    const style = previous && previous.kind === "text" ? { color: previous.color, width: previous.width } : { color, width: strokeWidth };
    if (text) commit({ marks: [...rest, { kind: "text", ...style, at: textDraft.at, text }] });
    else if (textDraft.edit !== undefined) commit({ marks: rest });
    setTextDraft(null);
  };
  const hasMarks = marks.length > 0 || comments.length > 0;
  /** A imagem com as marcas e os comentários pintados, como PNG em URL de dados. */
  const flattenMarks = (): string | null => {
    const image = imageRef.current;
    if (!image || !src) return null;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) return null;
    context.drawImage(image, 0, 0);
    paintAnnotations(context, marks, canvas.width, canvas.height, image);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim();
    comments.forEach((comment, i) => {
      context.strokeStyle = accent;
      if (comment.region) {
        context.lineWidth = Math.max(2, canvas.width / 700);
        context.strokeRect(comment.region.x * canvas.width, comment.region.y * canvas.height, comment.region.width * canvas.width, comment.region.height * canvas.height);
      }
      const x = comment.x * canvas.width; const y = comment.y * canvas.height; const radius = Math.max(15, canvas.width / 80);
      context.fillStyle = accent; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-white").trim(); context.font = `bold ${radius}px sans-serif`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(i + 1), x, y);
    });
    return canvas.toDataURL("image/png");
  };
  /** Aplica as marcas na imagem em edição (achatar): elas deixam de ser editáveis. */
  const applyMarks = () => { const flat = flattenMarks(); if (flat) { setEditedSrc(flat); commit({ marks: [] }); setComments([]); } };
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
  const resultDataUrl = (): string | null => (hasMarks ? flattenMarks() : null) ?? src;
  const download = () => {
    const link = document.createElement("a");
    link.href = isVideo && !editedSrc ? convertFileSrc(current.path) : resultDataUrl() ?? "";
    link.download = isVideo && !editedSrc ? current.name : current.name.replace(/\.[^.]+$/, ".png");
    link.click();
  };
  const saveCopy = async () => {
    setSaveError(null);
    const dataUrl = resultDataUrl();
    if (!dataUrl || isInlineImage(current.path)) return;
    try {
      const saved = await saveAnnotatedCopy(current.path, dataUrl.slice(dataUrl.indexOf(",") + 1));
      setNotice(t("chat.attach.lightbox.savedCopy", { name: saved.split(/[\\/]/).pop() ?? saved }));
    } catch (error) { setSaveError(String(error)); }
  };
  const copyToClipboard = async () => {
    setSaveError(null);
    const dataUrl = resultDataUrl();
    if (!dataUrl) return;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setNotice(t("chat.attach.lightbox.copied"));
    } catch (error) { setSaveError(String(error)); }
  };
  const saveToComposer = async () => {
    if (!src) return;
    setSaveError(null);
    if (!editedSrc && !hasMarks && !isInlineImage(current.path)) {
      setImageContext(current.path, comments);
      attachToComposer([current.path], composerTarget);
      return;
    }
    const dataUrl = hasMarks || isInlineImage(current.path) ? flattenMarks() ?? src : src;
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
  /** Congela o quadro atual do vídeo como imagem editável. Devolve se deu. */
  const captureFrame = (): boolean => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return false;
    video.pause();
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setEditedSrc(canvas.toDataURL("image/png"));
    return true;
  };
  const stepVideoFrame = (step: -1 | 1) => {
    const video = videoRef.current;
    if (video) { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + step / 30)); }
  };
  const toggleVideoFullscreen = () => { const video = videoRef.current; if (video) void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(() => undefined); };
  const currentComments = commentsForMessage(comments);
  const surfaceButton = "inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-sm text-gray-700 dark:text-gray-100 hover:bg-gray-200/80 dark:hover:bg-white/10 disabled:opacity-40";
  const canAnnotate = isVideo || Boolean(src);
  const openInSidePanel = () => {
    if (!insideCwd(cwd, current.path)) return;
    useViewTabsStore.getState().openFile(cwd!, current.path);
    setRightPanel("files");
  };
  const toolLabel = (name: AnnotationTool) => t(`chat.attach.lightbox.tool.${name}`);
  const drawing = DRAW_TOOLS.some((item) => item.tool === tool);

  const editGroup = (inMenu: boolean) => <>
    <DockButton inMenu={inMenu} label={t("chat.attach.lightbox.removeBackground")} title={!canRemoveBackground ? t("chat.attach.lightbox.removeBackgroundUnavailable") : undefined} disabled={!canRemoveBackground || (isVideo && !editedSrc)} onClick={() => { void removeBackground(); }}><CutoutIcon className="h-4 w-4" /></DockButton>
    <DockButton inMenu={inMenu} label={t("chat.attach.lightbox.erase")} active={tool === "erase"} disabled={!canAnnotate} onClick={() => pickTool("erase")}><MagicEraseIcon className="h-4 w-4" /></DockButton>
    <DockButton inMenu={inMenu} label={t("chat.attach.lightbox.resize")} active={showResize} disabled={!showingImage} onClick={() => { setResizeWidth(String(imageRef.current?.naturalWidth ?? "")); setResizeHeight(String(imageRef.current?.naturalHeight ?? "")); setShowResize((value) => !value); setShowMore(false); }}><ResizeToolIcon className="h-4 w-4" /></DockButton>
    <DockButton inMenu={inMenu} label={t("chat.attach.lightbox.comment")} keyHint="C" active={tool === "comment"} disabled={!canAnnotate} onClick={() => pickTool("comment")}><CommentToolIcon className="h-4 w-4" /></DockButton>
  </>;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("chat.attach.lightbox.label", { index: index + 1, count: images.length, name: current.name })}
      onKeyDown={onKeyDown} onWheel={(event) => {
        const overImage = event.target instanceof HTMLElement && Boolean(event.target.closest("main")) && !isVideo;
        if (overImage || event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom((value) => Math.min(4, Math.max(0.2, value - Math.sign(event.deltaY) * 0.08))); }
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-[10060] flex flex-col bg-surface-1/85 text-gray-900 backdrop-blur-xl dark:bg-gray-950/75 dark:text-white motion-reduce:transition-none">
      <header data-tauri-drag-region className={`z-10 flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-gray-200/60 bg-surface-1/60 pr-3 dark:border-white/10 dark:bg-gray-950/50 ${IS_MAC ? "pl-[84px]" : "pl-3"}`}>
        <label className="relative min-w-0">
          <span className="sr-only">{t("chat.attach.lightbox.filter")}</span>
          <select className={`${surfaceButton} cursor-pointer bg-transparent`} value={filter} onChange={(event) => {
            const nextFilter = event.target.value as MediaFilter;
            setFilter(nextFilter);
            const matching = filterMedia(images.map((image) => ({ ...image, kind: image.kind ?? "image" })), nextFilter);
            if (!matching.some((image) => image.path === current.path) && matching[0]) onIndex(images.findIndex((image) => image.path === matching[0]!.path));
          }}>
            <option value="image">{t("chat.attach.lightbox.images")}</option><option value="video">{t("chat.attach.lightbox.videos")}</option><option value="all">{t("chat.attach.lightbox.all")}</option>
          </select>
        </label>
        <div className="flex items-center gap-0.5">
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomOut")} title={t("chat.attach.lightbox.zoomOut")} onClick={() => setZoom((value) => Math.max(0.2, value - 0.1))}><MinusIcon className="h-4 w-4" /></button>
          <button type="button" className={`${surfaceButton} min-w-14 tabular-nums`} onClick={() => setZoom(1)} aria-label={t("chat.attach.lightbox.zoomReset")} title={t("chat.attach.lightbox.zoomReset")}>{Math.round(zoom * 100)}%</button>
          <button type="button" className={surfaceButton} aria-label={t("chat.attach.lightbox.zoomIn")} title={t("chat.attach.lightbox.zoomIn")} onClick={() => setZoom((value) => Math.min(4, value + 0.1))}><PlusIcon className="h-4 w-4" /></button>
          <button type="button" className={surfaceButton} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label={t("chat.attach.lightbox.fit")} title={t("chat.attach.lightbox.fit")}><FitIcon className="h-4 w-4" /></button>
          <span className="mx-1 h-5 w-px bg-gray-300 dark:bg-white/15" aria-hidden />
          <button type="button" className={surfaceButton} onClick={download} aria-label={t("chat.attach.lightbox.download")} title={t("chat.attach.lightbox.download")}><DownloadIcon className="h-4 w-4" /></button>
          <details className="relative">
            <summary className={`${surfaceButton} cursor-pointer list-none gap-1`}>{t("chat.attach.lightbox.open")} <ChevronDownIcon className="h-4 w-4" /></summary>
            <div className="absolute right-0 top-full z-30 mt-1 flex min-w-48 flex-col rounded-lg border border-gray-200 bg-surface-1 p-1 shadow-xl dark:border-white/10 dark:bg-gray-900">
              <button type="button" disabled={isInlineImage(current.path)} className="rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40" onClick={() => { void openPath(current.path).catch(console.error); }}>{t("chat.attach.lightbox.openDefault")}</button>
              <button type="button" disabled={isInlineImage(current.path)} className="rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-40" onClick={() => { void revealItemInDir(current.path).catch(console.error); }}>{t("chat.attach.lightbox.reveal")}</button>
            </div>
          </details>
          <button type="button" className={surfaceButton} disabled={!insideCwd(cwd, current.path)} onClick={openInSidePanel} aria-label={t("chat.attach.lightbox.sidePanel")} title={t("chat.attach.lightbox.sidePanel")}><PanelRightIcon className="h-4 w-4" /></button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("chat.attach.lightbox.close")} title={t("chat.attach.lightbox.close")} className={surfaceButton}><XIcon className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6 pb-24" onPointerDown={(event) => { if (zoom > 1 && tool === "view") { const start = { x: event.clientX, y: event.clientY, offset }; const move = (e: PointerEvent) => setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y }); const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); } }}>
          {images.length > 1 && <button type="button" onClick={() => goVisible(-1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) <= 0} aria-label={t("chat.attach.lightbox.prev")} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 disabled:opacity-30 dark:bg-white/10"><ChevronLeftIcon className="h-5 w-5" /></button>}
          {showingImage ? <div className="relative flex max-h-full max-w-full items-center justify-center" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
            <img ref={imageRef} src={src!} alt={current.name} draggable={false} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })} className="max-h-[calc(100vh-13rem)] max-w-[calc(100vw-12rem)] select-none rounded-lg object-contain shadow-2xl" />
            {[...marks, ...(draft ? [draft] : [])].filter((mark): mark is BoxMark => "from" in mark && mark.kind === "blur").map((mark, i) => { const box = boxOf(mark.from, mark.to); return <span key={`blur-${i}`} aria-hidden className="pointer-events-none absolute backdrop-blur-md" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />; })}
            <svg viewBox={`0 0 ${natural.width} ${natural.height}`} preserveAspectRatio="none" aria-label={t("chat.attach.lightbox.markLayer")} className={`absolute inset-0 h-full w-full touch-none ${tool === "view" ? "pointer-events-none" : tool === "eraser" ? "cursor-cell" : tool === "text" ? "cursor-text" : "cursor-crosshair"}`}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
              {[...marks, ...(draft ? [draft] : [])].map((mark, i) => <MarkShape key={`mark-${i}`} mark={mark} width={natural.width} height={natural.height} />)}
              {[...eraseStrokes, ...(eraseDraft ? [eraseDraft] : [])].map((stroke, i) => <polyline key={`erase-${i}`} points={stroke.map((p) => `${p.x * natural.width},${p.y * natural.height}`).join(" ")} fill="none" stroke="var(--color-red-500)" strokeOpacity=".55" strokeWidth={Math.max(0.006, strokeWidth * 3) * natural.width} strokeLinecap="round" strokeLinejoin="round" />)}
              {commentSelection && (() => { const box = boxOf(commentSelection.start, commentSelection.end); return <rect x={box.x * natural.width} y={box.y * natural.height} width={box.width * natural.width} height={box.height * natural.height} fill="var(--color-accent-500)" fillOpacity=".16" stroke="var(--color-accent-500)" strokeWidth={0.003 * natural.width} />; })()}
            </svg>
            {comments.map((comment, i) => <span key={i} className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white shadow" style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }}>{i + 1}</span>)}
            {textDraft && <form className="absolute" style={{ left: `${textDraft.at.x * 100}%`, top: `${textDraft.at.y * 100}%` }} onSubmit={(e) => { e.preventDefault(); submitText(); }}>
              <input autoFocus onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTextDraft(null); } }} value={textDraft.text} onChange={(e) => setTextDraft({ ...textDraft, text: e.target.value })} onBlur={submitText} aria-label={t("chat.attach.lightbox.textPrompt")} placeholder={t("chat.attach.lightbox.textPrompt")} className="min-w-40 rounded-md border border-white/20 bg-gray-950/80 px-2 py-1 font-semibold text-white outline-none" style={{ color: colorVar(color), fontSize: `${Math.max(14, Math.round(strokeWidth * (imageRef.current?.getBoundingClientRect().width ?? 600) * 7))}px` }} />
            </form>}
          </div> : isVideo ? <div className="flex max-h-full max-w-full flex-col items-center gap-3"><video ref={videoRef} src={convertFileSrc(current.path)} controls playsInline className="max-h-[calc(100vh-16rem)] max-w-[calc(100vw-12rem)] rounded-lg shadow-2xl" /><div className="flex items-center gap-1 rounded-full border border-gray-200/70 bg-surface-1/80 p-1 shadow dark:border-white/10 dark:bg-gray-900/80"><button type="button" className={surfaceButton} onClick={() => stepVideoFrame(-1)} aria-label={t("chat.attach.lightbox.framePrevious")} title={t("chat.attach.lightbox.framePrevious")}>−1</button><button type="button" className={surfaceButton} onClick={() => stepVideoFrame(1)} aria-label={t("chat.attach.lightbox.frameNext")} title={t("chat.attach.lightbox.frameNext")}>+1</button><label className="flex items-center gap-1 px-2 text-xs">{t("chat.attach.lightbox.speed")}<select aria-label={t("chat.attach.lightbox.speed")} defaultValue="1" className="rounded-md bg-transparent px-1 py-1" onChange={(event) => { if (videoRef.current) videoRef.current.playbackRate = Number(event.target.value); }}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button type="button" className={surfaceButton} onClick={toggleVideoFullscreen} aria-label={t("chat.attach.lightbox.fullscreen")} title={t("chat.attach.lightbox.fullscreen")}><MaximizeIcon className="h-4 w-4" /></button><button type="button" className={surfaceButton} onClick={() => { captureFrame(); }}>{t("chat.attach.lightbox.captureFrame")}</button></div></div> : <p className="text-sm text-gray-500 dark:text-white/60">{missing ? t("chat.attach.missing") : t("chat.attach.loading")}</p>}
          {images.length > 1 && <button type="button" onClick={() => goVisible(1)} disabled={visibleMedia.findIndex((item) => item.path === current.path) < 0 || visibleMedia.findIndex((item) => item.path === current.path) === visibleMedia.length - 1} aria-label={t("chat.attach.lightbox.next")} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/10 p-3 hover:bg-gray-900/20 disabled:opacity-30 dark:bg-white/10"><ChevronRightIcon className="h-5 w-5" /></button>}
        </main>
        {/* Depois do <main> no DOM (a primeira <img> do diálogo é a imagem aberta), mas à esquerda na tela. */}
        {visibleMedia.length > 1 && <aside aria-label={t("chat.attach.lightbox.gallery")} className="order-first z-10 flex w-[5.5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-gray-200/60 p-2 [scrollbar-width:thin] dark:border-white/10">
          {visibleMedia.map((image) => { const i = images.findIndex((item) => item.path === image.path); return <GalleryThumb key={image.path} image={image} active={i === index} label={t("chat.attach.lightbox.goTo", { name: image.name })} onClick={() => onIndex(i)} />; })}
        </aside>}
      </div>
      <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 flex-col-reverse items-center gap-2">
        <div role="toolbar" aria-label={t("chat.attach.lightbox.tools")} onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button,input,select")) return; setDragDock(true); dockStart.current = { x: e.clientX, y: e.clientY, left: dockPosition.x, top: dockPosition.y }; e.currentTarget.setPointerCapture?.(e.pointerId); }} onPointerMove={(e) => { if (dragDock && dockStart.current) setDockPosition({ x: dockStart.current.left + e.clientX - dockStart.current.x, y: dockStart.current.top + e.clientY - dockStart.current.y }); }} onPointerUp={() => setDragDock(false)}
          className="pointer-events-auto relative flex h-11 items-center gap-0.5 whitespace-nowrap rounded-full border border-white/10 bg-gray-950/80 px-1.5 text-white shadow-2xl backdrop-blur-xl" style={{ transform: `translate(${dockPosition.x}px, ${dockPosition.y}px)` }}>
          <span className="flex h-8 w-5 cursor-grab items-center justify-center text-white/40 active:cursor-grabbing" aria-hidden><GripIcon className="h-3.5 w-3.5" /></span>
          {DRAW_TOOLS.map((item) => { const Icon = item.icon; return <DockButton key={item.tool} label={toolLabel(item.tool)} keyHint={item.key} active={tool === item.tool} disabled={!canAnnotate} onClick={() => pickTool(item.tool)}><Icon className="h-4 w-4" /></DockButton>; })}
          <div className="relative">
            <DockButton label={t("chat.attach.lightbox.style")} active={showStyle} disabled={!canAnnotate} onClick={() => { setShowStyle((value) => !value); setShowMore(false); }}>
              <span className="h-4 w-4 rounded-full ring-2 ring-white/70" style={{ background: colorVar(color) }} />
            </DockButton>
            {showStyle && <div className="absolute bottom-full left-1/2 mb-3 flex -translate-x-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-gray-950/90 p-3 shadow-2xl backdrop-blur-xl">
              <div className="flex gap-1.5" role="radiogroup" aria-label={t("chat.attach.lightbox.color")}>
                {ANNOTATION_COLORS.map((option) => <button key={option} type="button" role="radio" aria-checked={color === option} aria-label={t(`chat.attach.lightbox.colors.${option}`)} title={t(`chat.attach.lightbox.colors.${option}`)} onClick={() => setColor(option)} className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-gray-950 ${color === option ? "ring-2 ring-white" : "ring-1 ring-white/25"}`} style={{ background: colorVar(option) }} />)}
              </div>
              <label className="flex items-center gap-2 text-xs text-white/70">{t("chat.attach.lightbox.strokeWidth")}<input type="range" min="0.002" max="0.02" step="0.001" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} aria-label={t("chat.attach.lightbox.strokeWidth")} className="h-1 w-28 accent-accent-500" /></label>
            </div>}
          </div>
          <Divider />
          {narrow ? <div className="relative">
            <DockButton label={t("chat.attach.lightbox.more")} active={showMore} onClick={() => { setShowMore((value) => !value); setShowStyle(false); }}><MoreHorizontalIcon className="h-4 w-4" /></DockButton>
            {showMore && <div role="menu" className="absolute bottom-full left-1/2 mb-3 flex min-w-56 -translate-x-1/2 flex-col rounded-2xl border border-white/10 bg-gray-950/90 p-1 shadow-2xl backdrop-blur-xl">{editGroup(true)}</div>}
          </div> : editGroup(false)}
          <Divider />
          <DockButton label={t("chat.attach.lightbox.saveCopy")} disabled={!showingImage || isInlineImage(current.path)} onClick={() => { void saveCopy(); }}><SaveCopyIcon className="h-4 w-4" /></DockButton>
          <DockButton label={t("chat.attach.lightbox.copyImage")} keyHint={IS_MAC ? "⌘C" : "Ctrl+C"} disabled={!showingImage} onClick={() => { void copyToClipboard(); }}><ClipboardToolIcon className="h-4 w-4" /></DockButton>
          <DockButton label={t("chat.attach.lightbox.attachResult")} disabled={!showingImage} onClick={() => { void saveToComposer().catch(console.error); }}><FilePlusIcon className="h-4 w-4" /></DockButton>
          <Divider />
          <DockButton label={t("chat.attach.lightbox.undo")} keyHint={IS_MAC ? "⌘Z" : "Ctrl+Z"} disabled={past.length === 0} onClick={undo}><UndoIcon2 className="h-4 w-4" /></DockButton>
          <DockButton label={t("chat.attach.lightbox.redo")} keyHint={IS_MAC ? "⇧⌘Z" : "Ctrl+Shift+Z"} disabled={future.length === 0} onClick={redo}><RedoIcon className="h-4 w-4" /></DockButton>
          <DockButton label={t("chat.attach.lightbox.clear")} disabled={marks.length + eraseStrokes.length + comments.length === 0} onClick={clearAll}><TrashIcon className="h-4 w-4" /></DockButton>
          {tool === "erase" && <button type="button" className="ml-1 h-8 rounded-full bg-accent-500 px-3 text-sm font-medium text-white disabled:opacity-40" onClick={() => { void sendEraseRequest().catch((error) => setSaveError(String(error))); }} disabled={eraseStrokes.length === 0}>{t("chat.attach.lightbox.sendEraseRequest")}</button>}
        </div>
        {(drawing || tool === "comment" || tool === "erase") && !commentDraft && <p className="pointer-events-none rounded-full bg-gray-950/70 px-3 py-1 text-xs text-white/80 backdrop-blur">{t(`chat.attach.lightbox.hint.${tool}`)}</p>}
        {commentDraft && <form className="pointer-events-auto flex items-center gap-2 rounded-2xl bg-surface-1 p-2 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); if (commentDraft.text.trim()) setComments((old) => { const next = [...old, commentSelection ? commentFromSelection(commentSelection.start, commentSelection.end, commentDraft.text.trim()) : { ...commentDraft.point, text: commentDraft.text.trim() }]; setImageContext(current.path, next); return next; }); setCommentDraft(null); setCommentSelection(null); setTool("view"); }}>
          <input autoFocus value={commentDraft.text} onChange={(e) => setCommentDraft({ ...commentDraft, text: e.target.value })} aria-label={t("chat.attach.lightbox.commentText")} placeholder={t("chat.attach.lightbox.commentText")} className="rounded-md bg-gray-100 px-3 py-2 text-sm dark:bg-white/10" />
          <button className="rounded-md bg-accent-500 px-3 py-2 text-sm text-white" type="submit">{t("chat.attach.lightbox.saveComment")}</button>
        </form>}
        {showResize && <form className="pointer-events-auto flex items-end gap-2 rounded-2xl bg-surface-1 p-3 shadow-xl dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); resizeImage("width"); }}>
          <label className="text-xs">{t("chat.attach.lightbox.width")}<input type="number" min="1" value={resizeWidth} onChange={(e) => { const width = e.target.value; setResizeWidth(width); const image = imageRef.current; if (image && Number(width) > 0) setResizeHeight(String(Math.round(Number(width) * image.naturalHeight / image.naturalWidth))); }} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <label className="text-xs">{t("chat.attach.lightbox.height")}<input type="number" min="1" value={resizeHeight} onChange={(e) => { const height = e.target.value; setResizeHeight(height); const image = imageRef.current; if (image && Number(height) > 0) setResizeWidth(String(Math.round(Number(height) * image.naturalWidth / image.naturalHeight))); }} className="mt-1 block w-24 rounded bg-gray-100 p-2 text-sm dark:bg-white/10" /></label>
          <button type="submit" className="rounded bg-accent-500 px-3 py-2 text-sm text-white">{t("chat.attach.lightbox.applyResize")}</button>
          <div className="flex gap-1">{[25, 50, 75, 100].map((percent) => <button key={percent} type="button" className="rounded px-2 py-2 text-xs hover:bg-gray-100 dark:hover:bg-white/10" onClick={() => { const image = imageRef.current; if (image) { commitResize({ width: Math.max(1, Math.round(image.naturalWidth * percent / 100)) }); } }}>{percent}%</button>)}</div>
        </form>}
        {currentComments && <p className="pointer-events-auto max-w-[70vw] whitespace-pre-line rounded-lg bg-surface-1/90 px-3 py-2 text-xs shadow dark:bg-gray-900/90">{currentComments}</p>}
        {notice && <p role="status" className="pointer-events-auto max-w-[70vw] rounded-full bg-gray-950/80 px-3 py-1.5 text-xs text-white shadow backdrop-blur">{notice}</p>}
        {saveError && <p role="alert" className="pointer-events-auto max-w-[70vw] rounded-lg bg-surface-1/90 px-3 py-2 text-xs text-red-700 shadow dark:bg-gray-900/90 dark:text-red-300">{t("chat.attach.lightbox.saveError", { error: saveError })}</p>}
        <button type="button" onClick={applyMarks} className="sr-only" aria-label={t("chat.attach.lightbox.flattenMarks")}>{t("chat.attach.lightbox.flattenMarks")}</button>
      </div>
    </div>,
    document.body,
  );
}

/** Botão de ícone da dock: 32px, tooltip com atalho, estado ativo destacado. No menu "⋯" vira linha com rótulo. */
function DockButton({ label, keyHint, title, active = false, disabled = false, inMenu = false, onClick, children }: { label: string; keyHint?: string; title?: string; active?: boolean; disabled?: boolean; inMenu?: boolean; onClick: () => void; children: ReactNode }) {
  const tooltip = title ?? (keyHint ? `${label} (${keyHint})` : label);
  if (inMenu) return <button type="button" role="menuitem" disabled={disabled} onClick={onClick} title={tooltip} className={`flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-left text-sm disabled:opacity-35 ${active ? "bg-white/15 text-white" : "text-white/85 hover:bg-white/10"}`}>{children}<span className="truncate">{label}</span></button>;
  return <button type="button" aria-label={label} aria-pressed={active || undefined} title={tooltip} disabled={disabled} onClick={onClick}
    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 ${active ? "bg-white/20 text-white ring-1 ring-white/25" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>{children}</button>;
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-white/15" aria-hidden />;
}

/** Uma marca desenhada no SVG, em pixels da imagem (o SVG usa o tamanho natural como viewBox). */
function MarkShape({ mark, width, height }: { mark: Annotation; width: number; height: number }) {
  const stroke = colorVar(mark.color);
  const lineWidth = Math.max(2, mark.width * width);
  const px = (p: MarkPoint) => ({ x: p.x * width, y: p.y * height });
  if (mark.kind === "pen" || mark.kind === "highlighter") {
    const highlight = mark.kind === "highlighter";
    return <polyline points={mark.points.map((p) => `${p.x * width},${p.y * height}`).join(" ")} fill="none" stroke={stroke} strokeOpacity={highlight ? 0.35 : 1} strokeWidth={highlight ? lineWidth * 4 : lineWidth} strokeLinecap={highlight ? "square" : "round"} strokeLinejoin="round" />;
  }
  if (mark.kind === "arrow") {
    const a = px(mark.from), b = px(mark.to);
    const [l, r] = arrowHead(a, b, lineWidth * 4);
    return <g><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={lineWidth} strokeLinecap="round" /><polygon points={`${b.x},${b.y} ${l.x},${l.y} ${r.x},${r.y}`} fill={stroke} /></g>;
  }
  if (mark.kind === "rect" || mark.kind === "ellipse" || mark.kind === "blur") {
    const box = boxOf(mark.from, mark.to);
    const x = box.x * width, y = box.y * height, w = box.width * width, h = box.height * height;
    if (mark.kind === "rect") return <rect x={x} y={y} width={w} height={h} fill="none" stroke={stroke} strokeWidth={lineWidth} strokeLinejoin="round" />;
    if (mark.kind === "ellipse") return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="none" stroke={stroke} strokeWidth={lineWidth} />;
    return <rect x={x} y={y} width={w} height={h} fill="none" stroke="var(--color-white)" strokeOpacity=".5" strokeDasharray={`${lineWidth * 2} ${lineWidth * 2}`} strokeWidth={Math.max(1, lineWidth / 2)} />;
  }
  if (mark.kind === "text") {
    const size = Math.max(14, mark.width * width * 7);
    const at = px(mark.at);
    return <text x={at.x} y={at.y} dominantBaseline="hanging" fontSize={size} fontWeight={600} fill={stroke} stroke={mark.color === "white" ? "var(--color-gray-950)" : "var(--color-white)"} strokeWidth={Math.max(2, size / 6)} paintOrder="stroke" style={{ fontFamily: "system-ui, sans-serif" }}>{mark.text}</text>;
  }
  if (mark.kind !== "step") return null;
  const radius = Math.max(14, width / 60);
  const at = px(mark.at);
  const ink = mark.color === "white" || mark.color === "yellow-400" ? "var(--color-gray-950)" : "var(--color-white)";
  return <g><circle cx={at.x} cy={at.y} r={radius} fill={stroke} /><text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontSize={radius * 1.1} fontWeight={700} fill={ink} style={{ fontFamily: "system-ui, sans-serif" }}>{mark.n}</text></g>;
}

/** O índice do texto de cima que o ponto toca (caixa aproximada do texto), ou -1. */
function textHitIndex(marks: Annotation[], p: MarkPoint, aspect: number): number {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i]!;
    if (mark.kind !== "text") continue;
    const height = Math.max(0.02, mark.width * 7);
    const width = Math.max(0.04, mark.text.length * height * 0.6 * aspect);
    if (p.x >= mark.at.x - 0.01 && p.x <= mark.at.x + width && p.y >= mark.at.y - 0.01 && p.y <= mark.at.y + height) return i;
  }
  return -1;
}

/** Miniatura real da coluna: só carrega quando aparece na tela; vídeo mostra o primeiro quadro. Rola até a atual. */
function GalleryThumb({ image, active, label, onClick }: { image: LightboxImage; active: boolean; label: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (active) ref.current?.scrollIntoView?.({ block: "nearest" }); }, [active]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <button ref={ref} type="button" onClick={onClick} aria-label={label} title={image.name} aria-current={active ? "true" : undefined}
    className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-gray-200 ring-2 ring-offset-2 ring-offset-surface-1 transition dark:bg-white/10 dark:ring-offset-gray-950 ${active ? "ring-accent-500" : "ring-transparent opacity-60 hover:opacity-100"}`}>
    {visible ? image.kind === "video" ? <>
      <video src={`${convertFileSrc(image.path)}#t=0.1`} preload="metadata" muted playsInline className="pointer-events-none h-full w-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center"><span className="rounded-full bg-gray-950/60 p-1 text-white"><PlayIcon className="h-3.5 w-3.5" /></span></span>
    </> : <ThumbImage path={image.path} preview={image.preview} /> : null}
  </button>;
}

function ThumbImage({ path, preview }: { path: string; preview: string | null }) {
  const { src } = useImagePreview(path, preview);
  return src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" /> : null;
}

function isInlineImage(path: string): boolean {
  return /^data:image\//i.test(path);
}
