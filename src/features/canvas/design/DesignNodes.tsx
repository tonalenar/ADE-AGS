import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { type Node, type NodeProps } from "@xyflow/react";

import { BoardCard } from "./BoardCard";
import type { Artboard } from "./designApi";

export interface DesignActions {
  onEdit: (board: Artboard) => void;
  onApprove: (board: Artboard) => void;
  onReject: (board: Artboard) => void;
  onChoose: (board: Artboard, pick: { selector: string; text: string }) => void;
  editing: string | null;
}
const NOOP = () => {};
export const DesignActionsContext = createContext<DesignActions>({ onEdit: NOOP, onApprove: NOOP, onReject: NOOP, onChoose: NOOP, editing: null });

export const BOARD_NODE_PREFIX = "design-board:";
export const FRAME_NODE_PREFIX = "design-frame:";
export const isDesignNodeId = (id: string) => id.startsWith(BOARD_NODE_PREFIX) || id.startsWith(FRAME_NODE_PREFIX);

export interface DesignBoardData extends Record<string, unknown> { board: Artboard; comments: number; groupKey: string }
export interface DesignFrameData extends Record<string, unknown> { title: string; w: number; h: number }
export type DesignBoardFlowNode = Node<DesignBoardData, "designBoard">;
export type DesignFrameFlowNode = Node<DesignFrameData, "designFrame">;

/** Quanto o iframe espera fora da tela antes de ser desmontado (evita piscar ao dar pan). */
const FREEZE_AFTER_MS = 1500;

/**
 * O iframe só existe enquanto a prancheta está (quase) na tela, e entra na fila de ociosidade: vários
 * iframes montando juntos travariam o canvas. Fora da tela é desmontado (congelado) depois de um tempo.
 */
export function useFrameLive(): { ref: React.RefObject<HTMLDivElement | null>; live: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => setLive(false), FREEZE_AFTER_MS);
      return () => clearTimeout(timer);
    }
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void });
    if (idle.requestIdleCallback && idle.cancelIdleCallback) {
      const h = idle.requestIdleCallback(() => setLive(true), { timeout: 800 });
      return () => idle.cancelIdleCallback!(h);
    }
    const timer = setTimeout(() => setLive(true), 50);
    return () => clearTimeout(timer);
  }, [visible]);
  return { ref, live };
}

export const DesignBoardNode = memo(function DesignBoardNode({ data }: NodeProps<DesignBoardFlowNode>) {
  const actions = useContext(DesignActionsContext);
  const { ref, live } = useFrameLive();
  const { board, comments } = data;
  return (
    <div ref={ref} className="rounded-md" style={{ width: board.width }}>
      <BoardCard board={board} comments={comments} live={live} dragHandle active={actions.editing === board.id}
        onEdit={() => actions.onEdit(board)} onApprove={() => actions.onApprove(board)} onReject={() => actions.onReject(board)}
        onChoose={(pick) => actions.onChoose(board, pick)} />
    </div>
  );
});

/** A moldura "Design - <título>/<página>" que agrupa as pranchetas de uma página. Não recebe o mouse. */
export const DesignFrameNode = memo(function DesignFrameNode({ data }: NodeProps<DesignFrameFlowNode>) {
  return (
    <div className="pointer-events-none rounded-xl border-2 border-dashed border-accent-500/40 bg-accent-500/[0.04]" style={{ width: data.w, height: data.h }}>
      <div className="px-4 pt-2 text-[13px] font-semibold text-accent-700 dark:text-accent-300 truncate">{data.title}</div>
    </div>
  );
});
