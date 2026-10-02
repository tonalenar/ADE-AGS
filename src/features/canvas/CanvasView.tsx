import "@xyflow/react/dist/style.css";

import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, NodeResizer,
  Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps, type Connection,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { AlertaToast, Button, CloseIcon, useTheme } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWizard } from "@/features/tabs/tabActions";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import type { BrowserView } from "@/features/tabs/viewTabs";
import type { Tab } from "@/features/tabs/types";
import { screenOf } from "@/features/terminal/terminalRegistry";

import {
  NOTE_MIN, PORTAL_MIN, boxOf, emptyBoard, isFreeNodeId, neighbors, thin, type CanvasNote, type CanvasPortal, type Stroke,
} from "./board";
import { CanvasToolbar, type DrawStyle, type Tool } from "./CanvasToolbar";
import { DrawingLayer } from "./DrawingLayer";
import { ImageNode, TextNode, type ImageFlowNode, type TextFlowNode } from "./ExtraNodes";
import { DeviceNode } from "./DeviceNode";
import { FolderNode, baseName, type FolderFlowNode } from "./FolderNode";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  HEADER_H, MAX_ZOOM, MIN_ZOOM, NODE_MIN, facingSides, focusViewport, intersects, isLive, terminalRect,
  type Box, type Rect, type Viewport,
} from "./geometry";
import { CanvasDock, type DockPanel } from "./CanvasDock";
import { useUiStore } from "@/app/uiStore";
import { PetCard, usePetStatus } from "@/shared/brand/Pet";
import { ChatPanel } from "./ChatPanel";
import { RoutinesPanel } from "./RoutinesPanel";
import { boardKey, canvasActions, useActiveBoardKey, useCanvasStore } from "./store";

interface AgentNodeData extends Record<string, unknown> {
  tab: Tab;
  box: Box;
  live: boolean;
  links: number;
  orchestrator: boolean;
  role?: string;
  onFocus: (tabId: string) => void;
  onToggleOrchestrator: (tabId: string) => void;
}

type AgentFlowNode = Node<AgentNodeData, "agent">;

interface NoteNodeData extends Record<string, unknown> {
  id: string;
  note: CanvasNote;
  links: number;
}

type NoteFlowNode = Node<NoteNodeData, "note">;

interface PortalNodeData extends Record<string, unknown> {
  id: string;
  cwd: string;
  portal: CanvasPortal;
  links: number;
}

type PortalFlowNode = Node<PortalNodeData, "portal">;
type FlowNode = AgentFlowNode | NoteFlowNode | PortalFlowNode | TextFlowNode | ImageFlowNode | FolderFlowNode;

