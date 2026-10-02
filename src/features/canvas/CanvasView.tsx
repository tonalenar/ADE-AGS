import "@xyflow/react/dist/style.css";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, MiniMap, NodeResizer,
  Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps, type Connection,
} from "@xyflow/react";
import { Button, CloseIcon, useTheme } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { screenOf } from "@/features/terminal/terminalRegistry";

import { emptyBoard, neighbors } from "./board";
import {
  HEADER_H, MAX_ZOOM, MIN_ZOOM, NODE_MIN, focusViewport, intersects, isLive, terminalRect,
  type Box, type Rect, type Viewport,
} from "./geometry";
import { boardKey, canvasActions, useActiveBoardKey, useCanvasStore } from "./store";

interface AgentNodeData extends Record<string, unknown> {
  tab: Tab;
  box: Box;
  live: boolean;
  links: number;
  onFocus: (tabId: string) => void;
}

type AgentFlowNode = Node<AgentNodeData, "agent">;

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

function CanvasInner() {
  const { theme } = useTheme();
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

  const focusNode = (tabId: string) => {
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

  const nodes: AgentFlowNode[] = useMemo(() => tabs.flatMap((tab) => {
    const box = board.nodes[tab.id];
    if (!box) return [];
    return [{
      id: tab.id,
      type: "agent" as const,
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      selected: tab.id === activeTabId,
      dragHandle: ".ade-node-drag",
      deletable: false,
      data: { tab, box, live, links: neighbors(board, tab.id).length, onFocus: focusNode },
    }];
    // `focusNode` cambia con cada render y no aporta nada nuevo al nodo.
  }), [tabs, board, activeTabId, live]);

  const edges: Edge[] = useMemo(() => board.edges.map((e) => {
    const a = board.nodes[e.a];
    const b = board.nodes[e.b];
    // Sale por el lado que mira al otro nodo: la curva no cruza su propio nodo.
    const aLeft = a && b ? a.x + a.w / 2 <= b.x + b.w / 2 : true;
    return {
      id: e.id,
      source: e.a,
      target: e.b,
      sourceHandle: aLeft ? "r" : "l",
      targetHandle: aLeft ? "l" : "r",
      type: "link",
    };
  }), [board.edges, board.nodes]);

  const onNodesChange = (changes: NodeChange<AgentFlowNode>[]) => {
    if (!key) return;
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        canvasActions.moveNode(key, c.id, { x: Math.round(c.position.x), y: Math.round(c.position.y) });
      } else if (c.type === "dimensions" && c.resizing && c.dimensions) {
        canvasActions.moveNode(key, c.id, { w: Math.round(c.dimensions.width), h: Math.round(c.dimensions.height) });
      } else if (c.type === "select" && c.selected) {
        activateTab(c.id);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!key) return;
    for (const c of changes) if (c.type === "remove") canvasActions.disconnect(key, c.id);
  };

  const onConnect = (c: Connection) => {
    if (key && c.source && c.target) canvasActions.connect(key, c.source, c.target);
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 bg-gray-50 dark:bg-surface-deep">
      <ReactFlow<AgentFlowNode, Edge>
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
        deleteKeyCode={["Delete", "Backspace"]}
        connectionLineStyle={{ stroke: "var(--color-accent-400)", strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      </ReactFlow>
      <CanvasControls zoom={vp.zoom} onFit={() => rf.fitView({ padding: 0.12, maxZoom: 1, duration: 220 })}
        onReset={() => {
          const target = activeTabId && board.nodes[activeTabId] ? activeTabId : tabs[0]?.id;
          if (target) focusNode(target);
        }} />
    </div>
  );
}

/** Los botones de zoom y el minimapa. Van en su propia capa, por encima de las
 *  terminales: abajo, una terminal viva los taparía. */
function CanvasControls({ zoom, onFit, onReset }: { zoom: number; onFit: () => void; onReset: () => void }) {
  const { t } = useTranslation();
  const rf = useReactFlow();
  const button = `cc-t h-7 px-2 text-[11px] font-medium rounded-md
    text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/8`;
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
      <div className="pointer-events-auto absolute right-3 bottom-3 flex items-center gap-0.5 p-1 rounded-lg
        border border-gray-200 dark:border-white/10 bg-white/95 dark:bg-surface-raised/95 shadow-sm">
        <Button variant="custom" className={button} onClick={() => rf.zoomOut({ duration: 160 })} aria-label={t("canvas.zoomOut")}>−</Button>
        <span className="w-11 text-center text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="custom" className={button} onClick={() => rf.zoomIn({ duration: 160 })} aria-label={t("canvas.zoomIn")}>+</Button>
        <span className="w-px h-4 mx-1 bg-gray-200 dark:bg-white/10" />
        <Button variant="custom" className={button} onClick={onReset} title={t("canvas.liveHint")}>{t("canvas.actual")}</Button>
        <Button variant="custom" className={button} onClick={onFit}>{t("canvas.fit")}</Button>
      </div>
      <div className="pointer-events-auto">
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          className="rounded-lg! overflow-hidden border border-gray-200 dark:border-white/10"
          nodeColor="var(--color-gray-400)"
          maskColor="rgba(0,0,0,0.25)"
          style={{ width: 160, height: 110 }}
        />
      </div>
    </div>
  );
}

// ── Nodo ────────────────────────────────────────────────────────────

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useTranslation();
  const { tab, box, live, links, onFocus } = data;
  const Icon = agentIcon(tab.agentId, tab.agentId);
  const handle = "w-2.5! h-2.5! border-2! border-white! dark:border-surface-deep! bg-gray-400! dark:bg-gray-500!";

  return (
    <div
      className={`group h-full w-full flex flex-col rounded-lg overflow-hidden
        border bg-white dark:bg-surface
        ${selected
          ? "border-accent-500 dark:border-accent-400 shadow-[0_0_0_1px_var(--color-accent-400)]"
          : "border-gray-300 dark:border-white/12"}`}
    >
      <NodeResizer isVisible={selected} minWidth={NODE_MIN.w} minHeight={NODE_MIN.h}
        lineClassName="border-transparent!" handleClassName="w-2.5! h-2.5! rounded-sm! bg-accent-400! border-0!" />

      {/* Los puntos de conexión van a la altura de la cabecera: más abajo quedarían
          debajo de la terminal viva, que se dibuja encima del nodo. */}
      <Handle id="l" type="source" position={Position.Left} style={{ top: HEADER_H / 2 }} className={handle} />
      <Handle id="r" type="source" position={Position.Right} style={{ top: HEADER_H / 2 }} className={handle} />

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
        <span className="flex-1" />
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

const NODE_TYPES = { agent: AgentNode };
const EDGE_TYPES = { link: LinkEdge };
