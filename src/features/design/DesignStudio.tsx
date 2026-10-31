import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { designApi, type DesignComment } from "@/features/canvas/design/designApi";
import { resolveOwner } from "@/features/canvas/design/owner";
import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";
import { insertIntoComposer } from "@/features/chat/store";
import { useMissionIndex } from "@/features/missions/groups";
import { useTabsStore } from "@/features/tabs/store";
import { AlertaToast } from "@/shared/ui/alerts";
import { appConfirm } from "@/shared/ui/appConfirm";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";

import { clampAnchor, formatSendText, parentSelector, pinPosition, sendPayload, threadsOf } from "./anchor";
import { ArtboardFrame, type FrameHandlers, type StudioBoard } from "./ArtboardFrame";
import {
  boardFitBox, clampScale, DEFAULT_CAMERA, fitCamera, glideDuration, lerpCamera, liveBoards,
  panBy, readCamera, readLastPage, stepZoom, toScreen, toWorld, unionBox, wheelCamera, writeCamera, zoomAt,
  type Box, type Camera,
} from "./camera";
import { CommentComposer, CommentPins, CommentThread, popoverPlacement, type PinItem } from "./CommentLayer";
import { exportHtml, printBoard } from "./exportBoard";
import { parseFrameMessage, postToFrame, resolveNavTarget, studioSrcdoc, type FrameMessage, type FrameMode, type FrameRect, type TreeNode } from "./frameBridge";
import { createHistory, idRef, type HistoryEntry } from "./history";
import { isVersionConflict, removeElement, replaceInner } from "./htmlEdit";
import { QuickBar, quickBarPlacement } from "./QuickBar";
import { ShapeView } from "./ShapeView";
import { CLICK_SIZE, isShapeKind, normalizeStroke, parseShapeData, resizeShape, shapeBox, thinPoints, type Shape, type ShapeData, type ShapeKind } from "./shapes";
import { PANEL_SIZE, StudioPanel, type PanelTab, type SaveOutcome } from "./StudioPanel";
import { writeTweaks } from "./tweaks";
import { marqueeHits, nextBoardSlot, normalizeRect, resizeFromCorner, snapMove, unstack, MIN_BOARD, type Corner, type Guide } from "./snap";
import { StudioNote, type StudioNoteItem } from "./StudioNote";
import {
  BOARD_DEFAULT, boardOrdinal, cycleBoard, isDrawTool, isEditableTarget, isShapeTool, keyAction, modSymbol, nextName, nextTool, NOTE_COLORS, NOTE_DEFAULT,
  openCommand, type DrawTool, type KeyLike, type ShapeTool, type Tool,
} from "./studioModel";
import { ExpandIcon } from "./studioIcons";
import { StudioToolbar } from "./StudioToolbar";
import { useDesignDetail } from "./useDesignDetail";
import { bumpedBoards, buildViewState, createDebouncer, fitViewState, sameViewState, VIEW_DEBOUNCE_MS, versionsOf, type DesignViewState, type PickedElement } from "./viewState";

/** O pedido de abertura (ponte `design.open` ou rota): ir a esta página e enquadrar esta prancheta. */
export interface StudioRequest { artboardId?: string | null; pageId?: string | null; seq?: number }

type ItemType = "board" | "note" | "shape";
type Pt = { x: number; y: number };
type Drag =
  | { kind: "pan"; last: { x: number; y: number } }
  | { kind: "draw"; points: Pt[] }
  | { kind: "shape"; tool: ShapeTool; start: Pt; cur: Pt }
  | { kind: "shapeResize"; id: string; corner: Corner; start: Box; startPt: Pt }
  | { kind: "marquee"; start: { x: number; y: number }; additive: boolean; base: { boards: string[]; notes: string[] } }
  | { kind: "move"; start: { x: number; y: number }; items: Array<{ id: string; type: ItemType; box: Box }>; primary: string; alt: boolean; moved: boolean }
  | { kind: "resize"; id: string; corner: Corner; start: Box; startPt: { x: number; y: number } }
  | { kind: "create"; start: { x: number; y: number }; cur: { x: number; y: number } };

interface DragUi { marquee?: Box; guides?: Guide[]; ghosts?: Box[]; create?: Box; stroke?: Pt[]; shape?: { kind: ShapeTool; x: number; y: number; w: number; h: number } }
interface Draft { boardId: string; anchor: string | null; pointX: number; pointY: number; label: string; text: string; wx: number; wy: number }
interface Menu { x: number; y: number; items: ContextMenuItem[] }

const AGENT_FLASH_MS = 2000;
const SELF_EDIT_MS = 2000;
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const session = () => { try { return window.sessionStorage; } catch { return null; } };

/**
 * A tela de Design: barra de 40 px, o canvas com pan/zoom e as pranchetas em iframe isolado, notas,
 * comentários ancorados, o modo focado (protótipo clicável) e o cursor do agente. A mesma tela serve a
 * aba Design do painel do chat (`host="chat"`) e a rota de tela cheia `/design/:id` (`host="page"`).
 */