// El navegador pesa más de un megabyte: se baja con el primer portal, no con el canvas.
const BrowserTab = lazy(() => import("@/features/browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));

/**
 * El canvas de agentes: cada terminal de la carpeta es un nodo que se mueve, se
 * redimensiona y se conecta con otros. Una conexión deja que esos dos agentes se hablen
 * (`ccode peer ...`, ver el backend).
 *
 * El canvas va DEBAJO de las terminales: `TerminalPanel` las dibuja encima de cada nodo
 * con los rectángulos que se calculan acá (`liveRects`). Así ninguna terminal se remonta —
 * desmontar una mata su proceso — y ninguna se escala (ver `geometry.ts`).
 */
export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

/**
 * Devuelve los mismos objetos de nodo de la vez anterior mientras su firma no cambie.
 *
 * Mover un nodo cambia el canvas entero, y sin esto cada cuadro del arrastre reconstruía
 * TODOS los nodos: cada terminal, cada nota y, sobre todo, cada portal (un navegador
 * completo) se volvía a renderizar mientras el usuario movía uno solo. Con la identidad
 * conservada, solo se renderiza el que se está moviendo.
 */
function useStable<T extends { id: string }>(nodes: T[], signature: (node: T) => string): T[] {
  const cache = useRef(new Map<string, { signature: string; node: T }>());
  return useMemo(() => {
    const next = new Map<string, { signature: string; node: T }>();
    const out = nodes.map((node) => {
      const sig = signature(node);
      const hit = cache.current.get(node.id);
      const entry = hit && hit.signature === sig ? hit : { signature: sig, node };
      next.set(node.id, entry);
      return entry.node;
    });
    cache.current = next;
    return out;
    // `signature` es una función de módulo en cada uso: no cambia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);
}

const boxSig = (b: { x: number; y: number; w: number; h: number }) => `${b.x},${b.y},${b.w},${b.h}`;

const agentSig = (n: AgentFlowNode) =>
  [n.id, n.data.tab.title, n.data.tab.agentId, n.data.tab.agentLabel, boxSig(n.data.box), n.selected, n.data.live,
    n.data.links, n.data.orchestrator, n.data.role].join("|");
const noteSig = (n: NoteFlowNode) => [n.id, n.data.note.name, boxSig(n.data.note.box), n.selected, n.data.links, n.data.note.content].join("|");
const portalSig = (n: PortalFlowNode) =>
  [n.id, n.data.portal.name, n.data.portal.url, boxSig(n.data.portal.box), n.selected, n.data.links, n.data.cwd].join("|");

const textSig = (n: TextFlowNode) => [n.id, n.data.text.text, n.data.text.size, boxSig(n.data.text.box), n.selected].join("|");
const folderSig = (n: FolderFlowNode) =>
  [n.id, n.data.folder.path, n.data.folder.name, n.data.folder.open.join(","), boxSig(n.data.folder.box), n.selected, n.data.cwd].join("|");
const imageSig = (n: ImageFlowNode) => [n.id, n.data.image.asset, n.data.image.name, boxSig(n.data.image.box), n.selected].join("|");

function CanvasInner() {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const board = useCanvasStore((s) => (key ? s.boards[key] : undefined)) ?? emptyBoard();
  const allTabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const rf = useReactFlow();

  const tabs = useMemo(() => (key ? allTabs.filter((t) => boardKey(t.cwd) === key) : []), [allTabs, key]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // La vista se lleva en estado local (cambia en cada cuadro del paneo) y se guarda al soltar.
  const [vp, setVp] = useState<Viewport>(board.viewport);
  useEffect(() => { setVp(useCanvasStore.getState().boards[key ?? ""]?.viewport ?? emptyBoard().viewport); }, [key]);
  const live = isLive(vp.zoom);

  // Dónde va cada terminal viva. Fuera del área no se dibuja: una terminal que nadie ve no
  // tiene por qué repintar.
  useEffect(() => {
    if (!live || size.width === 0) {
      canvasActions.setLiveRects({});
      return;
    }
    const rects: Record<string, Rect> = {};
    for (const tab of tabs) {
      const box = board.nodes[tab.id];
      if (!box) continue;
      const rect = terminalRect(box, vp);
      if (intersects(rect, size.width, size.height)) rects[tab.id] = rect;
    }
    canvasActions.setLiveRects(rects);
  }, [live, vp, board.nodes, tabs, size]);

  useEffect(() => () => canvasActions.setLiveRects({}), []);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const focusNode = (tabId: string) => {
    const size = sizeRef.current;
    const box = useCanvasStore.getState().boards[key ?? ""]?.nodes[tabId];
    if (!box || size.width === 0) return;
    activateTab(tabId);
    rf.setViewport(focusViewport(box, size.width, size.height), { duration: 220 });
  };

  // Elegir un agente desde afuera (la tira de tabs, la paleta) lo trae a la vista si no se ve.
  const lastActive = useRef(activeTabId);
  useEffect(() => {
    if (activeTabId === lastActive.current) return;
    lastActive.current = activeTabId;
    const box = activeTabId ? board.nodes[activeTabId] : undefined;
    if (!box || size.width === 0) return;
    const onScreen = {
      left: box.x * vp.zoom + vp.x, top: box.y * vp.zoom + vp.y, width: box.w * vp.zoom, height: box.h * vp.zoom,
    };
    if (!intersects(onScreen, size.width, size.height)) {
      rf.setViewport(
        { zoom: vp.zoom, x: size.width / 2 - (box.x + box.w / 2) * vp.zoom, y: size.height / 2 - (box.y + box.h / 2) * vp.zoom },
        { duration: 220 },
      );
    }
    // Solo cuando cambia el agente activo, no con cada paneo.
  }, [activeTabId]);

  // Un panel a la vez: los dos se abren en el mismo lugar.
  const [panel, setPanel] = useState<DockPanel | null>(null);
  const pet = usePetStatus();
  const workspacesCollapsed = useUiStore((s) => s.workspacesCollapsed);

  // La herramienta activa y cómo se dibuja. Dibujar y borrar son un modo; lo demás pone
  // algo en el centro de la vista y vuelve a seleccionar.
  const [tool, setTool] = useState<Tool>("select");
  const [drawStyle, setDrawStyle] = useState<DrawStyle>({ color: "#ef4444", width: 4 });
  const [liveStroke, setLiveStroke] = useState<Stroke | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Una nota o un portal seleccionado no es un agente activo: se lleva aparte.
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const rawAgentNodes: AgentFlowNode[] = useMemo(() => tabs.flatMap((tab) => {
    const box = board.nodes[tab.id];
    if (!box) return [];
    return [{
      id: tab.id,
      type: "agent" as const,
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      selected: tab.id === activeTabId,
      // Con la terminal viva encima del nodo, solo la cabecera queda libre para agarrar;
      // alejado, la tarjeta es una vista previa y se agarra de cualquier lado.
      dragHandle: live ? ".ade-node-drag" : undefined,
      deletable: false,
      data: {
        tab, box, live,
        links: neighbors(board, tab.id).length,
        orchestrator: board.orchestrators.includes(tab.id),
        role: board.roles[tab.id],
        onFocus: focusNode,
        onToggleOrchestrator: (id: string) => key && canvasActions.toggleOrchestrator(key, id),
      },
    }];
    // `focusNode` cambia con cada render y no aporta nada nuevo al nodo.
  }), [tabs, board, activeTabId, live]);

  const rawNoteNodes: NoteFlowNode[] = useMemo(() => Object.entries(board.notes).map(([id, note]) => ({
    id,
    type: "note" as const,
    position: { x: note.box.x, y: note.box.y },
    width: note.box.w,
    height: note.box.h,
    selected: id === selectedNote,
    deletable: false,
    data: { id, note, links: neighbors(board, id).length },
  })), [board, selectedNote]);

  const portalCwd = tabs[0]?.cwd ?? "";
  const rawPortalNodes: PortalFlowNode[] = useMemo(() => Object.entries(board.portals).map(([id, portal]) => ({
    id,
    type: "portal" as const,
    position: { x: portal.box.x, y: portal.box.y },
    width: portal.box.w,
    height: portal.box.h,
    selected: id === selectedNote,
    dragHandle: ".ade-node-drag",
    deletable: false,
    data: { id, cwd: portalCwd, portal, links: neighbors(board, id).length },
  })), [board, selectedNote, portalCwd]);

  const rawTextNodes: TextFlowNode[] = useMemo(() => Object.entries(board.texts).map(([id, text]) => ({
    id,
    type: "text" as const,
    position: { x: text.box.x, y: text.box.y },
    width: text.box.w,
    height: text.box.h,
    selected: id === selectedNote,
    dragHandle: ".ade-node-drag",
    deletable: false,
    data: { id, text },
  })), [board.texts, selectedNote]);

  const rawImageNodes: ImageFlowNode[] = useMemo(() => Object.entries(board.images).map(([id, image]) => ({
    id,
    type: "image" as const,
    position: { x: image.box.x, y: image.box.y },
    width: image.box.w,
    height: image.box.h,
    selected: id === selectedNote,
    deletable: false,
    data: { id, image },
  })), [board.images, selectedNote]);

  const rawFolderNodes: FolderFlowNode[] = useMemo(() => Object.entries(board.folders).map(([id, folder]) => ({
    id,
    type: "folder" as const,
    position: { x: folder.box.x, y: folder.box.y },
    width: folder.box.w,
    height: folder.box.h,
    selected: id === selectedNote,
    dragHandle: ".ade-node-drag",
    deletable: false,
    data: { id, cwd: portalCwd, folder },
  })), [board.folders, selectedNote, portalCwd]);

  const agentNodes = useStable(rawAgentNodes, agentSig);
  const folderNodes = useStable(rawFolderNodes, folderSig);
  const textNodes = useStable(rawTextNodes, textSig);
  const imageNodes = useStable(rawImageNodes, imageSig);
  const noteNodes = useStable(rawNoteNodes, noteSig);
  const portalNodes = useStable(rawPortalNodes, portalSig);

  const nodes: FlowNode[] = useMemo(
    () => [...imageNodes, ...folderNodes, ...noteNodes, ...portalNodes, ...agentNodes, ...textNodes],
    [imageNodes, folderNodes, noteNodes, portalNodes, agentNodes, textNodes],
  );

  // Una conexión con un agente de otro piso no tiene punta en este canvas: no se dibuja.
  const edges: Edge[] = useMemo(() => board.edges.filter((e) => boxOf(board, e.a) && boxOf(board, e.b)).map((e) => {
    const a = boxOf(board, e.a);
    const b = boxOf(board, e.b);
    // Sale por el lado que mira al otro nodo: la curva no cruza su propio nodo.
    const [sourceHandle, targetHandle] = a && b ? facingSides(a, b) : ["r", "l"];
    return { id: e.id, source: e.a, target: e.b, sourceHandle, targetHandle, type: "link" };
  }), [board]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    if (!key) return;
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        canvasActions.moveNode(key, c.id, { x: Math.round(c.position.x), y: Math.round(c.position.y) });
      } else if (c.type === "dimensions" && c.resizing && c.dimensions) {
        canvasActions.moveNode(key, c.id, { w: Math.round(c.dimensions.width), h: Math.round(c.dimensions.height) });
      } else if (c.type === "select") {
        if (isFreeNodeId(c.id)) setSelectedNote(c.selected ? c.id : (prev) => (prev === c.id ? null : prev));
        else if (c.selected) activateTab(c.id);
      }
    }
  };

  /** El centro de lo que se ve, en coordenadas del canvas: donde aparece lo que se agrega. */
  const viewCenter = () => ({ x: (size.width / 2 - vp.x) / vp.zoom, y: (size.height / 2 - vp.y) / vp.zoom });

  const addNoteHere = () => {
    if (!key) return;
    const c = viewCenter();
    const { id } = canvasActions.addNote(key, { name: t("canvas.noteDefaultName"), content: "", at: { x: c.x - 160, y: c.y - 120 } });
    setSelectedNote(id);
  };
  const addPortalHere = () => {
    if (!key) return;
    const c = viewCenter();
    const { id } = canvasActions.addPortal(key, { name: t("canvas.portalDefaultName"), at: { x: c.x - 320, y: c.y - 220 } });
    setSelectedNote(id);
  };
  const addDeviceHere = () => {
    if (!key) return;
    const c = viewCenter();
    const { id } = canvasActions.addPortal(key, { name: t("canvas.device.defaultName"), kind: "android", at: { x: c.x - 160, y: c.y - 320 } });
    setSelectedNote(id);
  };
  /** Una carpeta del disco: se elige con el diálogo del sistema y se pone con su árbol a la vista. */
  const addFolderHere = async () => {
    if (!key) return;
    try {
      const picked = await pickFolder({ directory: true, multiple: false, defaultPath: portalCwd || undefined });
      if (typeof picked !== "string") return;
      const c = viewCenter();
      setSelectedNote(canvasActions.addFolder(key, { path: picked, name: baseName(picked), at: { x: c.x - 150, y: c.y - 190 } }));
    } catch (e) {
      AlertaToast(t("canvas.tool.folder"), String(e), "error", 6000);
    }
  };
  const addTextHere = () => {
    if (!key) return;
    const c = viewCenter();
    setSelectedNote(canvasActions.addText(key, { x: c.x - 120, y: c.y - 24 }));
    setTool("select");
  };

  /** Una imagen elegida del disco: se copia a la carpeta de la app (ver `canvas::assets`) y
   *  el canvas guarda solo su id. */
  const addImageFrom = async (file: File) => {
    if (!key) return;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error(t("canvas.image.invalid")));
        img.src = data;
      });
      const asset = await invoke<string>("canvas_asset_save", { data });
      setSelectedNote(canvasActions.addImage(key, { name: file.name, asset, ...dims, at: viewCenter() }));
    } catch (e) {
      AlertaToast(t("canvas.tool.image"), String(e instanceof Error ? e.message : e), "error", 6000);
    }
  };

  // Dibujar: el trazo se sigue en coordenadas del canvas y se guarda al soltar. Los eventos se
  // atienden en captura sobre el contenedor para quitárselos a React Flow (que si no, movería
  // el fondo), y solo si empiezan DENTRO del canvas: no en la barra de herramientas ni en los
  // paneles, que están fuera de `.react-flow`.
  const inCanvas = (e: React.PointerEvent) => (e.target as HTMLElement).closest(".react-flow") !== null;
  const strokeWidth = drawStyle.width / vp.zoom;
  const onDrawDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== "draw" || e.button !== 0 || !inCanvas(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const stroke: Stroke = { id: "live", points: [at.x, at.y], color: drawStyle.color, width: strokeWidth };
    strokeRef.current = stroke;
    setLiveStroke(stroke);
  };
  const onDrawMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = { ...stroke, points: [...stroke.points, at.x, at.y] };
    strokeRef.current = next;
    setLiveStroke(next);
  };
  const onDrawUp = () => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    setLiveStroke(null);
    if (!stroke || !key) return;
    // Un toque sin movimiento es un punto: se dibuja como una marca corta.
    const points = stroke.points.length === 2 ? [...stroke.points, stroke.points[0] + 0.01, stroke.points[1]] : stroke.points;
    canvasActions.addStroke(key, { points: thin(points, 1.5 / vp.zoom), color: stroke.color, width: stroke.width });
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!key) return;
    for (const c of changes) if (c.type === "remove") canvasActions.disconnect(key, c.id);
  };

  const onConnect = (c: Connection) => {
    if (key && c.source && c.target) canvasActions.connect(key, c.source, c.target);
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 bg-gray-50 dark:bg-surface-deep"
      style={{ cursor: tool === "draw" ? "crosshair" : undefined }}
      onPointerDownCapture={onDrawDown} onPointerMoveCapture={onDrawMove} onPointerUpCapture={onDrawUp}
      onPointerCancelCapture={onDrawUp}>
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        viewport={vp}
        onViewportChange={setVp}
        onMoveEnd={(_, v) => key && canvasActions.setViewport(key, v)}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        colorMode={theme === "dark" ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
        panOnDrag={tool === "select"}
        nodesDraggable={tool === "select"}
        nodesConnectable={tool === "select"}
        elementsSelectable={tool === "select"}
        deleteKeyCode={["Delete", "Backspace"]}
        connectionLineStyle={{ stroke: "var(--color-accent-400)", strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <DrawingLayer strokes={board.drawings} live={liveStroke} erasing={tool === "erase"}
          onErase={(id) => key && canvasActions.removeStroke(key, id)} />
      </ReactFlow>
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
        <CanvasToolbar
          tool={tool} onTool={setTool} style={drawStyle} onStyle={setDrawStyle}
          onTerminal={() => openNewAgentWizard()}
          onNote={addNoteHere} onPortal={addPortalHere} onDevice={addDeviceHere} onText={addTextHere}
          onImage={() => fileInput.current?.click()} onFolder={() => void addFolderHere()}
          onUndo={() => key && canvasActions.undoStroke(key)} canUndo={board.drawings.length > 0} />
        {panel === "routines" && <RoutinesPanel onClose={() => setPanel(null)} />}
        {panel === "chat" && <ChatPanel onClose={() => setPanel(null)} />}
        {/* Con la columna de workspaces abierta, el pet vive ahí; plegada, viene al canvas. */}
        {workspacesCollapsed && <PetCard pet={pet} className="pointer-events-auto absolute left-3 bottom-3" />}
      </div>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void addImageFrom(file);
        }} />
      <CanvasDock zoom={vp.zoom} panel={panel} onTogglePanel={(p) => setPanel((cur) => (cur === p ? null : p))} onOpenChat={() => setPanel("chat")}
        petPercent={Math.round(pet.progress * 100)}
        onFit={() => rf.fitView({ padding: 0.12, maxZoom: 1, duration: 220 })}
        onReset={() => {
          const target = activeTabId && board.nodes[activeTabId] ? activeTabId : tabs[0]?.id;
          if (target) focusNode(target);
        }} />
    </div>
  );
}

