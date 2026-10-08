import "@xyflow/react/dist/style.css";

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background, BackgroundVariant, ConnectionMode, NodeResizer,
  Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type Connection,
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

import { isHiddenNote, shownNote, stackMembers,
  NOTE_MIN, PORTAL_MIN, boxOf, emptyBoard, isFreeNodeId, neighbors, thin, type CanvasNote, type CanvasPortal, type Stroke,
} from "./board";
import { CanvasToolbar, type DrawStyle, type Tool } from "./CanvasToolbar";
import { DrawingLayer } from "./DrawingLayer";
import { ImageNode, TextNode, type ImageFlowNode, type TextFlowNode } from "./ExtraNodes";
import { DeviceNode } from "./DeviceNode";
import { FolderNode, baseName, type FolderFlowNode } from "./FolderNode";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  HEADER_H, MAX_ZOOM, MIN_ZOOM, NODE_MIN, facingSides, focusViewport, intersects, isLive, safeViewport, terminalRect,
  type Box, type Rect, type Viewport,
} from "./geometry";
import { CanvasDock, type DockPanel } from "./CanvasDock";
import { useUiStore } from "@/app/uiStore";
import { PetCard, usePetStatus } from "@/shared/brand/Pet";
import { ChatPanel } from "./ChatPanel";
import { CORD_MAGNET, CordConnectionLine, CordEdge, CordPort, cordColor, flashNode } from "./cords";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { DesignPanel } from "./design/DesignPanel";
import { chooseOnBoard } from "./design/chooseProposal";
import { designApi, type Artboard } from "./design/designApi";
import {
  BOARD_NODE_PREFIX, DesignBoardNode, DesignFrameNode, DesignActionsContext, FRAME_NODE_PREFIX, isDesignNodeId,
  type DesignActions, type DesignBoardFlowNode, type DesignFrameFlowNode,
} from "./design/DesignNodes";
import { resolveOwner } from "./design/owner";
import { freeOrigin, layoutGroups, positionsToSave } from "./design/scope";
import { useScopedDesigns } from "./design/useScopedDesigns";
import { useCliOutdatedNotice } from "./cliStatus";
import { useMissionIndex } from "@/features/missions/groups";
import { RoutinesPanel } from "./RoutinesPanel";
import { boardKeyOfTab, canvasActions, missionOfKey, useActiveBoardKey, useCanvasStore } from "./store";
import { cleanPreviewLines } from "./previewText";

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
  /** Las notas de su pila (incluida ella), si está apilada. */
  stack: { id: string; name: string }[];
  /** Las demás notas que se ven: a cuáles se puede juntar. */
  others: { id: string; name: string }[];
}

type NoteFlowNode = Node<NoteNodeData, "note">;

interface PortalNodeData extends Record<string, unknown> {
  id: string;
  cwd: string;
  portal: CanvasPortal;
  links: number;
}

type PortalFlowNode = Node<PortalNodeData, "portal">;
type FlowNode = AgentFlowNode | NoteFlowNode | PortalFlowNode | TextFlowNode | ImageFlowNode | FolderFlowNode | DesignBoardFlowNode | DesignFrameFlowNode;