export function DesignStudio({ designId, host, request, leading, trailing, padRight }: {
  designId: string;
  host: "chat" | "page";
  request?: StudioRequest | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  padRight?: boolean;
}) {
  const { t } = useTranslation();
  const { detail, error, loading, reload } = useDesignDetail(designId);
  const mod = modSymbol(typeof navigator !== "undefined" ? navigator.platform : "");
  const fail = useCallback((e: unknown) => AlertaToast(t("canvas.design.title"), String(e), "error", 6000), [t]);

  // ---------- página ----------
  const [pageId, setPageId] = useState<string | null>(() => request?.pageId ?? readLastPage(session(), designId));
  const pages = useMemo(() => detail?.pages ?? [], [detail]);
  const page = pages.find((p) => p.id === pageId) ?? pages[0] ?? null;

  // ---------- estado de interação ----------
  const [tool, setTool] = useState<Tool>("select");
  const [space, setSpace] = useState(false);
  const [cam, setCam] = useState<Camera>(DEFAULT_CAMERA);
  const camRef = useRef(cam);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selBoards, setSelBoards] = useState<string[]>([]);
  const [selNotes, setSelNotes] = useState<string[]>([]);
  const [picked, setPicked] = useState<PickedElement[]>([]);
  const [geo, setGeo] = useState<Record<string, Box>>({});
  const [dragUi, setDragUi] = useState<DragUi | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<{ id: string; fit: "fill" | "fit" } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const [rects, setRects] = useState<Record<string, FrameRect | null>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [agentFlash, setAgentFlash] = useState<Record<string, true>>({});
  const [selShapes, setSelShapes] = useState<string[]>([]);
  const [lastDraw, setLastDraw] = useState<DrawTool>("pencil");
  const [lastShape, setLastShape] = useState<ShapeTool>("rect");
  const [guides, setGuides] = useState(false);
  const [panelOpen, setPanelOpen] = useState(host === "page");
  const [panelTab, setPanelTab] = useState<PanelTab>("props");
  const [panelWidth, setPanelWidth] = useState<number>(PANEL_SIZE.initial);
  const [rootW, setRootW] = useState(0);
  const [playing, setPlaying] = useState<Set<string>>(() => new Set());
  const [following, setFollowing] = useState(false);
  const [lastBump, setLastBump] = useState<string | null>(null);
  const [tree, setTree] = useState<{ boardId: string; nodes: TreeNode[] } | null>(null);
  const [elRect, setElRect] = useState<FrameRect | null>(null);
  const [editingShape, setEditingShape] = useState<string | null>(null);
  const [dataOver, setDataOver] = useState<Record<string, ShapeData>>({});
  const [pen, setPen] = useState<Pt[]>([]);
  const [announce, setAnnounce] = useState("");
  const history = useMemo(() => createHistory(), [designId]);

  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const contentH = useRef<Record<string, number>>({});
  const drag = useRef<Drag | null>(null);
  const glide = useRef<number | null>(null);
  const gesture = useRef<{ scale: number; sx: number; sy: number } | null>(null);
  const active = useRef(host === "page");
  const selfUntil = useRef(0);
  const prevVersions = useRef<Record<string, number> | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renaming;

  // ---------- dados da página ----------
  const rawBoards = useMemo(() => (detail?.artboards ?? []).filter((a) => a.pageId === page?.id), [detail, page]);
  const stacked = useMemo(() => unstack(rawBoards.map((a) => ({ id: a.id, x: a.x, y: a.y, w: a.width, h: a.height }))), [rawBoards]);
  const boards: StudioBoard[] = useMemo(() => {
    const pos = new Map(stacked.boards.map((b) => [b.id, b]));
    return rawBoards.map((a) => {
      const base = pos.get(a.id)!;
      const g = geo[a.id];
      return { id: a.id, title: a.title, html: a.html, version: a.version, radius: a.radius ?? 0, x: g?.x ?? base.x, y: g?.y ?? base.y, w: g?.w ?? base.w, h: g?.h ?? base.h };
    });
  }, [rawBoards, stacked, geo]);
  const notes: StudioNoteItem[] = useMemo(() => (detail?.notes ?? []).filter((n) => n.pageId === page?.id).map((n) => {
    const g = geo[n.id];
    return { id: n.id, text: n.text ?? "", color: n.color ?? null, x: g?.x ?? n.x, y: g?.y ?? n.y, w: g?.w ?? n.w ?? NOTE_DEFAULT.w, h: g?.h ?? n.h ?? NOTE_DEFAULT.h };
  }), [detail, page, geo]);
  const boardById = useMemo(() => new Map(boards.map((b) => [b.id, b])), [boards]);
  const shapes: Shape[] = useMemo(() => (detail?.shapes ?? []).filter((x) => x.pageId === page?.id).flatMap((x) => {
    if (!isShapeKind(x.kind)) return [];
    const g = geo[x.id];
    return [{ id: x.id, kind: x.kind, x: g?.x ?? x.x, y: g?.y ?? x.y, w: g?.w ?? x.w, h: g?.h ?? x.h, data: dataOver[x.id] ?? parseShapeData(x.data) }];
  }), [detail, page, geo, dataOver]);
  const shapeBoxes = useMemo(() => shapes.map((x) => ({ id: x.id, ...shapeBox(x) })), [shapes]);

  // ---------- dono e agente ----------
  const allTabs = useTabsStore((s) => s.tabs);
  const missionIndex = useMissionIndex();
  const owner = useMemo(() => {
    if (!detail) return null;
    const id = resolveOwner(detail.design, allTabs.map((x) => ({ id: x.id, title: x.title })), missionIndex);
    return allTabs.find((x) => x.id === id) ?? null;
  }, [detail, allTabs, missionIndex]);
  const agentName = owner?.agentLabel || owner?.title || t("design.studio.agent");

  // ---------- câmera ----------
  const setCamera = useCallback((c: Camera) => { camRef.current = c; setCam(c); }, []);
  const stopGlide = useCallback(() => { if (glide.current !== null) cancelAnimationFrame(glide.current); glide.current = null; }, []);
  const glideTo = useCallback((target: Camera, animate = true) => {
    stopGlide();
    const from = camRef.current;
    const ms = animate ? glideDuration(from, target, size.w, size.h, reducedMotion()) : 0;
    if (ms === 0) return setCamera(target);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setCamera(k >= 1 ? target : lerpCamera(from, target, k, size.w, size.h));
      glide.current = k >= 1 ? null : requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }, [size, setCamera, stopGlide]);
  const fitAll = useCallback((animate = true) => {
    const box = unionBox([...boards, ...notes, ...shapeBoxes]);
    glideTo(fitCamera(box, size.w, size.h, 0), animate);
  }, [boards, notes, shapeBoxes, size, glideTo]);
  const fitBoard = useCallback((id: string, animate = true) => {
    const b = boardById.get(id);
    if (b) glideTo(fitCamera(boardFitBox(b), size.w, size.h, 0), animate);
  }, [boardById, size, glideTo]);
  // Mexer a câmera à mão desliga o "Seguir o agente".
  const zoomStep = useCallback((dir: 1 | -1) => { setFollowing(false); stopGlide(); glideTo(stepZoom(camRef.current, dir, size.w, size.h)); }, [size, glideTo, stopGlide]);
  const zoomPreset = useCallback((scale: number) => { setFollowing(false); glideTo(zoomAt(camRef.current, scale, size.w / 2, size.h / 2)); }, [size, glideTo]);

  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [focused === null]); // eslint-disable-line react-hooks/exhaustive-deps -- a superfície volta ao sair do modo focado

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootW(el.clientWidth));
    ro.observe(el);
    setRootW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // O pedido de abertura: muda de página e guarda a prancheta a enquadrar.
  const pendingFocus = useRef<string | null>(request?.artboardId ?? null);
  useEffect(() => {
    if (!request) return;
    if (request.pageId) setPageId(request.pageId);
    pendingFocus.current = request.artboardId ?? null;
    setFocused(null);
  }, [request?.seq, request?.artboardId, request?.pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !detail) return;
    const board = detail.artboards.find((a) => a.id === id);
    if (!board) { pendingFocus.current = null; return; }
    if (board.pageId !== page?.id) { setPageId(board.pageId); return; }
  }, [detail, page?.id, request?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // A câmera de cada página: lembrada no sessionStorage; sem memória (ou com uma prancheta pedida), enquadra.
  const initKey = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !page || size.w === 0) return;
    const key = `${designId}/${page.id}`;
    const want = pendingFocus.current && boardById.has(pendingFocus.current) ? pendingFocus.current : null;
    if (initKey.current === key && !want) return;
    const first = initKey.current !== key;
    initKey.current = key;
    if (want) {
      pendingFocus.current = null;
      setSelBoards([want]);
      fitBoard(want, !first);
      return;
    }
    const saved = readCamera(session(), designId, page.id);
    if (saved) setCamera(saved);
    else fitAll(false);
  }, [detail, page, size.w, designId, boardById, fitBoard, fitAll, setCamera]);

  useEffect(() => {
    if (!page || initKey.current !== `${designId}/${page.id}`) return;
    const id = setTimeout(() => writeCamera(session(), designId, page.id, cam), 250);
    return () => clearTimeout(id);
  }, [cam, designId, page]);

  // Trocar de página ou de design limpa o que era da anterior.
  useEffect(() => {
    setSelBoards([]); setSelNotes([]); setSelShapes([]); setPicked([]); setDraft(null); setThread(null); setFocused(null); setPinned(new Set());
    setPlaying(new Set()); setTree(null); setPen([]); setElRect(null);
  }, [designId, page?.id]);

  // ---------- virtualização ----------
  const liveKey = useMemo(() => {
    if (size.w === 0) return "";
    return [...liveBoards(boards, cam, size.w, size.h, { pinned })].sort().join("|");
  }, [boards, cam, size, pinned]);
  const live = useMemo(() => new Set(liveKey ? liveKey.split("|") : []), [liveKey]);

  // ---------- ações (sempre relendo, com erro visível) ----------
  const act = useCallback(async <T,>(p: Promise<T>, clear: string[] = []): Promise<T | null> => {
    selfUntil.current = Date.now() + SELF_EDIT_MS;
    try {
      const v = await p;
      await reload();
      return v;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      if (clear.length) setGeo((g) => { const n = { ...g }; for (const id of clear) delete n[id]; return n; });
    }
  }, [reload, fail]);

  // ---------- desfazer/refazer ----------
  const record = useCallback((e: HistoryEntry) => history.push(e), [history]);
  const geoApi = (type: ItemType, id: string, b: Partial<Box>) =>
    type === "board" ? designApi.updateArtboard(id, { x: b.x, y: b.y, width: b.w, height: b.h })
      : type === "note" ? designApi.updateNote(id, { x: b.x, y: b.y, w: b.w, h: b.h })
        : designApi.updateShape(id, { x: b.x, y: b.y, w: b.w, h: b.h });
  const undoRedo = useCallback(async (redo: boolean) => {
    selfUntil.current = Date.now() + SELF_EDIT_MS;
    try {
      const e = redo ? await history.redo() : await history.undo();
      if (!e) return;
      await reload();
      setAnnounce(t(redo ? "design.history.redone" : "design.history.undone", { what: t(`design.history.${e.label}`) }));
    } catch (e) {
      fail(e);
    }
  }, [history, reload, fail, t]);

  /** Grava uma criação e a entrada que a desfaz (apagar) e refaz (criar de novo, com id novo). */
  const createRecorded = useCallback(async (label: string, run: () => Promise<{ id?: string } | null>, remove: (id: string) => Promise<unknown>) => {
    const first = await act(run());
    const id = first?.id;
    if (!id) return null;
    const ref = idRef(id);
    record({ label, undo: () => remove(ref.current), redo: async () => { const r = await run(); if (r?.id) ref.current = r.id; } });
    return id;
  }, [act, record]);

  /** As pranchetas que o `unstack` deslocou só na tela viram posição gravada quando a pessoa mexe em algo. */
  const persistUnstacked = useCallback(() => {
    for (const id of stacked.moved) {
      const b = boardById.get(id);
      if (b) void act(designApi.updateArtboard(id, { x: Math.round(b.x), y: Math.round(b.y) }));
    }
  }, [stacked.moved, boardById, act]);

  const addBoardAt = useCallback(async (box: Box) => {
    if (!page) return;
    const title = nextName(t("design.studio.boardBase"), boards.map((b) => b.title));
    const args = { pageId: page.id, title, html: "", width: Math.round(box.w), height: Math.round(box.h), x: Math.round(box.x), y: Math.round(box.y) };
    const id = await createRecorded("create", async () => ({ id: (await designApi.addArtboard(args)).artboardId }), (x) => designApi.deleteArtboard(x));
    if (id) { setSelBoards([id]); setSelNotes([]); setSelShapes([]); }
  }, [page, boards, t, createRecorded]);

  const addShape = useCallback(async (kind: ShapeKind, box: { x: number; y: number; w: number; h: number }, data: Partial<ShapeData>) => {
    if (!page) return null;
    const args = { pageId: page.id, kind, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), data: { stroke: "black", fill: null, width: 2, ...data } };
    const id = await createRecorded("create", async () => ({ id: (await designApi.addShape(args)).shapeId }), (x) => designApi.deleteShape(x));
    if (id) { setSelShapes([id]); setSelBoards([]); setSelNotes([]); }
    return id;
  }, [page, createRecorded]);

  const duplicate = useCallback((ids: string[]) => {
    for (const id of ids) {
      const b = boardById.get(id);
      if (!b) continue;
      const at = { x: Math.round(b.x + b.w + 80), y: Math.round(b.y) };
      void createRecorded("duplicate", async () => ({ id: (await designApi.duplicateArtboard(id, at)).artboardId }), (x) => designApi.deleteArtboard(x));
    }
  }, [boardById, createRecorded]);

  const removeSelection = useCallback(async (boardIds: string[], noteIds: string[], shapeIds: string[] = []) => {
    if (boardIds.length === 0 && noteIds.length === 0 && shapeIds.length === 0) return;
    const titles = boardIds.map((id) => boardById.get(id)?.title ?? id);
    if (boardIds.length > 0) {
      const ok = await appConfirm({
        title: t("design.studio.deleteTitle"), lead: t("design.studio.deleteLead", { count: boardIds.length }), items: titles,
        confirmLabel: t("design.studio.delete"), cancelLabel: t("design.studio.cancel"), tone: "danger",
      });
      if (!ok) return;
    }
    setSelBoards([]); setSelNotes([]); setSelShapes([]);
    // O que for apagado fica guardado para o desfazer recriar (com id novo).
    const gone: Array<{ ref: { current: string }; add: () => Promise<string | undefined>; del: (id: string) => Promise<unknown> }> = [];
    for (const id of boardIds) {
      const a = detail?.artboards.find((x) => x.id === id);
      if (!a) continue;
      const args = { pageId: a.pageId, title: a.title, html: a.html, width: a.width, height: a.height, x: a.x, y: a.y };
      const radius = a.radius ?? 0;
      if ((await act(designApi.deleteArtboard(id))) === null) continue;
      gone.push({ ref: idRef(id), del: (x) => designApi.deleteArtboard(x), add: async () => {
        const r = await designApi.addArtboard(args);
        if (r.artboardId && radius) await designApi.updateArtboard(r.artboardId, { radius });
        return r.artboardId;
      } });
    }
    for (const id of noteIds) {
      const n = detail?.notes.find((x) => x.id === id);
      if (!n || (await act(designApi.deleteNote(id))) === null) continue;
      const args = { pageId: n.pageId, x: n.x, y: n.y, w: n.w, h: n.h, text: n.text, color: n.color };
      gone.push({ ref: idRef(id), del: (x) => designApi.deleteNote(x), add: async () => (await designApi.addNote(args)).noteId });
    }
    for (const id of shapeIds) {
      const sh = detail?.shapes.find((x) => x.id === id);
      if (!sh || (await act(designApi.deleteShape(id))) === null) continue;
      const args = { pageId: sh.pageId, kind: sh.kind, x: sh.x, y: sh.y, w: sh.w, h: sh.h, data: parseShapeData(sh.data) };
      gone.push({ ref: idRef(id), del: (x) => designApi.deleteShape(x), add: async () => (await designApi.addShape(args)).shapeId });
    }
    if (gone.length) record({
      label: "delete",
      undo: async () => { for (const g of gone) { const id = await g.add(); if (id) g.ref.current = id; } },
      redo: async () => { for (const g of gone) await g.del(g.ref.current); },
    });
  }, [boardById, t, act, detail, record]);

  const copy = useCallback((text: string, okMsg: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => AlertaToast(t("canvas.design.title"), okMsg, "success", 2500))
      .catch(fail);
  }, [t, fail]);

  /** Muda a caixa de um item (painel, ajustar altura) com entrada no desfazer. */
  const setBox = useCallback((type: ItemType, id: string, from: Box, to: Box) => {
    setGeo((g) => ({ ...g, [id]: to }));
    void act(geoApi(type, id, to), [id]);
    record({ label: "resize", undo: () => geoApi(type, id, from), redo: () => geoApi(type, id, to) });
  }, [act, record]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitHeight = useCallback((id: string) => {
    const h = contentH.current[id];
    const b = boardById.get(id);
    if (!h || !b) return;
    const height = Math.min(8000, Math.max(MIN_BOARD, Math.round(h)));
    setBox("board", id, { x: b.x, y: b.y, w: b.w, h: b.h }, { x: b.x, y: b.y, w: b.w, h: height });
  }, [boardById, setBox]);

  /** Salva o HTML de uma prancheta (Código, Tweaks, edição no lugar). O conflito de versão volta como "conflict". */
  const saveHtml = useCallback(async (id: string, html: string, expectedVersion: number): Promise<SaveOutcome> => {
    selfUntil.current = Date.now() + SELF_EDIT_MS;
    try {
      await designApi.updateArtboard(id, { html, expectedVersion });
      await reload();
      return "ok";
    } catch (e) {
      if (isVersionConflict(e)) {
        AlertaToast(t("canvas.design.title"), t("design.panel.conflictToast"), "warning", 5000);
        return "conflict";
      }
      fail(e);
      return "error";
    }
  }, [reload, fail, t]);

  const editElement = useCallback(async (boardId: string, selector: string, how: { inner: string } | "remove") => {
    const a = detail?.artboards.find((x) => x.id === boardId);
    if (!a) return;
    const res = how === "remove" ? removeElement(a.html, selector) : replaceInner(a.html, selector, how.inner);
    if (!res.ok) return fail(t("design.quick.missing"));
    if (how === "remove") { setPicked([]); setElRect(null); }
    await saveHtml(boardId, res.html, a.version);
  }, [detail, saveHtml, fail, t]);

  // ---------- mandar ao agente ----------
  const sendToAgent = useCallback(async (boardId: string, label: string, selectedText: string, requestText: string, anchor: string | null) => {
    if (!detail) return;
    const board = boardById.get(boardId);
    const text = formatSendText(sendPayload(label, selectedText, requestText), {
      designTitle: detail.design.title, designId: detail.design.id, boardTitle: board?.title ?? boardId, boardId, anchor,
    });
    if (host === "chat") {
      insertIntoComposer(text);
      AlertaToast(t("canvas.design.title"), t("design.comments.addedToComposer"), "success", 3500);
      return;
    }
    if (owner) {
      try {
        await designApi.tellOwner(owner.id, text);
        AlertaToast(t("canvas.design.title"), t("design.comments.sent"), "success", 3000);
      } catch (e) {
        fail(e);
      }
      return;
    }
    copy(text, t("design.comments.copied"));
  }, [detail, boardById, host, owner, t, fail, copy]);

  // ---------- comentários da página ----------
  const pageComments = useMemo(() => {
    const ids = new Set(boards.map((b) => b.id));
    return (detail?.comments ?? []).filter((c) => ids.has(c.artboardId)).map((c) => ({ ...c, parentId: c.parentId ?? null, anchor: c.anchor ?? c.selector ?? null }));
  }, [detail, boards]);
  const threads = useMemo(() => threadsOf(pageComments), [pageComments]);
  const anchored = useMemo(() => pageComments.filter((c) => c.anchor && !c.parentId), [pageComments]);

  const locate = useCallback((boardId: string) => {
    const items = anchored.filter((c) => c.artboardId === boardId).map((c) => ({ id: c.id, selector: c.anchor! }));
    if (items.length) postToFrame(frames.current.get(boardId) ?? null, { kind: "locate", items });
  }, [anchored]);
  useEffect(() => { for (const id of live) locate(id); }, [live, locate]);

  // ---------- modo do iframe ----------
  const frameMode: FrameMode = tool === "comment" ? "comment" : tool === "select" && !space ? "edit" : "inert";
  // A prancheta em Play no canvas fica viva (protótipo); as outras seguem a ferramenta.
  const modeOf = useCallback((id: string): FrameMode => (playing.has(id) ? "play" : frameMode), [playing, frameMode]);
  useEffect(() => {
    for (const [id, el] of frames.current) if (!id.startsWith("focus:")) postToFrame(el, { kind: "mode", mode: modeOf(id) });
  }, [modeOf, liveKey]);
  // A seleção de cada prancheta vai ao iframe: ele desenha os anéis e sabe se o clique escolhe elementos.
  const selectionFor = useCallback((id: string) => ({
    kind: "selection" as const, active: selBoards.includes(id), selectors: picked.filter((p) => p.artboardId === id).map((p) => p.selector),
  }), [selBoards, picked]);
  useEffect(() => {
    for (const [id, el] of frames.current) if (!id.startsWith("focus:")) postToFrame(el, selectionFor(id));
  }, [selectionFor, liveKey]);

  // ---------- cursor do agente: a prancheta cuja versão subiu brilha 2 s ----------
  useEffect(() => {
    if (!detail) return;
    const bumped = bumpedBoards(prevVersions.current, detail.artboards);
    prevVersions.current = versionsOf(detail.artboards);
    if (bumped.length === 0 || Date.now() < selfUntil.current) return;
    // "Seguir o agente": a câmera vai até a prancheta que mudou (se estiver nesta página).
    setLastBump(bumped[0]);
    if (latest.current.following && boardById.has(bumped[0])) fitBoard(bumped[0]);
    setAgentFlash((f) => ({ ...f, ...Object.fromEntries(bumped.map((id) => [id, true as const])) }));
    const timer = setTimeout(() => setAgentFlash((f) => { const n = { ...f }; for (const id of bumped) delete n[id]; return n; }), AGENT_FLASH_MS);
    return () => clearTimeout(timer);
  }, [detail]);
  useEffect(() => { prevVersions.current = null; }, [designId]);

  // ---------- view state (o que a pessoa vê) ----------
  const lastView = useRef<DesignViewState | null>(null);
  const publisher = useMemo(() => createDebouncer<DesignViewState>(VIEW_DEBOUNCE_MS, (state) => {
    lastView.current = state;
    designApi.setView(designId, state).catch((e) => console.debug("design_view_set", e));
  }), [designId]);
  useEffect(() => () => publisher.cancel(), [publisher]);
  useEffect(() => {
    if (!page || size.w === 0) return;
    const state = fitViewState(buildViewState({
      mode: focused ? "focused" : "canvas", page: { id: page.id, name: page.name }, boards, camera: cam,
      viewport: { width: size.w, height: size.h, top: 0 }, focusedId: focused?.id ?? null, selectedIds: selBoards, picked, now: Date.now(),
    }));
    if (!sameViewState(lastView.current, state)) publisher.push(state);
  }, [page, boards, cam, size, focused, selBoards, picked, publisher]);

  // ---------- teclado ----------
  const latest = useRef({ tool, selBoards, selNotes, selShapes, focused, menu, draft, thread, boards, notes, shapes, shapeBoxes, size, pen, playing, following, panelOpen, panelTab, picked });
  latest.current = { tool, selBoards, selNotes, selShapes, focused, menu, draft, thread, boards, notes, shapes, shapeBoxes, size, pen, playing, following, panelOpen, panelTab, picked };
  const chooseTool = useCallback((next: Tool) => {
    if (isDrawTool(next)) setLastDraw(next);
    if (isShapeTool(next)) setLastShape(next);
    setTool(next);
    setDraft(null);
    setPen([]);
  }, []);
  /** Fecha o caminho da caneta: 2+ pontos viram uma forma "pen". */
  const finishPen = useCallback(() => {
    const pts = latest.current.pen;
    setPen([]);
    if (pts.length < 2) return;
    const { box, points } = normalizeStroke(pts);
    void addShape("pen", box, { points });
  }, [addShape]);
  const exitFocus = useCallback(() => {
    const f = latest.current.focused;
    setFocused(null);
    if (f) requestAnimationFrame(() => fitBoard(f.id));
  }, [fitBoard]);
  const handleKey = useCallback((k: KeyLike): boolean => {
    const a = keyAction(k);
    if (!a) return false;
    const s = latest.current;
    if (s.focused && a.type !== "escape") return false;
    switch (a.type) {
      case "spaceDown": setSpace(true); return true;
      case "spaceUp": setSpace(false); return true;
      case "tool": if (s.tool === "pen") finishPen(); chooseTool(a.tool); return true;
      case "zoomIn": zoomStep(1); return true;
      case "zoomOut": zoomStep(-1); return true;
      case "fit": setFollowing(false); fitAll(); return true;
      case "duplicate": if (s.selBoards.length === 0) return false; duplicate(s.selBoards); return true;
      case "selectAll": setSelBoards(s.boards.map((b) => b.id)); setSelNotes(s.notes.map((n) => n.id)); setSelShapes(s.shapes.map((x) => x.id)); return true;
      case "undo": void undoRedo(false); return true;
      case "redo": void undoRedo(true); return true;
      case "guides": setGuides((g) => !g); return true;
      case "panel": setPanelOpen((o) => !o); return true;
      case "cycle": {
        const id = cycleBoard(s.boards, s.selBoards[0] ?? null, a.dir);
        if (!id) return false;
        setSelBoards([id]); setSelNotes([]); setSelShapes([]); setPicked([]);
        setFollowing(false);
        fitBoard(id);
        const o = boardOrdinal(s.boards, id);
        setAnnounce(t("design.studio.announceBoard", { i: o.i, n: o.n, title: s.boards.find((b) => b.id === id)?.title ?? "" }));
        return true;
      }
      case "delete":
        if (s.selBoards.length === 0 && s.selNotes.length === 0 && s.selShapes.length === 0) return false;
        void removeSelection(s.selBoards, s.selNotes, s.selShapes);
        return true;
      case "escape":
        if (s.menu) { setMenu(null); return true; }
        if (s.draft) { setDraft(null); return true; }
        if (s.thread) { setThread(null); return true; }
        if (s.focused) { exitFocus(); return true; }
        if (s.pen.length) { finishPen(); return true; }
        if (s.playing.size) { setPlaying(new Set()); return true; }
        if (s.picked.length) {
          // Esc sobe para o pai do elemento escolhido; no topo, solta o elemento (a prancheta continua).
          const last = s.picked[s.picked.length - 1];
          const up = parentSelector(last.selector);
          setElRect(null);
          setPicked(up ? [{ artboardId: last.artboardId, selector: up, kind: "other", label: up.split(" > ").pop() ?? up }] : []);
          return true;
        }
        if (s.tool !== "select") { setTool("select"); return true; }
        if (s.selBoards.length || s.selNotes.length || s.selShapes.length) { setSelBoards([]); setSelNotes([]); setSelShapes([]); setPicked([]); setElRect(null); return true; }
        return false;
    }
    return false;
  }, [zoomStep, fitAll, fitBoard, duplicate, removeSelection, exitFocus, finishPen, chooseTool, undoRedo, t]);

  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;
  // Registrado UMA vez: precisa ficar antes do listener do RouteModal (que fecharia a tela no Esc).
  useEffect(() => {
    const onKey = (phase: "down" | "up") => (e: KeyboardEvent) => {
      if (!active.current || isEditableTarget(e.target)) return;
      // Um menu da barra aberto é dono do Esc (ele mesmo fecha).
      if (e.key === "Escape" && rootRef.current?.querySelector("[data-studio-menu]")) return;
      if (phase === "down" && e.key === " " && e.repeat) { e.preventDefault(); return; }
      const used = keyRef.current({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, phase });
      if (used) {
        e.preventDefault();
        // Antes do Esc chegar ao RouteModal (que fecharia a tela) ou ao terminal de trás.
        e.stopImmediatePropagation();
      }
    };
    const down = onKey("down");
    const up = onKey("up");
    const outside = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) active.current = false; };
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    document.addEventListener("pointerdown", outside, { capture: true });
    const blur = () => setSpace(false);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
      document.removeEventListener("pointerdown", outside, { capture: true });
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ---------- roda e pinça na superfície ----------
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-studio-popover]")) return;
      e.preventDefault();
      stopGlide();
      setFollowing(false);
      const r = el.getBoundingClientRect();
      setCamera(wheelCamera(camRef.current, e, e.clientX - r.left, e.clientY - r.top, el.clientHeight));
    };
    type G = Event & { scale: number; clientX: number; clientY: number };
    const onGesture = (e: Event) => {
      const g = e as G;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.type === "gesturestart") gesture.current = { scale: camRef.current.scale, sx: g.clientX - r.left, sy: g.clientY - r.top };
      else if (e.type === "gesturechange" && gesture.current) setCamera(zoomAt(camRef.current, gesture.current.scale * g.scale, gesture.current.sx, gesture.current.sy));
      else gesture.current = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    for (const n of ["gesturestart", "gesturechange", "gestureend"]) el.addEventListener(n, onGesture, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      for (const n of ["gesturestart", "gesturechange", "gestureend"]) el.removeEventListener(n, onGesture);
    };
  }, [setCamera, stopGlide, focused === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- mensagens dos iframes ----------
  const navMissRef = useRef((href: string) => AlertaToast(t("canvas.design.title"), t("design.studio.navMissing", { href }), "info", 4000));
  const fitBoardRef = useRef(fitBoard);
  fitBoardRef.current = fitBoard;
  const editRef = useRef(editElement);
  editRef.current = editElement;
  const boardMenu = useRef<(x: number, y: number, id: string) => void>(() => {});
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      let id: string | null = null;
      for (const [key, el] of frames.current) if (el.contentWindow && el.contentWindow === e.source) { id = key; break; }
      if (!id) return;
      const m = parseFrameMessage(e.data);
      if (!m) return;
      if (id.startsWith("focus:")) return onFocusMessage(id.slice(6), m);
      onBoardMessage(id, m, frames.current.get(id)!);
    };
    const onFocusMessage = (boardId: string, m: FrameMessage) => {
      if (m.kind === "key" && m.key === "Escape" && m.phase === "down") exitFocus();
      if (m.kind === "pointer") active.current = true;
      if (m.kind === "nav") {
        const target = resolveNavTarget(m.href, latest.current.boards);
        if (!target) navMissRef.current(m.href);
        else if (target !== boardId) setFocused((f) => (f ? { ...f, id: target } : f));
      }
    };
    const onBoardMessage = (boardId: string, m: FrameMessage, el: HTMLIFrameElement) => {
      if (m.kind === "nav") {
        // Play no canvas: o link do protótipo seleciona e enquadra a prancheta de destino.
        const target = resolveNavTarget(m.href, latest.current.boards);
        if (!target) navMissRef.current(m.href);
        else if (target !== boardId) { setSelBoards([target]); fitBoardRef.current(target); }
        return;
      }
      if (m.kind === "clearSelect") { setPicked((p) => p.filter((x) => x.artboardId !== boardId)); setElRect(null); return; }
      if (m.kind === "selRect") { setElRect(m.rect); return; }
      if (m.kind === "tree") { setTree({ boardId, nodes: m.nodes }); return; }
      if (m.kind === "textEdited") { void editRef.current(boardId, m.selector, { inner: m.html }); return; }
      if (m.kind === "editCancel") return;
      const board = latest.current.boards.find((b) => b.id === boardId);
      if (!board) return;
      const c = camRef.current;
      const at = toScreen(c, board.x, board.y);
      switch (m.kind) {
        case "wheel": {
          stopGlide();
          setFollowing(false);
          const sx = at.x + m.cx * c.scale;
          const sy = at.y + m.cy * c.scale;
          setCamera(wheelCamera(c, { deltaX: m.dx, deltaY: m.dy, deltaMode: m.mode, ctrlKey: m.ctrl, metaKey: m.meta }, sx, sy, latest.current.size.h));
          return;
        }
        case "gesture":
          if (m.phase === "start") gesture.current = { scale: c.scale, sx: at.x + m.cx * c.scale, sy: at.y + m.cy * c.scale };
          else if (m.phase === "change" && gesture.current) setCamera(zoomAt(c, gesture.current.scale * m.scale, gesture.current.sx, gesture.current.sy));
          else gesture.current = null;
          return;
        case "key":
          handleKey(m);
          return;
        case "pointer":
          active.current = true;
          setMenu(null);
          if (latest.current.tool === "select") {
            // Clicar noutra prancheta solta os elementos escolhidos nas outras.
            if (!m.shift && !latest.current.selBoards.includes(boardId)) { setPicked([]); setElRect(null); }
            setSelNotes(m.shift ? latest.current.selNotes : []);
            setSelShapes(m.shift ? latest.current.selShapes : []);
            setSelBoards((s) => (m.shift ? (s.includes(boardId) ? s.filter((x) => x !== boardId) : [...s, boardId]) : [boardId]));
          }
          return;
        case "context": {
          const r = el.getBoundingClientRect();
          boardMenu.current(r.left + m.cx * c.scale, r.top + m.cy * c.scale, boardId);
          return;
        }
        case "select":
          setElRect(m.rect);
          setPicked((p) => {
            const item = { artboardId: boardId, selector: m.selector, kind: m.elKind, label: m.label };
            return m.shift ? [...p.filter((x) => !(x.artboardId === boardId && x.selector === m.selector)), item] : [item];
          });
          return;
        case "pick": {
          // Âncora: o seletor + o ponto relativo ao elemento; sem elemento, o ponto na prancheta.
          const anchor = clampAnchor(m.selector);
          const pointX = anchor ? m.fx : Math.min(1, Math.max(0, m.bx / board.w));
          const pointY = anchor ? m.fy : Math.min(1, Math.max(0, m.by / board.h));
          setThread(null);
          setDraft({ boardId, anchor, pointX, pointY, label: m.label || board.title, text: m.text, wx: board.x + m.bx, wy: board.y + m.by });
          return;
        }
        case "located":
          setRects((r) => {
            const next = { ...r };
            let changed = false;
            for (const it of m.items) {
              const old = next[it.id];
              if (JSON.stringify(old ?? null) !== JSON.stringify(it.rect)) { next[it.id] = it.rect; changed = true; }
            }
            return changed ? next : r;
          });
          return;
        case "size":
          contentH.current[boardId] = m.h;
          return;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [handleKey, exitFocus, setCamera, stopGlide]);

  // ---------- ponteiro: pan, seleção por retângulo, mover, redimensionar, criar ----------
  const surfacePoint = (e: { clientX: number; clientY: number }) => {
    const r = surfaceRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const capture = (e: React.PointerEvent) => { try { surfaceRef.current?.setPointerCapture(e.pointerId); } catch { /* ponteiro já solto */ } };
  const panning = (e: React.PointerEvent) => e.button === 1 || latest.current.tool === "hand" || space;

  const startMove = (e: React.PointerEvent, id: string, type: ItemType) => {
    const s = latest.current;
    const sets: Record<ItemType, string[]> = { board: s.selBoards, note: s.selNotes, shape: s.selShapes };
    const isSel = sets[type].includes(id);
    if (e.shiftKey) {
      sets[type] = isSel ? sets[type].filter((x) => x !== id) : [...sets[type], id];
    } else if (!isSel) {
      sets.board = []; sets.note = []; sets.shape = [];
      sets[type] = [id];
    }
    setSelBoards(sets.board);
    setSelNotes(sets.note);
    setSelShapes(sets.shape);
    if (type !== "board" || !isSel) setPicked([]);
    const items = [
      ...sets.board.flatMap((bid) => { const b = boardById.get(bid); return b ? [{ id: bid, type: "board" as const, box: { x: b.x, y: b.y, w: b.w, h: b.h } }] : []; }),
      ...sets.note.flatMap((nid) => { const n = s.notes.find((x) => x.id === nid); return n ? [{ id: nid, type: "note" as const, box: { x: n.x, y: n.y, w: n.w, h: n.h } }] : []; }),
      // Formas guardam a caixa COM sinal (linha e seta): mover só soma em x/y.
      ...sets.shape.flatMap((sid) => { const x = s.shapes.find((y) => y.id === sid); return x ? [{ id: sid, type: "shape" as const, box: { x: x.x, y: x.y, w: x.w, h: x.h } }] : []; }),
    ];
    if (!items.some((it) => it.id === id)) return;
    drag.current = { kind: "move", start: surfacePoint(e), items, primary: id, alt: e.altKey && type === "board", moved: false };
    capture(e);
  };

  const handlers = useRef<FrameHandlers>(null as unknown as FrameHandlers);
  handlers.current = {
    onTitleDown: (e, id) => {
      if (e.button === 2) return;
      e.stopPropagation();
      active.current = true;
      setMenu(null);
      if (panning(e)) { drag.current = { kind: "pan", last: { x: e.clientX, y: e.clientY } }; capture(e); return; }
      startMove(e, id, "board");
    },
    onGripDown: (e, id, corner) => {
      e.stopPropagation();
      const b = boardById.get(id);
      if (!b) return;
      drag.current = { kind: "resize", id, corner, start: { x: b.x, y: b.y, w: b.w, h: b.h }, startPt: surfacePoint(e) };
      capture(e);
    },
    onRenameStart: (id) => setRenaming(id),
    onRename: (id, title) => {
      if (renamingRef.current !== id) return;
      setRenaming(null);
      if (title) void act(designApi.updateArtboard(id, { title }));
    },
    onContext: (e, id) => { e.preventDefault(); boardMenu.current(e.clientX, e.clientY, id); },
    onExpand: (id) => setFocused({ id, fit: "fit" }),
    onPlay: (id) => setPlaying((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    onFrameLoad: (id) => {
      const el = frames.current.get(id) ?? null;
      postToFrame(el, { kind: "mode", mode: modeOf(id) });
      postToFrame(el, selectionFor(id));
      locate(id);
      if (latest.current.panelOpen && latest.current.panelTab === "layers") postToFrame(el, { kind: "tree" });
    },
    onForceLoad: (id) => setPinned((p) => new Set(p).add(id)),
    register: (id, el) => { if (el) frames.current.set(id, el); else frames.current.delete(id); },
  };
  // O `memo` da prancheta só vê handlers estáveis; por dentro eles leem o `handlers.current` da vez.
  const stable = useMemo<FrameHandlers>(() => ({
    onTitleDown: (e, id) => handlers.current.onTitleDown(e, id),
    onGripDown: (e, id, c) => handlers.current.onGripDown(e, id, c),
    onRenameStart: (id) => handlers.current.onRenameStart(id),
    onRename: (id, title) => handlers.current.onRename(id, title),
    onContext: (e, id) => handlers.current.onContext(e, id),
    onExpand: (id) => handlers.current.onExpand(id),
    onPlay: (id) => handlers.current.onPlay(id),
    onFrameLoad: (id) => handlers.current.onFrameLoad(id),
    onForceLoad: (id) => handlers.current.onForceLoad(id),
    register: (id, el) => handlers.current.register(id, el),
  }), []);

  const noteDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button === 2) return;
    // Com uma ferramenta de criação, o clique segue para o canvas (desenhar por cima).
    if (latest.current.tool !== "select" && latest.current.tool !== "hand" && !space && e.button !== 1) return;
    e.stopPropagation();
    active.current = true;
    setMenu(null);
    if (panning(e)) { drag.current = { kind: "pan", last: { x: e.clientX, y: e.clientY } }; capture(e); return; }
    startMove(e, id, "note");
  }, [boardById, space]); // eslint-disable-line react-hooks/exhaustive-deps
  const noteSave = useCallback((id: string, text: string) => { void act(designApi.updateNote(id, { text })); }, [act]);
  const noteMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setSelNotes([id]);
    setMenu({
      x: e.clientX, y: e.clientY, items: [
        ...NOTE_COLORS.map((c, i) => ({ key: `c-${c}`, label: t(`design.studio.color.${c}`), separator: i === 0 ? false : undefined, onSelect: () => void act(designApi.updateNote(id, { color: c })) })),
        { key: "del", label: t("design.studio.delete"), danger: true, separator: true, hint: "⌫", onSelect: () => void removeSelection([], [id]) },
      ],
    });
  }, [t, act, removeSelection]);

  const shapeDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button === 2) return;
    // Com uma ferramenta de criação, o clique segue para o canvas (desenhar por cima).
    if (latest.current.tool !== "select" && latest.current.tool !== "hand" && !space && e.button !== 1) return;
    e.stopPropagation();
    active.current = true;
    setMenu(null);
    if (panning(e)) { drag.current = { kind: "pan", last: { x: e.clientX, y: e.clientY } }; capture(e); return; }
    startMove(e, id, "shape");
  }, [boardById, space]); // eslint-disable-line react-hooks/exhaustive-deps
  const shapeEditStart = useCallback((id: string) => setEditingShape(id), []);
  const patchShape = useCallback((id: string, patch: Partial<ShapeData>) => {
    const x = latest.current.shapes.find((y) => y.id === id);
    if (!x) return;
    const from = x.data;
    const to = { ...from, ...patch };
    setDataOver((o) => ({ ...o, [id]: to }));
    selfUntil.current = Date.now() + SELF_EDIT_MS;
    void act(designApi.updateShape(id, { data: to })).finally(() => setDataOver((o) => { const n = { ...o }; delete n[id]; return n; }));
    record({ label: "style", undo: () => designApi.updateShape(id, { data: from }), redo: () => designApi.updateShape(id, { data: to }) });
  }, [act, record]);
  const shapeEditEnd = useCallback((id: string, text: string | null) => {
    setEditingShape(null);
    const x = latest.current.shapes.find((y) => y.id === id);
    if (text === null || !x || text === x.data.text) return;
    patchShape(id, { text });
  }, [patchShape]);
  const shapeMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setSelShapes([id]); setSelBoards([]); setSelNotes([]);
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { key: "props", label: t("design.panel.open"), onSelect: () => { setPanelOpen(true); setPanelTab("props"); } },
      { key: "del", label: t("design.studio.delete"), danger: true, separator: true, hint: "⌫", onSelect: () => void removeSelection([], [], [id]) },
    ] });
  }, [t, removeSelection]);

  const exportFor = (id: string) => {
    const b = boardById.get(id);
    if (!b) return null;
    return {
      onHtml: () => { exportHtml(b, t("design.export.html")).then((path) => { if (path) AlertaToast(t("canvas.design.title"), t("design.export.saved", { path }), "success", 4000); }).catch(fail); },
      onPdf: () => { printBoard(b).catch(fail); },
    };
  };

  boardMenu.current = (x, y, id) => {
    setSelBoards((s) => (s.includes(id) ? s : [id]));
    setMenu({
      x, y, items: [
        { key: "open", label: t("design.studio.expand"), onSelect: () => setFocused({ id, fit: "fit" }) },
        { key: "dup", label: t("design.studio.duplicate"), hint: `${mod}D`, separator: true, onSelect: () => duplicate([id]) },
        { key: "rename", label: t("design.studio.rename"), onSelect: () => setRenaming(id) },
        { key: "fit", label: t("design.studio.fitHeight"), disabled: !contentH.current[id], onSelect: () => fitHeight(id) },
        { key: "link", label: t("design.studio.copyLink"), onSelect: () => copy(openCommand(designId, { artboardId: id }), t("design.studio.linkCopied")) },
        { key: "exHtml", label: t("design.export.html"), separator: true, onSelect: () => exportFor(id)?.onHtml() },
        { key: "exPdf", label: t("design.export.pdf"), onSelect: () => exportFor(id)?.onPdf() },
        { key: "del", label: t("design.studio.delete"), danger: true, separator: true, hint: "⌫", onSelect: () => void removeSelection(latest.current.selBoards.includes(id) ? latest.current.selBoards : [id], []) },
      ],
    });
  };

  const onSurfaceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    active.current = true;
    if (e.button === 2) return;
    setMenu(null);
    if ((e.target as Element).closest("[data-studio-popover]")) return;
    rootRef.current?.focus({ preventScroll: true });
    const p = surfacePoint(e);
    const w = toWorld(camRef.current, p.x, p.y);
    if (panning(e)) { drag.current = { kind: "pan", last: { x: e.clientX, y: e.clientY } }; capture(e); return; }
    if (draft) { setDraft(null); return; }
    if (thread) { setThread(null); return; }
    if (isShapeTool(tool)) {
      drag.current = { kind: "shape", tool, start: w, cur: w };
      capture(e);
    } else if (tool === "pencil") {
      drag.current = { kind: "draw", points: [w] };
      capture(e);
    } else if (tool === "pen") {
      // Clique soma um ponto; clicar de novo em cima do último (duplo clique) fecha o caminho.
      const last = pen[pen.length - 1];
      if (last && Math.hypot((last.x - w.x) * cam.scale, (last.y - w.y) * cam.scale) < 6) finishPen();
      else setPen((p) => [...p, w]);
    } else if (tool === "text") {
      void addShape("text", { x: w.x, y: w.y, ...CLICK_SIZE.text }, { text: "" }).then((id) => { if (id) setEditingShape(id); });
      setTool("select");
    } else if (tool === "select") {
      drag.current = { kind: "marquee", start: w, additive: e.shiftKey, base: e.shiftKey ? { boards: selBoards, notes: selNotes } : { boards: [], notes: [] } };
      if (!e.shiftKey) { setSelBoards([]); setSelNotes([]); setSelShapes([]); setPicked([]); setElRect(null); }
      capture(e);
    } else if (tool === "artboard") {
      drag.current = { kind: "create", start: w, cur: w };
      capture(e);
    } else if (tool === "note") {
      if (page) {
        const args = { pageId: page.id, x: Math.round(w.x), y: Math.round(w.y), w: NOTE_DEFAULT.w, h: NOTE_DEFAULT.h, text: "" };
        void createRecorded("create", async () => ({ id: (await designApi.addNote(args)).noteId }), (x) => designApi.deleteNote(x));
      }
      setTool("select");
    }
  };

  const onSurfaceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const c = camRef.current;
    if (d.kind === "pan") {
      stopGlide();
      setFollowing(false);
      setCamera(panBy(c, e.clientX - d.last.x, e.clientY - d.last.y));
      d.last = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = surfacePoint(e);
    const w = toWorld(c, p.x, p.y);
    if (d.kind === "draw") {
      d.points.push(w);
      setDragUi({ stroke: [...d.points] });
      return;
    }
    if (d.kind === "shape") {
      d.cur = w;
      const line = d.tool === "line" || d.tool === "arrow";
      const r = line ? { x: d.start.x, y: d.start.y, w: w.x - d.start.x, h: w.y - d.start.y } : normalizeRect(d.start.x, d.start.y, w.x, w.y);
      // Shift: quadrado/círculo; na linha, trava em 45°.
      if (e.shiftKey && !line) { const m = Math.max(r.w, r.h); r.w = m; r.h = m; }
      if (e.shiftKey && line) { const a = Math.round(Math.atan2(r.h, r.w) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(r.w, r.h); r.w = Math.cos(a) * len; r.h = Math.sin(a) * len; }
      setDragUi({ shape: { kind: d.tool, ...r } });
      return;
    }
    if (d.kind === "shapeResize") {
      const x = latest.current.shapes.find((y) => y.id === d.id);
      if (!x) return;
      const r = resizeFromCorner(d.start, d.corner, (p.x - d.startPt.x) / c.scale, (p.y - d.startPt.y) / c.scale, { keepAspect: e.shiftKey, snap: false, min: 4, max: 20000 });
      setGeo((g) => ({ ...g, [d.id]: resizeShape(x, r) }));
      return;
    }
    if (d.kind === "marquee") {
      const rect = normalizeRect(d.start.x, d.start.y, w.x, w.y);
      const s = latest.current;
      setSelBoards([...new Set([...d.base.boards, ...marqueeHits(rect, s.boards)])]);
      setSelNotes([...new Set([...d.base.notes, ...marqueeHits(rect, s.notes)])]);
      setSelShapes(marqueeHits(rect, s.shapeBoxes));
      setDragUi({ marquee: rect });
      return;
    }
    if (d.kind === "create") {
      d.cur = w;
      setDragUi({ create: normalizeRect(d.start.x, d.start.y, w.x, w.y) });
      return;
    }
    if (d.kind === "resize") {
      const others = latest.current.boards.filter((b) => b.id !== d.id);
      const r = resizeFromCorner(d.start, d.corner, (p.x - d.startPt.x) / c.scale, (p.y - d.startPt.y) / c.scale,
        { keepAspect: e.shiftKey, snap: !(e.metaKey || e.ctrlKey), others, scale: c.scale });
      setGeo((g) => ({ ...g, [d.id]: { x: r.x, y: r.y, w: r.w, h: r.h } }));
      setDragUi({ guides: r.guides });
      return;
    }
    // mover
    const dx = (p.x - d.start.x) / c.scale;
    const dy = (p.y - d.start.y) / c.scale;
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
    d.moved = true;
    d.alt = d.alt && e.altKey;
    const primary = d.items.find((it) => it.id === d.primary)!;
    const ids = new Set(d.items.map((it) => it.id));
    const others = latest.current.boards.filter((b) => !ids.has(b.id));
    const snapped = snapMove({ ...primary.box, x: primary.box.x + dx, y: primary.box.y + dy }, others, c.scale, !(e.metaKey || e.ctrlKey));
    const ox = snapped.x - primary.box.x;
    const oy = snapped.y - primary.box.y;
    if (d.alt) {
      setDragUi({ guides: snapped.guides, ghosts: d.items.filter((it) => it.type === "board").map((it) => ({ ...it.box, x: it.box.x + ox, y: it.box.y + oy })) });
      return;
    }
    setGeo((g) => {
      const n = { ...g };
      for (const it of d.items) n[it.id] = { ...it.box, x: it.box.x + ox, y: it.box.y + oy };
      return n;
    });
    setDragUi({ guides: snapped.guides });
  };

  const dragUiRef = useRef(dragUi);
  dragUiRef.current = dragUi;
  const onShapeGrip = (e: React.PointerEvent, id: string, corner: Corner) => {
    e.stopPropagation();
    const x = shapeBoxes.find((y) => y.id === id);
    if (!x) return;
    drag.current = { kind: "shapeResize", id, corner, start: { x: x.x, y: x.y, w: x.w, h: x.h }, startPt: surfacePoint(e) };
    capture(e);
  };

  const onSurfaceUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragUi(null);
    if (!d) return;
    if (d.kind === "draw") {
      const pts = thinPoints(d.points, 2 / camRef.current.scale);
      if (pts.length >= 2) { const { box, points } = normalizeStroke(pts); void addShape("pencil", box, { points }); }
      return;
    }
    if (d.kind === "shape") {
      const ui = dragUiRef.current?.shape;
      const line = d.tool === "line" || d.tool === "arrow";
      const tiny = !ui || Math.hypot(ui.w, ui.h) * camRef.current.scale < 4;
      const box = tiny ? { x: d.start.x, y: d.start.y, ...CLICK_SIZE[d.tool] } : { x: ui.x, y: ui.y, w: ui.w, h: ui.h };
      void addShape(d.tool, line ? box : { ...box, w: Math.max(4, box.w), h: Math.max(4, box.h) }, {});
      setTool("select");
      return;
    }
    if (d.kind === "shapeResize") {
      const g = geo[d.id];
      const x = latest.current.shapes.find((y) => y.id === d.id);
      if (!g || !x) return;
      const orig = detail?.shapes.find((y) => y.id === d.id);
      const from = orig ? { x: orig.x, y: orig.y, w: orig.w, h: orig.h } : g;
      void act(geoApi("shape", d.id, g), [d.id]);
      record({ label: "resize", undo: () => geoApi("shape", d.id, from), redo: () => geoApi("shape", d.id, g) });
      return;
    }
    if (d.kind === "create") {
      const r = normalizeRect(d.start.x, d.start.y, d.cur.x, d.cur.y);
      const tiny = r.w * camRef.current.scale < 4 && r.h * camRef.current.scale < 4;
      addBoardAt(tiny ? { x: d.start.x, y: d.start.y, w: BOARD_DEFAULT.w, h: BOARD_DEFAULT.h } : { ...r, w: Math.max(MIN_BOARD, r.w), h: Math.max(MIN_BOARD, r.h) });
      setTool("select");
      return;
    }
    if (d.kind === "resize") {
      const g = geo[d.id];
      if (!g) return;
      persistUnstacked();
      const to = { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h) };
      void act(geoApi("board", d.id, to), [d.id]);
      record({ label: "resize", undo: () => geoApi("board", d.id, d.start), redo: () => geoApi("board", d.id, to) });
      return;
    }
    if (d.kind !== "move" || !d.moved) return;
    const c = camRef.current;
    const p = surfacePoint(e);
    const primary = d.items.find((it) => it.id === d.primary)!;
    const ids = new Set(d.items.map((it) => it.id));
    const others = latest.current.boards.filter((b) => !ids.has(b.id));
    const snapped = snapMove({ ...primary.box, x: primary.box.x + (p.x - d.start.x) / c.scale, y: primary.box.y + (p.y - d.start.y) / c.scale }, others, c.scale, !(e.metaKey || e.ctrlKey));
    const ox = snapped.x - primary.box.x;
    const oy = snapped.y - primary.box.y;
    if (d.alt) {
      // Alt+arrastar duplica: as cópias nascem onde o fantasma ficou.
      for (const it of d.items) {
        if (it.type !== "board") continue;
        const at = { x: Math.round(it.box.x + ox), y: Math.round(it.box.y + oy) };
        void createRecorded("duplicate", async () => ({ id: (await designApi.duplicateArtboard(it.id, at)).artboardId }), (x) => designApi.deleteArtboard(x));
      }
      return;
    }
    persistUnstacked();
    const moves = d.items.map((it) => ({ it, to: { x: Math.round(it.box.x + ox), y: Math.round(it.box.y + oy) } }));
    for (const { it, to } of moves) void act(geoApi(it.type, it.id, to), [it.id]);
    record({
      label: "move",
      undo: () => Promise.all(moves.map(({ it }) => geoApi(it.type, it.id, { x: it.box.x, y: it.box.y }))),
      redo: () => Promise.all(moves.map(({ it, to }) => geoApi(it.type, it.id, to))),
    });
  };

  // ---------- comentários: pinos e popovers ----------
  const pins: PinItem[] = useMemo(() => {
    const out: PinItem[] = [];
    threads.forEach(({ root }, i) => {
      if (root.resolved) return;
      const b = boardById.get(root.artboardId);
      if (!b) return;
      const pos = pinPosition(root, b, root.anchor ? rects[root.id] ?? null : null);
      out.push({ id: root.id, n: i + 1, x: pos.x, y: pos.y, active: thread === root.id });
    });
    if (draft) out.push({ id: "__draft", n: 0, x: draft.wx, y: draft.wy, active: true, draft: true });
    return out;
  }, [threads, boardById, rects, thread, draft]);

  const openThread = threads.find((th) => th.root.id === thread) ?? null;
  const popAt = (wx: number, wy: number) => { const s = toScreen(cam, wx, wy); return popoverPlacement(s.x, s.y, size.w, size.h); };

  const submitDraft = async (text: string, send: boolean) => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    await act(designApi.addAnchoredComment({ artboardId: d.boardId, text, selector: d.anchor, anchor: d.anchor, pointX: d.pointX, pointY: d.pointY }));
    if (send) await sendToAgent(d.boardId, d.label, d.text, text, d.anchor);
  };
  const threadLabel = (root: DesignComment & { anchor: string | null }) => `${boardById.get(root.artboardId)?.title ?? ""}${root.anchor ? ` › ${root.anchor.split(" > ").pop()}` : ""}`;

  // ---------- render ----------
  const focusedBoard = focused ? boardById.get(focused.id) ?? null : null;
  const passThrough = (tool !== "select" && tool !== "comment") || space || dragUi !== null;
  const single = selBoards.length === 1 && selNotes.length === 0 && selShapes.length === 0 ? selBoards[0] : null;
  const singleShape = selShapes.length === 1 && selBoards.length === 0 && selNotes.length === 0 ? shapes.find((x) => x.id === selShapes[0]) ?? null : null;
  const singleNote = selNotes.length === 1 && selBoards.length === 0 && selShapes.length === 0 ? notes.find((x) => x.id === selNotes[0]) ?? null : null;
  const cursor = space || tool === "hand" ? "cursor-grab" : tool === "comment" ? "cursor-cell" : tool === "text" ? "cursor-text" : tool !== "select" ? "cursor-crosshair" : "";
  const sheet = rootW > 0 && rootW < 600;

  // Camadas: a árvore do DOM da prancheta selecionada vem do iframe (carrega a prancheta se preciso).
  const panelBoard = single ? boardById.get(single) ?? null : null;
  useEffect(() => {
    if (!panelOpen || panelTab !== "layers" || !panelBoard) return;
    if (!live.has(panelBoard.id)) { setPinned((p) => (p.has(panelBoard.id) ? p : new Set(p).add(panelBoard.id))); return; }
    postToFrame(frames.current.get(panelBoard.id) ?? null, { kind: "tree" });
  }, [panelOpen, panelTab, panelBoard?.id, panelBoard?.version, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // A barra rápida: só com um elemento escolhido numa prancheta viva, na Seleção.
  const pickedOne = picked.length === 1 ? picked[0] : null;
  const quickBoard = pickedOne && tool === "select" && elRect && !draft ? boardById.get(pickedOne.artboardId) ?? null : null;
  const quickAt = quickBoard && elRect ? (() => {
    const o = toScreen(cam, quickBoard.x + elRect.x, quickBoard.y + elRect.y);
    return quickBarPlacement({ x: o.x, y: o.y, w: elRect.w * cam.scale, h: elRect.h * cam.scale }, size.w);
  })() : null;

  const toolbar = (
    <StudioToolbar
      leading={leading} trailing={trailing} padRight={padRight} mod={mod}
      pages={pages} pageId={page?.id ?? null} onPage={setPageId}
      onAddPage={() => { if (detail) void act(designApi.addPage(detail.design.id, nextName(t("design.studio.pageBase"), pages.map((p) => p.name)))); }}
      onRenamePage={(id, name) => void act(designApi.renamePage(id, name))}
      onDeletePage={async (id) => {
        const pg = pages.find((x) => x.id === id);
        const ok = await appConfirm({ title: t("design.studio.deletePageTitle"), lead: t("design.studio.deletePageLead", { name: pg?.name ?? "" }), confirmLabel: t("design.studio.delete"), cancelLabel: t("design.studio.cancel"), tone: "danger" });
        if (ok) { if (id === page?.id) setPageId(pages.find((x) => x.id !== id)?.id ?? null); void act(designApi.deletePage(id)); }
      }}
      onCopyPageLink={(id) => copy(openCommand(designId, { pageId: id }), t("design.studio.linkCopied"))}
      tool={tool} onTool={(next) => { if (tool === "pen") finishPen(); chooseTool(nextTool(tool, next)); }}
      scale={cam.scale} onZoomIn={() => zoomStep(1)} onZoomOut={() => zoomStep(-1)} onFit={() => { setFollowing(false); fitAll(); }} onPreset={zoomPreset}
      lastDraw={lastDraw} lastShape={lastShape} guides={guides} onToggleGuides={() => setGuides((g) => !g)}
      panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((o) => !o)}
      exportBoard={single ? exportFor(single) : null}
      focused={focusedBoard ? { title: focusedBoard.title, fit: focused!.fit, onFit: (fit) => setFocused((f) => (f ? { ...f, fit } : f)), onBack: exitFocus } : null}
    />
  );

  return (
    <div ref={rootRef} tabIndex={-1} className="relative h-full w-full flex flex-col min-h-0 outline-none bg-white dark:bg-surface-deep"
      onPointerDownCapture={() => { active.current = true; }}>
      {toolbar}
      <div className="relative flex flex-1 min-h-0">
      {focusedBoard ? (
        <FocusedView board={focusedBoard} fit={focused!.fit} register={(el) => { if (el) frames.current.set(`focus:${focusedBoard.id}`, el); else frames.current.delete(`focus:${focusedBoard.id}`); }} />
      ) : (
        <div ref={surfaceRef} role="application" aria-label={t("design.studio.canvas")}
          className={`relative flex-1 min-h-0 overflow-hidden select-none bg-gray-100 dark:bg-surface-sunken ${cursor}`}
          onPointerDown={onSurfaceDown} onPointerMove={onSurfaceMove} onPointerUp={onSurfaceUp} onPointerCancel={onSurfaceUp}
          onContextMenu={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}>
          <div className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${-cam.x * cam.scale}px, ${-cam.y * cam.scale}px) scale(${cam.scale})`,
              ["--s" as string]: String(cam.scale), ["--inv" as string]: String(1 / clampScale(cam.scale)),
              willChange: dragUi || glide.current !== null ? "transform" : undefined,
            }}>
            {notes.map((n) => (
              <StudioNote key={n.id} note={n} selected={selNotes.includes(n.id)} onDown={noteDown} onSave={noteSave} onContext={noteMenu} />
            ))}
            {boards.map((b) => (
              <ArtboardFrame key={b.id} board={b} live={live.has(b.id)} selected={selBoards.includes(b.id)} grips={single === b.id}
                passThrough={playing.has(b.id) ? dragUi !== null : passThrough} agent={agentFlash[b.id] ? agentName : null} renaming={renaming === b.id}
                playing={playing.has(b.id)} editing={playing.has(b.id) && selBoards.includes(b.id) && tool === "select"} guides={guides} h={stable} />
            ))}
            {shapes.map((x) => (
              <ShapeView key={x.id} shape={x} selected={selShapes.includes(x.id)} editing={editingShape === x.id}
                onDown={shapeDown} onEditStart={shapeEditStart} onEditEnd={shapeEditEnd} onContext={shapeMenu} />
            ))}
            {singleShape && singleShape.kind !== "text" && (() => {
              const b = shapeBox(singleShape);
              return (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
                <div key={c} role="presentation" onPointerDown={(e) => onShapeGrip(e, singleShape.id, c)}
                  className="absolute w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
                  style={{ left: c.includes("w") ? b.x : b.x + b.w, top: c.includes("n") ? b.y : b.y + b.h, cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize", transform: "scale(var(--inv))" }}>
                  <div className="w-2 h-2 rounded-[2px] bg-white border border-accent-500" />
                </div>
              ));
            })()}
            {(dragUi?.stroke || pen.length > 0 || dragUi?.shape) && (
              <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={1} height={1}>
                {dragUi?.stroke && <polyline points={dragUi.stroke.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" strokeWidth={2} className="stroke-gray-900" strokeLinecap="round" strokeLinejoin="round" />}
                {pen.length > 0 && <polyline points={pen.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" strokeWidth={2} className="stroke-accent-500" />}
                {pen.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={3} className="fill-white stroke-accent-500" strokeWidth={1} />)}
                {dragUi?.shape && (dragUi.shape.kind === "rect"
                  ? <rect x={dragUi.shape.x} y={dragUi.shape.y} width={dragUi.shape.w} height={dragUi.shape.h} fill="none" strokeWidth={2} className="stroke-gray-900" />
                  : dragUi.shape.kind === "oval"
                    ? <ellipse cx={dragUi.shape.x + dragUi.shape.w / 2} cy={dragUi.shape.y + dragUi.shape.h / 2} rx={dragUi.shape.w / 2} ry={dragUi.shape.h / 2} fill="none" strokeWidth={2} className="stroke-gray-900" />
                    : <line x1={dragUi.shape.x} y1={dragUi.shape.y} x2={dragUi.shape.x + dragUi.shape.w} y2={dragUi.shape.y + dragUi.shape.h} strokeWidth={2} className="stroke-gray-900" />)}
              </svg>
            )}
            <CommentPins pins={pins} onOpen={(id) => { if (id !== "__draft") { setDraft(null); setThread(id); } }} />
            {dragUi?.guides?.map((g, i) => (
              <div key={i} className="absolute pointer-events-none bg-accent-500"
                style={g.axis === "x"
                  ? { left: g.pos, top: g.from, height: g.to - g.from, width: "calc(1px * var(--inv))" }
                  : { top: g.pos, left: g.from, width: g.to - g.from, height: "calc(1px * var(--inv))" }} />
            ))}
            {dragUi?.ghosts?.map((g, i) => (
              <div key={i} className="absolute pointer-events-none rounded-sm"
                style={{ left: g.x, top: g.y, width: g.w, height: g.h, outline: "calc(1.5px * var(--inv)) dashed color-mix(in oklch, var(--color-accent-500) 70%, transparent)" }}>
                <span className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-accent-500 text-white text-[13px] leading-5 text-center origin-top-right" style={{ transform: "scale(var(--inv))" }}>+</span>
              </div>
            ))}
            {(dragUi?.marquee || dragUi?.create) && (() => {
              const r = (dragUi.marquee ?? dragUi.create)!;
              return <div className="absolute pointer-events-none bg-accent-500/10"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h, outline: "calc(1px * var(--inv)) solid var(--color-accent-500)" }} />;
            })()}
          </div>

          {detail && boards.length === 0 && notes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center pointer-events-none">
              <p className="max-w-sm text-[13px] text-gray-500 dark:text-white/45">{t("design.studio.emptyPage")}</p>
              <button type="button" className="pointer-events-auto h-8 px-3 rounded-md bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10 text-[13px] text-gray-800 dark:text-white/85 hover:bg-gray-50 dark:hover:bg-white/10"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => addBoardAt({ ...nextBoardSlot([]), w: BOARD_DEFAULT.w, h: BOARD_DEFAULT.h })}>
                {t("design.studio.addBoard")}
              </button>
            </div>
          )}
          {!detail && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-gray-500 dark:text-white/45">
              {error ? (
                <>
                  <p className="max-w-sm text-center">{t("design.studio.loadError", { error })}</p>
                  <button type="button" className="h-7 px-3 rounded-md ring-1 ring-gray-200 dark:ring-white/10 hover:bg-white dark:hover:bg-white/10" onClick={() => void reload()}>{t("design.studio.retry")}</button>
                </>
              ) : loading ? t("design.studio.loading") : null}
            </div>
          )}
          {tool === "comment" && !draft && (
            <div className="absolute left-1/2 bottom-3 -translate-x-1/2 px-3 h-7 leading-7 rounded-full bg-gray-900/85 text-white text-[12px] pointer-events-none">
              {t("design.comments.hint")}
            </div>
          )}

          {quickBoard && quickAt && pickedOne && (
            <QuickBar at={quickAt} canEditText={pickedOne.kind === "text"}
              onEditText={() => { postToFrame(frames.current.get(quickBoard.id) ?? null, { kind: "editText", selector: pickedOne.selector }); setElRect(null); }}
              onComment={() => {
                if (!elRect) return;
                setDraft({ boardId: quickBoard.id, anchor: clampAnchor(pickedOne.selector), pointX: 0.5, pointY: 0.5, label: pickedOne.label, text: "",
                  wx: quickBoard.x + elRect.x + elRect.w / 2, wy: quickBoard.y + elRect.y + elRect.h / 2 });
              }}
              onDelete={() => void editElement(quickBoard.id, pickedOne.selector, "remove")}
              onMore={() => { setPanelOpen(true); setPanelTab("layers"); }} />
          )}
          {lastBump && (
            <button type="button" aria-pressed={following} onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { const on = !following; setFollowing(on); if (on && boardById.has(lastBump)) fitBoard(lastBump); }}
              title={following ? t("design.follow.stopHint") : t("design.follow.hint")}
              className={`absolute right-3 top-3 z-20 h-7 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[12px] font-medium shadow
                ${following ? "bg-violet-500 text-white" : "bg-white dark:bg-surface-raised text-violet-600 dark:text-violet-300 ring-1 ring-violet-500/40"}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {following ? t("design.follow.on", { name: agentName }) : t("design.follow.off", { name: agentName })}
            </button>
          )}
          {draft && (
            <CommentComposer at={popAt(draft.wx, draft.wy)} label={draft.label} onCancel={() => setDraft(null)} onSubmit={(text, send) => void submitDraft(text, send)} />
          )}
          {openThread && !draft && (() => {
            const b = boardById.get(openThread.root.artboardId);
            const pin = pins.find((p) => p.id === openThread.root.id);
            if (!b || !pin) return null;
            const root = openThread.root;
            return (
              <CommentThread at={popAt(pin.x, pin.y)} root={root} replies={openThread.replies} label={threadLabel(root)}
                onClose={() => setThread(null)}
                onResolve={() => { void act(designApi.resolveComment(root.id, !root.resolved)); setThread(null); }}
                onReply={(text) => void act(designApi.addAnchoredComment({ artboardId: root.artboardId, text, parentId: root.id }))}
                onSend={() => void sendToAgent(root.artboardId, threadLabel(root), "", [root, ...openThread.replies].map((c) => c.text).join("\n"), root.anchor)} />
            );
          })()}
        </div>
      )}
      {panelOpen && !focusedBoard && (
        <StudioPanel tab={panelTab} onTab={setPanelTab} width={panelWidth} onWidth={setPanelWidth} sheet={sheet} onClose={() => setPanelOpen(false)}
          board={panelBoard ? { ...panelBoard, contentHeight: contentH.current[panelBoard.id] ?? null } : null}
          note={singleNote} shape={singleShape}
          onBoard={(patch) => {
            if (!panelBoard) return;
            if (patch.title) { void act(designApi.updateArtboard(panelBoard.id, { title: patch.title })); return; }
            if (patch.radius !== undefined) {
              const from = panelBoard.radius;
              void act(designApi.updateArtboard(panelBoard.id, { radius: patch.radius }));
              record({ label: "style", undo: () => designApi.updateArtboard(panelBoard.id, { radius: from }), redo: () => designApi.updateArtboard(panelBoard.id, { radius: patch.radius }) });
              return;
            }
            const from = { x: panelBoard.x, y: panelBoard.y, w: panelBoard.w, h: panelBoard.h };
            setBox("board", panelBoard.id, from, { ...from, ...patch });
          }}
          onFitHeight={() => { if (panelBoard) fitHeight(panelBoard.id); }}
          onNote={(patch) => {
            if (!singleNote) return;
            if ("color" in patch) { void act(designApi.updateNote(singleNote.id, { color: patch.color ?? null })); return; }
            const from = { x: singleNote.x, y: singleNote.y, w: singleNote.w, h: singleNote.h };
            setBox("note", singleNote.id, from, { ...from, ...patch });
          }}
          onShape={(patch) => { if (singleShape) patchShape(singleShape.id, patch); }}
          tree={tree && panelBoard && tree.boardId === panelBoard.id ? tree.nodes : null}
          treeSelected={pickedOne && panelBoard && pickedOne.artboardId === panelBoard.id ? pickedOne.selector : null}
          onPickNode={(selector) => {
            if (!panelBoard) return;
            postToFrame(frames.current.get(panelBoard.id) ?? null, { kind: "highlight", selector });
            setElRect(null);
            setPicked([{ artboardId: panelBoard.id, selector, kind: "other", label: selector.split(" > ").pop() ?? selector }]);
          }}
          onRefreshTree={() => { if (panelBoard) postToFrame(frames.current.get(panelBoard.id) ?? null, { kind: "tree" }); }}
          onSaveHtml={(html, v) => (panelBoard ? saveHtml(panelBoard.id, html, v) : Promise.resolve("error" as const))}
          onSaveTweaks={(values) => {
            const a = panelBoard ? detail?.artboards.find((x) => x.id === panelBoard.id) : null;
            if (a) void saveHtml(a.id, writeTweaks(a.html, values), a.version);
          }} />
      )}
      </div>
      <div aria-live="polite" className="sr-only">{announce}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * O modo focado: uma prancheta só, viva como protótipo clicável (links entre pranchetas navegam).
 * Preencher = o tamanho da janela; Caber = o tamanho dela, reduzido para caber.
 */