// ── Nodo ────────────────────────────────────────────────────────────

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useTranslation();
  const { tab, box, live, links, orchestrator, role, onFocus, onToggleOrchestrator } = data;
  const Icon = agentIcon(tab.agentId, tab.agentId);
  const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-gray-400! dark:bg-gray-500!";

  return (
    <div
      className={`group h-full w-full flex flex-col rounded-lg overflow-hidden
        border bg-white dark:bg-surface
        ${selected
          ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]"
          : orchestrator
            ? "border-glow/70 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-glow)_35%,transparent)]"
            : "border-gray-300 dark:border-white/12"}`}
    >
      <NodeResizer isVisible={selected} minWidth={NODE_MIN.w} minHeight={NODE_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />

      {/* Los puntos de conexión van a la altura de la cabecera: más abajo quedarían
          debajo de la terminal viva, que se dibuja encima del nodo. */}
      <Handle id="l" type="source" position={Position.Left} style={{ top: HEADER_H / 2 }} className={handle} />
      <Handle id="r" type="source" position={Position.Right} style={{ top: HEADER_H / 2 }} className={handle} />
      {/* Arriba y abajo, para los equipos apilados. El de abajo queda medio tapado por la
          terminal viva al 100 %: se usa sobre todo para dibujar, y ahí el canvas está alejado. */}
      <Handle id="t" type="source" position={Position.Top} className={handle} />
      <Handle id="b" type="source" position={Position.Bottom} className={handle} />

      <div
        className="ade-node-drag flex items-center gap-2 px-3 shrink-0 cursor-grab active:cursor-grabbing select-none
          border-b border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-surface-raised"
        style={{ height: HEADER_H }}
        onDoubleClick={() => onFocus(tab.id)}
        title={t("canvas.focusHint")}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
        <span className="truncate text-[12.5px] font-medium text-gray-800 dark:text-gray-100">{tab.title}</span>
        <span className="truncate text-[11px] text-gray-400 dark:text-gray-500">{tab.agentLabel}</span>
        {role && (
          <span className="shrink-0 max-w-28 truncate text-[10px] font-semibold uppercase tracking-wider px-1.5 rounded
            text-violet-700 dark:text-violet-300 bg-violet-500/12" title={t("canvas.role", { role })}>
            {role}
          </span>
        )}
        {orchestrator && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 rounded
            text-amber-700 dark:text-glow bg-glow/15">
            {t("canvas.orchestrator")}
          </span>
        )}
        <span className="flex-1" />
        {/* `nodrag`: sin esto el clic arrastraría el nodo en vez de apretar el botón. */}
        <Button variant="custom"
          onClick={() => onToggleOrchestrator(tab.id)}
          aria-pressed={orchestrator}
          title={orchestrator ? t("canvas.orchestratorOff") : t("canvas.orchestratorOn")}
          className={`nodrag cc-t shrink-0 flex items-center justify-center w-6 h-6 rounded-md
            ${orchestrator
              ? "text-amber-600 dark:text-glow"
              : "text-gray-300 dark:text-white/20 hover:text-gray-600 dark:hover:text-white/60"}
            hover:bg-gray-200/70 dark:hover:bg-white/8`}
        >
          <CrownIcon className="w-3.5 h-3.5" />
        </Button>
        {links > 0 && (
          <span className="shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full
            bg-gray-200/70 dark:bg-white/8 text-gray-500 dark:text-gray-400" title={t("canvas.links", { count: links })}>
            ⇄ {links}
          </span>
        )}
      </div>

      {/* Al 100 % la terminal viva está encima de este hueco. Alejado, una vista previa. */}
      <div className="relative flex-1 min-h-0">
        {!live && <Preview tabId={tab.id} rows={Math.max(4, Math.floor((box.h - HEADER_H) / 15))} onOpen={() => onFocus(tab.id)} />}
      </div>
    </div>
  );
});

function CrownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5L3 7.5Z" />
      <rect x="5" y="19.5" width="14" height="2" rx="1" />
    </svg>
  );
}

/** Las últimas líneas de la terminal, como texto: escalan con el zoom sin romper nada. */
function Preview({ tabId, rows, onOpen }: { tabId: string; rows: number; onOpen: () => void }) {
  const [lines, setLines] = useState<string[]>(() => screenOf(tabId, null, rows)?.lines ?? []);
  useEffect(() => {
    const read = () => setLines(screenOf(tabId, null, rows)?.lines ?? []);
    read();
    const timer = window.setInterval(read, 1500);
    return () => window.clearInterval(timer);
  }, [tabId, rows]);

  return (
    <pre
      onDoubleClick={onOpen}
      className="absolute inset-0 m-0 px-3 py-2 overflow-hidden whitespace-pre font-mono text-[12px] leading-[15px]
        text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-surface"
    >
      {lines.join("\n")}
    </pre>
  );
}

// ── Nota ────────────────────────────────────────────────────────────

/**
 * Una nota: texto libre que el usuario edita acá y los agentes conectados leen y escriben
 * con `ccode note …`. El texto se edita directo sobre el store, así lo que escribe un
 * agente aparece al instante y lo que escribe el usuario llega a su próximo `note read`.
 */
