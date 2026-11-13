import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

// Se cargan con la primera tab de cada tipo que se muestra: el editor (CodeMirror) y el
// navegador pesan más de un megabyte y la mayoría de las sesiones arrancan solo con
// terminales.
const BrowserTab = lazy(() => import("@/features/browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));
const DiffTab = lazy(() => import("@/features/editor/DiffTab").then((m) => ({ default: m.DiffTab })));
const FileTab = lazy(() => import("@/features/editor/FileTab").then((m) => ({ default: m.FileTab })));
const GeminiDesktopTab = lazy(() => import("@/features/desktopApps/GeminiDesktopTab"));
import { focusGroup, placeStyle, usePlacements, type Rect } from "@/features/tabs/layout/layoutStore";
import { viewKey } from "@/features/tabs/layout/layoutTree";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { placeChatBrowserFloat, useChatStore } from "@/features/chat/store";
import { chatFloatBounds, dragFloatRect, FLOAT_RING, type FloatEdges } from "@/features/chat/floatRect";
import { useTranslation } from "react-i18next";
import { BrowserMiniControls } from "@/features/browser/BrowserMiniControls";
import { FLOATING_PREVIEW_CORNER_RADIUS } from "@/features/browser/nativeCorner";
import { canvasActions, useActiveBoardKey, useCanvasStore, useWorkMode } from "@/features/canvas/store";
import { comparablePath, type ViewTab } from "@/features/tabs/viewTabs";
import { useChatShell } from "@/app/uiStore";
import { isPageRoute } from "@/features/chat/chatRoutes";

/**
 * Donde se dibujan las tabs de archivo, diff y navegador: encima de las terminales.
 *
 * Una vez abiertas quedan montadas, igual que las terminales, y solo las visibles se ven —
 * una por grupo—: un navegador que se desmonta pierde la página y su estado; un editor, el
 * deshacer y el cursor. Pero se montan recién la primera vez que se muestran — las que se
 * restauran al abrir la app están en la barra sin cargar nada hasta que alguien las mira.
 */
export function ViewTabsHost() {
  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const mode = useWorkMode();
  const boardKey = useActiveBoardKey();
  const portals = useCanvasStore((s) => boardKey ? s.boards[boardKey]?.portals : undefined);
  const desktopRects = useCanvasStore((s) => s.desktopRects);
  const desktop = views.find((v) => v.kind === "desktop");
  useEffect(() => {
    if (mode !== "canvas" || !boardKey || !desktop || activeViewId !== desktop.id) return;
    const { id } = canvasActions.addPortal(boardKey, { kind: "gemini", name: "Gemini Desktop", at: { x: 20, y: 20 } });
    const box = useCanvasStore.getState().boards[boardKey]?.portals[id]?.box;
    if (box && (box.w < 640 || box.h < 420)) canvasActions.moveNode(boardKey,id,{ w: Math.max(box.w,1000), h: Math.max(box.h,700) });
    canvasActions.focusDesktop(boardKey,id);
    useViewTabsStore.getState().showTerminal();
  }, [mode, boardKey, desktop, activeViewId]);
  const keepMountedIds = useViewTabsStore((s) => s.keepMountedIds);
  const floating = useChatStore((s) => s.browserFloating);
  const chatBrowser = useChatStore((s) => s.browser);
  const pathname = useLocation().pathname;
  // O chat não é uma rota: com ele na tela, a vista que ele mostra (o navegador do painel) conta como na tela.
  const chatOn = useChatShell();
  const onWorkspace = pathname.startsWith("/workspace") || (chatOn && !isPageRoute(pathname));
  // Solo las del workspace activo tienen lugar: una de otro nunca se muestra.
  const { visible, focusedItem } = usePlacements();
  const lastRect = useRef(new Map<string, Rect | null>());
  const desktopNode = mode === "canvas" && portals ? Object.entries(portals).find(([, p]) => p.kind === "gemini") : undefined;
  const desktopRect = desktopNode && desktopRects[desktopNode[0]];
  const boardCwd = boardKey?.split("|").slice(1).join("|").split("#m:")[0];
  // No chat só aparece o navegador do painel direito (nunca o Gemini Desktop do canvas).
  const chat = chatOn;
  const floatingBrowserId = chatOn && floating ? chatBrowser?.viewId ?? null : null;
  const floatRect = useChatStore((s) => s.browserFloatRect);
  const bodyDrag = useFloatBodyDrag();
  const floatView = floatingBrowserId ? views.find((v) => v.id === floatingBrowserId) : undefined;
  const placementOf = (view: ViewTab) => {
    if (view.kind === "browser" && view.id === floatingBrowserId && isPageRoute(pathname)) return undefined;
    return view.kind === "desktop" && mode === "canvas" && !chat
      ? (desktopRect && !activeViewId && boardCwd === comparablePath(view.cwd) ? { groupId: "canvas", rect: desktopRect } : undefined)
      : visible.get(viewKey(view.id));
  };

  const [seen, setSeen] = useState<Set<string>>(new Set());
  const visibleIds = views.filter((v) => placementOf(v) !== undefined).map((v) => v.id);
  const unseen = visibleIds.filter((id) => !seen.has(id)).join("|");
  useEffect(() => {
    if (unseen) setSeen((prev) => new Set([...prev, ...unseen.split("|")]));
  }, [unseen]);

  // Un click adentro de la página de un navegador no le llega a la app: el `<iframe>` se lo
  // queda. Lo que sí se nota es que la ventana pierde el foco y queda en ese `<iframe>`, y
  // con eso se sabe a qué grupo fue.
  const placementsRef = useRef(visible);
  placementsRef.current = visible;
  useEffect(() => {
    const onBlur = () => setTimeout(() => {
      const frame = document.activeElement;
      if (frame?.tagName !== "IFRAME") return;
      const key = frame.closest<HTMLElement>("[data-view-key]")?.dataset.viewKey;
      const groupId = key ? placementsRef.current.get(key)?.groupId : undefined;
      if (groupId) focusGroup(groupId);
    }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  if (views.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" }}>
      {views.map((view) => {
        const key = viewKey(view.id);
        const placement = placementOf(view);
        const shown = placement !== undefined;
        const floatingPreview = view.kind === "browser" && view.id === floatingBrowserId;
        if (!shown && !seen.has(view.id) && !keepMountedIds.includes(view.id)) return null;
        if (placement) lastRect.current.set(key, placement.rect);
        const focused = key === focusedItem && onWorkspace;
        return (
          <div
            key={view.id}
            data-view-key={key}
            style={{
              ...placeStyle(lastRect.current.get(key) ?? null),
              ...(floatingPreview ? { zIndex: 30, borderRadius: FLOATING_PREVIEW_CORNER_RADIUS } : {}),
              visibility: shown ? undefined : "hidden",
              pointerEvents: shown ? "auto" : "none",
            }}
            className={floatingPreview ? "flex flex-col overflow-hidden rounded-2xl bg-white dark:bg-surface" : undefined}
            onPointerDownCapture={() => placement?.groupId && focusGroup(placement.groupId)}
            {...(floatingPreview ? bodyDrag : {})}
          >
            {floatingPreview && <BrowserFloatGrip />}
            <Suspense fallback={null}>
              {view.kind === "file" && <FileTab view={view} active={shown && onWorkspace} focused={focused} />}
              {view.kind === "diff" && <DiffTab view={view} active={shown && onWorkspace} />}
              {view.kind === "browser" && <BrowserTab view={view} active={focused} floatingPreview={floatingPreview} />}
              {view.kind === "desktop" && <GeminiDesktopTab view={view} active={shown && onWorkspace} canvas={mode === "canvas"} />}
            </Suspense>
          </div>
        );
      })}
      {floatView && floatRect && placementOf(floatView) !== undefined && <BrowserFloatFrame rect={floatRect} />}
    </div>
  );
}

/** Controles da miniatura, no canto da página (abrem um buraco na vista nativa só enquanto aparecem). */
function BrowserFloatGrip() {
  // O mouse sobre a página nativa não chega ao DOM: quem avisa é o motor (`real-browser-mini-hover`).
  const hover = useChatStore((state) => state.browserMiniHover);
  return (
    <div className="group absolute right-2.5 top-2.5 z-40 pointer-events-auto" data-browser-mini-controls data-hover={hover}
      {...(hover ? { "data-over-webview": "" } : {})}>
      <BrowserMiniControls />
    </div>
  );
}

type FloatDrag = { pointerId: number; x: number; y: number; rect: Rect; edges: FloatEdges };

/** Arraste da miniatura: sem lados move, com lados redimensiona. Usa pointer capture no elemento que recebeu o toque. */
function useFloatDrag() {
  const drag = useRef<FloatDrag | null>(null);
  const begin = (event: React.PointerEvent<HTMLElement>, edges: FloatEdges) => {
    if (event.button !== 0) return;
    const current = useChatStore.getState().browserFloatRect;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: current, edges };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const bounds = chatFloatBounds();
    if (!bounds) return;
    placeChatBrowserFloat(dragFloatRect(start.rect, start.edges, event.clientX - start.x, event.clientY - start.y, bounds));
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { begin, move, end };
}

/** O que, dentro da página em DOM (página inicial), continua sendo clique e não arraste. */
const INTERACTIVE = "a,button,input,textarea,select,label,[role=button],[role=link],[contenteditable],[data-browser-mini-controls]";

/** Com a página em DOM, arrastar qualquer ponto que não seja controle move a miniatura. */
export function useFloatBodyDrag() {
  const { begin, move, end } = useFloatDrag();
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if ((event.target as Element).closest?.(INTERACTIVE)) return;
      begin(event, {});
    },
    onPointerMove: move, onPointerUp: end, onPointerCancel: end,
  };
}

const RING_PARTS: { key: string; edges: FloatEdges; cursor: string; style: (r: number) => React.CSSProperties }[] = [
  // Os cantos vêm antes: ficam por cima das faixas das bordas.
  { key: "nw", edges: { left: true, top: true }, cursor: "nwse-resize", style: (r) => ({ left: 0, top: 0, width: 2 * r, height: 2 * r }) },
  { key: "ne", edges: { right: true, top: true }, cursor: "nesw-resize", style: (r) => ({ right: 0, top: 0, width: 2 * r, height: 2 * r }) },
  { key: "sw", edges: { left: true, bottom: true }, cursor: "nesw-resize", style: (r) => ({ left: 0, bottom: 0, width: 2 * r, height: 2 * r }) },
  { key: "se", edges: { right: true, bottom: true }, cursor: "nwse-resize", style: (r) => ({ right: 0, bottom: 0, width: 2 * r, height: 2 * r }) },
  // Topo: mover. Laterais e base: redimensionar.
  { key: "top", edges: {}, cursor: "move", style: (r) => ({ left: 2 * r, right: 2 * r, top: 0, height: r }) },
  { key: "left", edges: { left: true }, cursor: "ew-resize", style: (r) => ({ left: 0, top: 2 * r, bottom: 2 * r, width: r }) },
  { key: "right", edges: { right: true }, cursor: "ew-resize", style: (r) => ({ right: 0, top: 2 * r, bottom: 2 * r, width: r }) },
  { key: "bottom", edges: { bottom: true }, cursor: "ns-resize", style: (r) => ({ left: 2 * r, right: 2 * r, bottom: 0, height: r }) },
];

/**
 * Anel invisível em volta da miniatura: a borda de cima move, as laterais, a base e os cantos redimensionam.
 * Fica FORA do retângulo da página: a vista nativa é desenhada por cima do DOM, então nada dentro dela recebe o mouse.
 */
export function BrowserFloatFrame({ rect }: { rect: Rect }) {
  const { t } = useTranslation();
  const { begin, move, end } = useFloatDrag();
  const r = FLOAT_RING;
  return (
    <div data-browser-float-frame className="absolute z-30 pointer-events-none"
      style={{ left: rect.left - r, top: rect.top - r, width: rect.width + 2 * r, height: rect.height + 2 * r }}>
      <div data-browser-float-surface
        className="absolute pointer-events-none border border-gray-200 dark:border-white/12 shadow-md shadow-gray-950/20"
        style={{
          left: r - 1,
          top: r - 1,
          width: rect.width + 2,
          height: rect.height + 2,
          borderRadius: FLOATING_PREVIEW_CORNER_RADIUS + 1,
        }} />
      {RING_PARTS.map((part) => (
        <div key={part.key} data-float-ring={part.key} role="separator"
          aria-label={t(part.key === "top" ? "browser.mini.move" : "browser.mini.resize")}
          title={t(part.key === "top" ? "browser.mini.move" : "browser.mini.resize")}
          onPointerDown={(event) => begin(event, part.edges)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          className="absolute touch-none"
          style={{ ...part.style(r), cursor: part.cursor, pointerEvents: "auto" }} />
      ))}
    </div>
  );
}