function FocusedView({ board, fit, register }: { board: StudioBoard; fit: "fill" | "fit"; register: (el: HTMLIFrameElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const srcDoc = useMemo(() => studioSrcdoc(board.html), [board.html]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const pad = 24;
  const k = fit === "fit" && box.w > 0 ? Math.min(1, (box.w - pad * 2) / board.w, (box.h - pad * 2) / board.h) : 1;
  const w = fit === "fill" ? box.w : board.w;
  const h = fit === "fill" ? box.h : board.h;
  return (
    <div ref={ref} className="relative flex-1 min-h-0 overflow-hidden bg-gray-100 dark:bg-surface-sunken">
      {box.w > 0 && (
        <div className={`absolute bg-white overflow-clip ${fit === "fit" ? "shadow-[0_2px_4px_rgba(24,24,27,0.07),0_6px_16px_rgba(24,24,27,0.08)] ring-1 ring-gray-200 dark:ring-white/10" : ""}`}
          style={{
            width: w, height: h, left: fit === "fill" ? 0 : (box.w - w * k) / 2, top: fit === "fill" ? 0 : (box.h - h * k) / 2,
            transform: k !== 1 ? `scale(${k})` : undefined, transformOrigin: "0 0", borderRadius: fit === "fit" ? board.radius : 0,
          }}>
          <iframe key={board.id} title={board.title} sandbox={DESIGN_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer"
            ref={(el) => { frame.current = el; register(el); }}
            onLoad={() => postToFrame(frame.current, { kind: "mode", mode: "play" })}
            className="block border-0 w-full h-full" />
        </div>
      )}
    </div>
  );
}

/** Para a aba do painel e a rota: um botão que abre a mesma tela em tela cheia. */
export function OpenFullButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="w-8 h-7 rounded-md flex items-center justify-center text-gray-600 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10">
      <ExpandIcon />
    </button>
  );
}