const NoteNode = memo(function NoteNode({ data, selected }: NodeProps<NoteFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, note, links } = data;
  const [armed, setArmed] = useState(false);
  const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-amber-400! dark:bg-amber-500!";

  // Borrar pide un segundo clic: una nota puede ser el plan entero de un agente.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <div
      className={`h-full w-full flex flex-col rounded-lg overflow-hidden border
        bg-amber-50 dark:bg-amber-950/40
        ${selected
          ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]"
          : "border-amber-300/80 dark:border-amber-200/15"}`}
    >
      <NodeResizer isVisible={selected} minWidth={NOTE_MIN.w} minHeight={NOTE_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />
      <Handle id="l" type="source" position={Position.Left} className={handle} />
      <Handle id="r" type="source" position={Position.Right} className={handle} />
      <Handle id="t" type="source" position={Position.Top} className={handle} />
      <Handle id="b" type="source" position={Position.Bottom} className={handle} />

      <div
        className="ade-node-drag flex items-center gap-2 pl-3 pr-1.5 shrink-0 cursor-grab active:cursor-grabbing
          border-b border-amber-200 dark:border-amber-100/10 bg-amber-100/70 dark:bg-amber-100/5"
        style={{ height: HEADER_H }}
      >
        <NoteIcon className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-300/80" />
        <input
          value={note.name}
          onChange={(e) => key && canvasActions.updateNote(key, id, { name: e.target.value })}
          aria-label={t("canvas.noteName")}
          spellCheck={false}
          className="nodrag min-w-0 flex-1 bg-transparent outline-none text-[12.5px] font-medium
            text-gray-800 dark:text-gray-100 focus:bg-white/60 dark:focus:bg-white/5 rounded px-1 -mx-1"
        />
        {links > 0 && (
          <span className="shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full
            bg-amber-200/70 dark:bg-white/8 text-amber-800 dark:text-gray-400" title={t("canvas.links", { count: links })}>
            ⇄ {links}
          </span>
        )}
        <Button variant="custom"
          onClick={() => {
            if (!key) return;
            if (armed) canvasActions.removeNote(key, id);
            else setArmed(true);
          }}
          title={armed ? t("canvas.noteDeleteConfirm") : t("canvas.noteDelete")}
          aria-label={armed ? t("canvas.noteDeleteConfirm") : t("canvas.noteDelete")}
          className={`nodrag cc-t shrink-0 flex items-center justify-center h-6 rounded-md
            ${armed
              ? "px-2 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
              : "w-6 text-gray-400 hover:text-red-500 hover:bg-amber-200/60 dark:hover:bg-white/8"}`}
        >
          {armed ? t("canvas.noteDeleteConfirm") : <CloseIcon className="w-3 h-3" />}
        </Button>
      </div>

      <textarea
        value={note.content}
        onChange={(e) => key && canvasActions.updateNote(key, id, { content: e.target.value })}
        placeholder={t("canvas.notePlaceholder")}
        aria-label={note.name}
        spellCheck={false}
        // Seleccionada, el campo es de escribir (`nodrag`); sin seleccionar, la nota se agarra
        // de cualquier lado. `nowheel`: la rueda desplaza el texto, no hace zoom en el canvas.
        className={`${selected ? "nodrag nowheel" : ""} flex-1 min-h-0 w-full resize-none bg-transparent outline-none px-3 py-2
          font-mono text-[12px] leading-[17px] text-gray-800 dark:text-gray-200
          placeholder:text-amber-700/40 dark:placeholder:text-gray-500`}
      />
    </div>
  );
});

function NoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden>
      <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M15 3v5h5M8 13h8M8 17h5" />
    </svg>
  );
}

// ── Portal ──────────────────────────────────────────────────────────

/**
 * Un portal: un navegador dentro del canvas. Es el mismo `BrowserTab` de las tabs de
 * navegador — con su barra, su inspector y su proxy —, pero dibujado en el nodo y manejado
 * por los agentes conectados con `ccode portal …`. Se escala con el zoom: una página, a
 * diferencia de una terminal, aguanta bien un `transform`.
 */
const PortalNode = memo(function PortalNode({ data, selected }: NodeProps<PortalFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, cwd, portal, links } = data;
  const [armed, setArmed] = useState(false);
  const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-sky-400! dark:bg-sky-500!";

  // La vista del navegador se crea una vez, con la URL con que se guardó el portal.
  const ensure = useViewTabsStore((s) => s.ensurePortalView);
  const drop = useViewTabsStore((s) => s.dropPortalView);
  const view = useViewTabsStore((s) => s.portalViews.find((v) => v.id === id));
  useEffect(() => {
    ensure(id, cwd, portal.url);
    // Al borrar el portal (o cerrar el canvas) se suelta la vista y con ella el navegador.
    return () => drop(id);
    // La URL inicial solo cuenta al crear la vista.
  }, [id, cwd]);

  // Lo que el navegador va visitando se guarda en el canvas, para reabrir donde estaba.
  const shown = view?.url ?? "";
  useEffect(() => {
    if (key && shown && shown !== portal.url) canvasActions.updatePortal(key, id, { url: shown });
  }, [shown]);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <div
      className={`h-full w-full flex flex-col rounded-lg overflow-hidden border bg-white dark:bg-surface
        ${selected
          ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]"
          : "border-sky-300/80 dark:border-sky-200/20"}`}
    >
      <NodeResizer isVisible={selected} minWidth={PORTAL_MIN.w} minHeight={PORTAL_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />
      <Handle id="l" type="source" position={Position.Left} className={handle} />
      <Handle id="r" type="source" position={Position.Right} className={handle} />
      <Handle id="t" type="source" position={Position.Top} className={handle} />
      <Handle id="b" type="source" position={Position.Bottom} className={handle} />

      <div
        className="ade-node-drag flex items-center gap-2 pl-3 pr-1.5 shrink-0 cursor-grab active:cursor-grabbing
          border-b border-sky-200 dark:border-sky-100/10 bg-sky-50 dark:bg-sky-100/5"
        style={{ height: HEADER_H }}
      >
        <GlobeIcon className="w-3.5 h-3.5 shrink-0 text-sky-600 dark:text-sky-300/80" />
        <input
          value={portal.name}
          onChange={(e) => key && canvasActions.updatePortal(key, id, { name: e.target.value })}
          aria-label={t("canvas.portalName")}
          spellCheck={false}
          className="nodrag min-w-0 flex-1 bg-transparent outline-none text-[12.5px] font-medium
            text-gray-800 dark:text-gray-100 focus:bg-white/60 dark:focus:bg-white/5 rounded px-1 -mx-1"
        />
        {links > 0 && (
          <span className="shrink-0 text-[10.5px] tabular-nums px-1.5 rounded-full
            bg-sky-200/70 dark:bg-white/8 text-sky-800 dark:text-gray-400" title={t("canvas.links", { count: links })}>
            ⇄ {links}
          </span>
        )}
        <Button variant="custom"
          onClick={() => {
            if (!key) return;
            if (armed) canvasActions.removePortal(key, id);
            else setArmed(true);
          }}
          title={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          aria-label={armed ? t("canvas.portalDeleteConfirm") : t("canvas.portalDelete")}
          className={`nodrag cc-t shrink-0 flex items-center justify-center h-6 rounded-md
            ${armed
              ? "px-2 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600"
              : "w-6 text-gray-400 hover:text-red-500 hover:bg-sky-200/60 dark:hover:bg-white/8"}`}
        >
          {armed ? t("canvas.portalDeleteConfirm") : <CloseIcon className="w-3 h-3" />}
        </Button>
      </div>

      {/* `nodrag nowheel nopan`: dentro de la página, arrastrar y la rueda son de la página. */}
      <div className="nodrag nowheel nopan relative flex-1 min-h-0">
        {view && (
          <Suspense fallback={null}>
            <PortalBody view={view} active={selected} />
          </Suspense>
        )}
      </div>
    </div>
  );
});

