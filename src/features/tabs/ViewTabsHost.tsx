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
import { setChatBrowserFloatRect, useChatStore } from "@/features/chat/store";
import { BrowserMiniControls } from "@/features/browser/BrowserMiniControls";
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
              ...(floatingPreview ? { zIndex: 30 } : {}),
              visibility: shown ? undefined : "hidden",
              pointerEvents: shown ? "auto" : "none",
            }}
            className={floatingPreview ? "resize flex flex-col overflow-hidden rounded-2xl border border-gray-200 dark:border-white/12 bg-white dark:bg-surface shadow-2xl" : undefined}
            onPointerDownCapture={() => placement?.groupId && focusGroup(placement.groupId)}
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
    </div>
  );
}

/** Faixa estreita para mover o mini preview sem interceptar os controles da página. */
function BrowserFloatGrip() {
  // O mouse sobre a página nativa não chega ao DOM: quem avisa é o motor (`real-browser-mini-hover`).
  const hover = useChatStore((state) => state.browserMiniHover);
  const drag = useRef<{ pointerId: number; x: number; y: number; rect: Rect } | null>(null);
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const state = useChatStore.getState();
    const rect = state.browserFloatRect ?? state.browser?.rect;
    if (!state.browserFloating || !rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const shell = event.currentTarget.closest<HTMLElement>("[data-chat-shell]");
    const main = shell?.querySelector<HTMLElement>("main");
    if (!shell || !main) return;
    const shellRect = shell.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const minLeft = Math.round(mainRect.left - shellRect.left + 8);
    const minTop = Math.round(mainRect.top - shellRect.top + 8);
    const maxLeft = Math.round(mainRect.right - shellRect.left - start.rect.width - 8);
    const maxTop = Math.round(mainRect.bottom - shellRect.top - start.rect.height - 8);
    const left = Math.max(minLeft, Math.min(maxLeft, start.rect.left + event.clientX - start.x));
    const top = Math.max(minTop, Math.min(maxTop, start.rect.top + event.clientY - start.y));
    setChatBrowserFloatRect({ ...start.rect, left: Math.round(left), top: Math.round(top) });
  };
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    // Só abre o buraco na página enquanto a pílula aparece; fora disso a miniatura mostra a página inteira.
    <div className="group absolute right-2.5 top-2.5 z-40 pointer-events-auto" data-browser-mini-controls data-hover={hover}
      {...(hover ? { "data-over-webview": "" } : {})}>
      <div aria-hidden="true" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        className="absolute -right-0.5 -top-0.5 z-10 size-3 cursor-grab touch-none active:cursor-grabbing">
        <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-gray-400/70 shadow-sm ring-1 ring-white/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 dark:bg-white/35 dark:ring-black/30" />
      </div>
      <BrowserMiniControls />
    </div>
  );
}