// El navegador pesa más de un megabyte: se baja con el primer portal, no con el canvas.
const BrowserTab = lazy(() => import("@/features/browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));

/**
 * El canvas de agentes: cada terminal de la carpeta es un nodo que se mueve, se
 * redimensiona y se conecta con otros. Una conexión deja que esos dos agentes se hablen
 * (`ags peer ...`, ver el backend).
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
const noteSig = (n: NoteFlowNode) => [
  n.id, n.data.note.name, boxSig(n.data.note.box), n.selected, n.data.links, n.data.note.content,
  n.data.stack.map((s) => s.id + s.name).join(","), n.data.others.map((o) => o.id + o.name).join(","),
].join("|");
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

  const tabs = useMemo(() => (key ? allTabs.filter((t) => boardKeyOfTab(t) === key) : []), [allTabs, key]);

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
  const [vp, setVpRaw] = useState<Viewport>(() => safeViewport(board.viewport));
  // Un NaN en la vista (guardada como `null`) dejaba el zoom en "NaN%" y el canvas sin moverse: se descarta.
  const setVp = useCallback((next: Viewport) => setVpRaw((prev) => safeViewport(next, prev)), []);
  useEffect(() => { setVp(safeViewport(useCanvasStore.getState().boards[key ?? ""]?.viewport, emptyBoard().viewport)); }, [key, setVp]);
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
  // As cordas são controladas: a seleção tem de viver aqui, senão o clique é descartado e o ✕ e o
  // Delete nunca aparecem (era por isso que não dava para desconectar).
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Puxando a ponta de uma corda: se soltar fora de qualquer alça, ela é desconectada.
  const reconnected = useRef(false);

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

  // Las notas tapadas por otra de su pila no se dibujan: se ve la del frente.
  const rawNoteNodes: NoteFlowNode[] = useMemo(() => Object.entries(board.notes).filter(([id]) => !isHiddenNote(board, id)).map(([id, note]) => ({
    id,
    type: "note" as const,
    position: { x: note.box.x, y: note.box.y },
    width: note.box.w,
    height: note.box.h,
    selected: id === selectedNote,
    deletable: false,
    data: {
      id,
      note,
      // Las conexiones de toda la pila se cuentan en la del frente.
      links: stackMembers(board, note.stack).concat(note.stack ? [] : [id]).reduce((n, m) => n + neighbors(board, m).length, 0),
      stack: stackMembers(board, note.stack).map((m) => ({ id: m, name: board.notes[m].name })),
      others: Object.entries(board.notes).filter(([oid]) => oid !== id && !isHiddenNote(board, oid)).map(([oid, o]) => ({ id: oid, name: o.name })),
    },
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

  // Las pranchetas de diseño de este canvas: nodos en una zona libre, a la derecha de lo que ya hay.
  const ownerTabs = useMemo(() => allTabs.map((tab) => ({ id: tab.id, title: tab.title })), [allTabs]);
  const missionIndex = useMissionIndex();
  useCliOutdatedNotice();
  const design = useScopedDesigns({ cwd: portalCwd || null, missionId: missionOfKey(key) });
  const boardRef = useRef(board);
  boardRef.current = board;
  // El origen se fija al aparecer los diseños: si siguiera a las terminales, la zona saltaría al arrastrar una.
  const designOrigin = useMemo(() => freeOrigin(boardRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, design.details.length]);
  const groups = useMemo(() => layoutGroups(design.details, designOrigin), [design.details, designOrigin]);
  // Posición mientras se arrastra una prancheta (se graba al soltar).
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  const designNodes = useMemo<FlowNode[]>(() => groups.flatMap((g) => {
    const detail = design.details.find((d) => d.design.id === g.designId);
    const frame: DesignFrameFlowNode = {
      id: FRAME_NODE_PREFIX + g.key, type: "designFrame", position: { x: g.frame.x, y: g.frame.y }, zIndex: -1,
      draggable: false, selectable: false, focusable: false, deletable: false,
      data: { title: t("canvas.design.frame", { name: g.title }), w: g.frame.w, h: g.frame.h },
    };
    const boards = g.boards.map((p): DesignBoardFlowNode => ({
      id: BOARD_NODE_PREFIX + p.board.id, type: "designBoard", position: dragPos[p.board.id] ?? { x: p.x, y: p.y },
      dragHandle: ".ade-node-drag", deletable: false, selectable: false, connectable: false,
      data: { board: p.board, comments: detail?.comments.filter((c) => c.artboardId === p.board.id && !c.resolved).length ?? 0, groupKey: g.key },
    }));
    return [frame, ...boards];
  }), [groups, dragPos, design.details, t]);

  const nodes: FlowNode[] = useMemo(
    () => [...designNodes, ...imageNodes, ...folderNodes, ...noteNodes, ...portalNodes, ...agentNodes, ...textNodes],
    [designNodes, imageNodes, folderNodes, noteNodes, portalNodes, agentNodes, textNodes],
  );

  // El modo de foco (solo el diseño) y a qué abre: el aviso, el botón EDITAR de un nodo o el último diseño.
  const [designFocus, setDesignFocus] = useState<{ designId?: string; editBoardId?: string } | null>(null);
  const openFocus = (initial: { designId?: string; editBoardId?: string } | null) => {
    design.markSeen();
    setDesignFocus(initial ?? {});
    setPanel("design");
  };
  const designActions = useMemo<DesignActions>(() => {
    const fail = (e: unknown) => AlertaToast(t("canvas.design.title"), String(e), "error", 6000);
    const run = (p: Promise<unknown>) => p.then(() => design.reload()).catch(fail);
    const designOf = (b: Artboard) => design.details.find((d) => d.artboards.some((a) => a.id === b.id));
    return {
      editing: null,
      onEdit: (b) => openFocus({ designId: designOf(b)?.design.id, editBoardId: b.id }),
      onApprove: (b) => void run(designApi.approve(b.id)),
      onReject: (b) => void run(designApi.reject(b.id)),
      onChoose: (b, pick) => {
        const d = designOf(b);
        if (d) void chooseOnBoard({ t, board: b, design: d.design, owner: resolveOwner(d.design, ownerTabs, missionIndex), pick, reload: design.reload });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.details, design.reload, ownerTabs, missionIndex, t]);
  /** Al soltar una prancheta: graba x/y (relativos a su página) y las hermanas que estaban apiladas. */
  const onDesignDragStop = (_: unknown, node: Node) => {
    if (!node.id.startsWith(BOARD_NODE_PREFIX)) return;
    const id = node.id.slice(BOARD_NODE_PREFIX.length);
    const group = groups.find((g) => g.boards.some((b) => b.board.id === id));
    if (!group) return;
    const saves = positionsToSave(group, id, node.position.x, node.position.y);
    Promise.all(saves.map((p) => designApi.updateArtboard(p.id, { x: p.x, y: p.y })))
      .then(() => design.reload())
      .catch((e) => AlertaToast(t("canvas.design.title"), String(e), "error", 6000))
      .finally(() => setDragPos({}));
  };

  // Una conexión con un agente de otro piso no tiene punta en este canvas: no se dibuja.
  // La punta en una nota tapada se dibuja en la del frente de su pila.
  const edges: Edge[] = useMemo(() => {
    const seen = new Set<string>();
    return board.edges.filter((e) => boxOf(board, e.a) && boxOf(board, e.b)).flatMap((e) => {
      const source = shownNote(board, e.a);
      const target = shownNote(board, e.b);
      const pair = [source, target].sort().join("|");
      if (source === target || seen.has(pair)) return [];
      seen.add(pair);
      const a = boxOf(board, source);
      const b = boxOf(board, target);
      // Sale por el lado que mira al otro nodo: la curva no cruza su propio nodo.
      const [sourceHandle, targetHandle] = a && b ? facingSides(a, b) : ["r", "l"];
      return [{ id: e.id, source, target, sourceHandle, targetHandle, type: "link", selected: e.id === selectedEdge,
        data: { color: cordColor(e.id), hovered: e.id === hoveredEdge } } as Edge];
    });
  }, [board, selectedEdge, hoveredEdge]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    if (!key) return;
    for (const c of changes) {
      if ("id" in c && isDesignNodeId(c.id)) {
        if (c.type === "position" && c.position && c.id.startsWith(BOARD_NODE_PREFIX)) {
          const pos = c.position;
          setDragPos((cur) => ({ ...cur, [c.id.slice(BOARD_NODE_PREFIX.length)]: pos }));
        }
        continue;
      }
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
    for (const c of changes) {
      if (c.type === "remove") canvasActions.disconnect(key, c.id);
      else if (c.type === "select") setSelectedEdge((cur) => (c.selected ? c.id : cur === c.id ? null : cur));
    }
  };

  const onConnect = (c: Connection) => {
    if (!key || !c.source || !c.target) return;
    canvasActions.connect(key, c.source, c.target);
    const made = useCanvasStore.getState().boards[key]?.edges.find(
      (e) => (e.a === c.source && e.b === c.target) || (e.a === c.target && e.b === c.source));
    if (made) flashNode(c.target, cordColor(made.id));
  };

  // Puxar a ponta: soltar numa alça reconecta; soltar no vazio desconecta.
  const onReconnectStart = (_: unknown, edge: Edge) => {
    reconnected.current = false;
    wrapRef.current?.style.setProperty("--cord-magnet", cordColor(edge.id));
  };
  const onReconnect = (old: Edge, c: Connection) => {
    if (!key || !c.source || !c.target) return;
    reconnected.current = true;
    const same = (old.source === c.source && old.target === c.target) || (old.source === c.target && old.target === c.source);
    if (same) return;
    canvasActions.disconnect(key, old.id);
    canvasActions.connect(key, c.source, c.target);
    flashNode(c.target, cordColor(old.id));
  };
  const onReconnectEnd = (_: unknown, edge: Edge) => {
    wrapRef.current?.style.removeProperty("--cord-magnet");
    if (!reconnected.current && key) canvasActions.disconnect(key, edge.id);
    reconnected.current = false;
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 bg-gray-50 dark:bg-surface-deep"
      style={{ cursor: tool === "draw" ? "crosshair" : undefined }}
      onPointerDownCapture={onDrawDown} onPointerMoveCapture={onDrawMove} onPointerUpCapture={onDrawUp}
      onPointerCancelCapture={onDrawUp}>
      <DesignActionsContext.Provider value={designActions}>
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onDesignDragStop}
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
        connectionLineComponent={CordConnectionLine}
        connectionRadius={CORD_MAGNET}
        edgesReconnectable={tool === "select"}
        reconnectRadius={26}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        onEdgeMouseEnter={(_, e) => setHoveredEdge(e.id)}
        onEdgeMouseLeave={(_, e) => setHoveredEdge((cur) => (cur === e.id ? null : cur))}
        onEdgeContextMenu={(ev, e) => { ev.preventDefault(); setEdgeMenu({ id: e.id, x: ev.clientX, y: ev.clientY }); }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <DrawingLayer strokes={board.drawings} live={liveStroke} erasing={tool === "erase"}
          onErase={(id) => key && canvasActions.removeStroke(key, id)} />
      </ReactFlow>
      </DesignActionsContext.Provider>
      {edgeMenu && key && (
        <ContextMenu x={edgeMenu.x} y={edgeMenu.y} onClose={() => setEdgeMenu(null)} items={[
          { key: "disconnect", label: t("canvas.disconnect"), danger: true, hint: "⌫", onSelect: () => canvasActions.disconnect(key, edgeMenu.id) },
        ]} />
      )}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
        <CanvasToolbar
          tool={tool} onTool={setTool} style={drawStyle} onStyle={setDrawStyle}
          onTerminal={() => openNewAgentWizard()}
          onNote={addNoteHere} onPortal={addPortalHere} onDevice={addDeviceHere} onText={addTextHere}
          onImage={() => fileInput.current?.click()} onFolder={() => void addFolderHere()}
          onUndo={() => key && canvasActions.undoStroke(key)} canUndo={board.drawings.length > 0} />
        {panel === "routines" && <RoutinesPanel onClose={() => setPanel(null)} />}
        {panel === "design" && design.details.length > 0 && (
          <DesignPanel details={design.details} reload={design.reload} initial={designFocus} onClose={() => { setPanel(null); setDesignFocus(null); }} />
        )}
        {design.notice && (
          <div role="status" className="pointer-events-auto absolute right-3 bottom-16 flex items-center gap-2 rounded-lg border border-accent-500/40
            bg-white/95 dark:bg-surface-raised/95 shadow-lg px-3 py-2 text-[12.5px] text-gray-800 dark:text-gray-100">
            <span>{t("canvas.design.newDesign", { title: design.notice.title })}</span>
            <Button variant="custom" className="cc-t h-7 px-2.5 rounded-md bg-accent-500/15 text-accent-600 dark:text-accent-300 text-[11.5px] font-medium"
              onClick={() => openFocus({ designId: design.notice?.id })}>{t("canvas.design.open")}</Button>
            <Button variant="custom" onClick={design.dismissNotice} aria-label={t("canvas.design.close")} className="cc-t w-6 h-6 flex items-center justify-center text-gray-400">
              <CloseIcon className="w-3 h-3" />
            </Button>
          </div>
        )}
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
      <CanvasDock zoom={vp.zoom} panel={panel} onTogglePanel={(p) => (p === "design" ? (panel === "design" ? (setPanel(null), setDesignFocus(null)) : openFocus(null)) : setPanel((cur) => (cur === p ? null : p)))}
        hasDesign={design.details.length > 0} designUnseen={design.unseen} onOpenChat={() => setPanel("chat")}
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
  const handle = "ade-port z-10! w-3.5! h-3.5! border-[3px]! border-white! dark:border-surface! bg-gray-400! dark:bg-gray-200!";

  return (
    // As alças ficam FORA do cartão: dentro do `overflow-hidden` saíam cortadas pela metade e a de
    // baixo ficava por baixo do corpo do terminal — por isso era tão difícil puxar uma corda.
    <div className="relative h-full w-full">
      <NodeResizer isVisible={selected} minWidth={NODE_MIN.w} minHeight={NODE_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />

      {/* Los puntos de conexión van a la altura de la cabecera: más abajo quedarían
          debajo de la terminal viva, que se dibuja encima del nodo. */}
      <CordPort id="l" type="source" position={Position.Left} style={{ top: HEADER_H / 2 }} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} style={{ top: HEADER_H / 2 }} className={handle} />
      {/* Arriba y abajo, para los equipos apilados. El de abajo queda medio tapado por la
          terminal viva al 100 %: se usa sobre todo para dibujar, y ahí el canvas está alejado. */}
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />

      <div
        className={`group h-full w-full flex flex-col rounded-xl overflow-hidden
          bg-white dark:bg-surface
          ${selected
            ? "shadow-[0_0_0_1.5px_var(--color-accent-500),0_12px_32px_rgba(0,0,0,0.35)]"
            : orchestrator
              ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-glow)_55%,transparent),0_12px_32px_rgba(0,0,0,0.35)]"
              : "shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.07),0_12px_32px_rgba(0,0,0,0.45)]"}`}
      >
        <div
          className="ade-node-drag flex items-center gap-2 px-3.5 shrink-0 cursor-grab active:cursor-grabbing select-none
            border-b border-black/[0.06] dark:border-white/[0.07] bg-gray-50/80 dark:bg-surface"
          style={{ height: HEADER_H }}
          onDoubleClick={() => onFocus(tab.id)}
          title={t("canvas.focusHint")}
        >
          <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
          {/* "Codex — C:\…\ADE-AGS": o nome em destaque, o caminho em mono e apagado (como na prancheta). */}
          <span className="shrink-0 max-w-[45%] truncate text-[13px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-50">{tab.title.split(" — ")[0]}</span>
          {tab.title.includes(" — ")
            ? <span className="min-w-0 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500" title={tab.title}>{tab.title.split(" — ").slice(1).join(" — ")}</span>
            : <span className="truncate text-[11.5px] text-gray-400 dark:text-gray-500">{tab.agentLabel}</span>}
          {role && (
            <span className="shrink-0 max-w-28 truncate text-[10px] font-semibold uppercase tracking-[0.05em] px-2 py-0.5 rounded-full
              text-violet-700 dark:text-violet-300 bg-violet-500/15" title={t("canvas.role", { role })}>
              {role}
            </span>
          )}
          {orchestrator && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.05em] px-2 py-0.5 rounded-full
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
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums px-1.5 py-0.5 rounded-full
              bg-gray-200/70 dark:bg-white/[0.07] text-gray-500 dark:text-gray-400" title={t("canvas.links", { count: links })}>
              ⇄ {links}
            </span>
          )}
        </div>

        {/* Al 100 % la terminal viva está encima de este hueco. Alejado, una vista previa. */}
        <div className="relative flex-1 min-h-0">
          {!live && <Preview tabId={tab.id} rows={Math.max(4, Math.floor((box.h - HEADER_H) / 15))} onOpen={() => onFocus(tab.id)} />}
        </div>
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
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>(() => screenOf(tabId, null, rows)?.lines ?? []);
  useEffect(() => {
    const read = () => setLines(screenOf(tabId, null, rows)?.lines ?? []);
    read();
    const timer = window.setInterval(read, 1500);
    return () => window.clearInterval(timer);
  }, [tabId, rows]);

  return (
    <>
      <pre
        onDoubleClick={onOpen}
        title={t("canvas.preview.hint")}
        className="absolute inset-0 m-0 px-3.5 py-2.5 overflow-hidden whitespace-pre font-mono text-[12px] leading-[15px]
          text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-surface"
      >
        {cleanPreviewLines(lines).join("\n")}
      </pre>
      {/* Alejado, esto es solo una vista previa: no se escribe acá. El botón lleva la vista a la
          terminal al 100 %, donde sí está viva (antes solo se sabía con doble clic). */}
      <button
        type="button"
        className="nodrag nopan absolute bottom-2.5 right-2.5 h-7 px-3 rounded-full text-[11.5px] font-medium
          shadow-[0_4px_14px_rgba(10,132,255,0.35)] bg-accent-500 text-white hover:bg-accent-600"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
      >
        {t("canvas.preview.use")}
      </button>
    </>
  );
}

// ── Nota ────────────────────────────────────────────────────────────

/**
 * Una nota: texto libre que el usuario edita acá y los agentes conectados leen y escriben
 * con `ags note …`. El texto se edita directo sobre el store, así lo que escribe un
 * agente aparece al instante y lo que escribe el usuario llega a su próximo `note read`.
 */
const NoteNode = memo(function NoteNode({ data, selected }: NodeProps<NoteFlowNode>) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const { id, note, links, stack, others } = data;
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
      <CordPort id="l" type="source" position={Position.Left} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} className={handle} />
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />

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
        {/* Juntar con otra nota: un `select` nativo, porque el menú propio lo cortaría el borde del nodo. */}
        {others.length > 0 && (
          <select
            value=""
            onChange={(e) => key && e.target.value && canvasActions.stackNote(key, id, e.target.value)}
            title={t("canvas.stack.join")}
            aria-label={t("canvas.stack.join")}
            className="nodrag shrink-0 w-6 h-6 rounded-md text-[11px] text-center cursor-pointer outline-none appearance-none
              bg-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-amber-200/60 dark:hover:bg-white/8"
          >
            <option value="">⧉</option>
            {others.map((o) => <option key={o.id} value={o.id}>{t("canvas.stack.onto", { name: o.name })}</option>)}
          </select>
        )}
        {note.stack && (
          <Button variant="custom" onClick={() => key && canvasActions.unstackNote(key, id)}
            title={t("canvas.stack.release")} aria-label={t("canvas.stack.release")}
            className="nodrag cc-t shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[12px] text-gray-500
              hover:text-gray-800 dark:hover:text-gray-200 hover:bg-amber-200/60 dark:hover:bg-white/8">
            ⇱
          </Button>
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

      {/* Las solapas de la pila: cada nota con su nombre; la del frente, marcada. */}
      {stack.length > 1 && (
        <div className="nodrag nowheel flex items-center gap-0.5 px-1.5 pt-1 shrink-0 overflow-x-auto
          border-b border-amber-200 dark:border-amber-100/10 bg-amber-100/40 dark:bg-amber-100/3">
          {stack.map((m) => (
            <button key={m.id} type="button" onClick={() => key && canvasActions.bringNoteToFront(key, m.id)}
              className={`shrink-0 max-w-28 truncate px-2 h-5 rounded-t-md text-[10.5px]
                ${m.id === id
                  ? "bg-amber-50 dark:bg-amber-950/60 text-gray-900 dark:text-white font-medium"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-amber-200/50 dark:hover:bg-white/6"}`}>
              {m.name}
            </button>
          ))}
        </div>
      )}

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
 * por los agentes conectados con `ags portal …`. Se escala con el zoom: una página, a
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
      <CordPort id="l" type="source" position={Position.Left} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} className={handle} />
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />

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

// ── Conexión: ver `cords.tsx` (cordas, ímã y raio) ────────────────────

/** Un portal es un navegador, o la pantalla de un Android (`kind: "android"`). */
const PortalOrDevice = memo(function PortalOrDevice(props: NodeProps<PortalFlowNode>) {
  const { data, selected } = props;
  return data.portal.kind === "android"
    ? <DeviceNode id={data.id} portal={data.portal} links={data.links} selected={!!selected} />
    : <PortalNode {...props} />;
});

const NODE_TYPES = { designBoard: DesignBoardNode, designFrame: DesignFrameNode, agent: AgentNode, note: NoteNode, portal: PortalOrDevice, text: TextNode, image: ImageNode, folder: FolderNode };
const EDGE_TYPES = { link: CordEdge };