/** El navegador dentro del portal. `memo`: mover o redimensionar el nodo no lo toca. */
const PortalBody = memo(function PortalBody({ view, active }: { view: BrowserView; active: boolean }) {
  return <BrowserTab view={view} active={active} />;
});

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
    </svg>
  );
}

// ── Conexión ────────────────────────────────────────────────────────

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        style={{
          stroke: selected ? "var(--color-accent-400)" : "var(--color-gray-400)",
          strokeWidth: selected ? 2.5 : 2,
        }}
      />
      {selected && key && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute pointer-events-auto"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <Button variant="custom"
              onClick={() => canvasActions.disconnect(key, id)}
              aria-label={t("canvas.disconnect")}
              title={t("canvas.disconnect")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-full shadow
                bg-white dark:bg-surface-raised border border-gray-300 dark:border-white/15
                text-gray-500 hover:text-red-500"
            >
              <CloseIcon className="w-3 h-3" />
            </Button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Un portal es un navegador, o la pantalla de un Android (`kind: "android"`). */
const PortalOrDevice = memo(function PortalOrDevice(props: NodeProps<PortalFlowNode>) {
  const { data, selected } = props;
  return data.portal.kind === "android"
    ? <DeviceNode id={data.id} portal={data.portal} links={data.links} selected={!!selected} />
    : <PortalNode {...props} />;
});

const NODE_TYPES = { agent: AgentNode, note: NoteNode, portal: PortalOrDevice, text: TextNode, image: ImageNode, folder: FolderNode };
const EDGE_TYPES = { link: LinkEdge };
