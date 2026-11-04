import { memo } from "react";
import { useTranslation } from "react-i18next";
import { NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";

import { agentAccent, agentTile, nodeFrame } from "@/features/agents/agentTile";
import { StructuredConversationView } from "@/features/chat/structured/StructuredConversationView";
import { threadCards } from "@/features/chat/structured/model";
import { useStructured } from "@/features/chat/structured/store";
import { useTabsStore } from "@/features/tabs/store";

import { CordPort } from "./cords";
import { HEADER_H } from "./geometry";

export interface ThreadNodeData extends Record<string, unknown> {
  /** `thread:<id>`. */
  ref: string;
  threadId: string;
}
export type ThreadFlowNode = Node<ThreadNodeData, "thread">;

const THREAD_MIN = { w: 360, h: 320 };
const handle = "ade-port z-10! w-3! h-3! border-2! border-white! dark:border-surface! bg-gray-400! dark:bg-gray-200!";

/**
 * O cartão de uma conversa por protocolo no canvas: a mesma conversa do chat (timeline, estado, aprovação e
 * composer), em React puro, SEM xterm nem PTY. Desmontá-lo não mata nada: a conversa vive no backend e o
 * estado nas stores. As cordas saem pelas mesmas quatro alças dos terminais.
 */
export const ThreadNode = memo(function ThreadNode({ data, selected }: NodeProps<ThreadFlowNode>) {
  const { t } = useTranslation();
  const row = useStructured((s) => s.threads.find((x) => x.id === data.threadId));
  const detected = useTabsStore((s) => s.detectedAgents);
  const accent = agentAccent(row?.agentId ?? "");
  const card = row ? threadCards([row], [], (id) => detected.find((a) => a.id === id)?.label ?? id, null)[0] : null;
  return (
    <div className="relative h-full w-full">
      <NodeResizer isVisible minWidth={THREAD_MIN.w} minHeight={THREAD_MIN.h} lineClassName="ade-rz-line" handleClassName="ade-rz-handle" />
      <CordPort id="l" type="source" position={Position.Left} style={{ top: HEADER_H / 2 }} className={handle} />
      <CordPort id="r" type="source" position={Position.Right} style={{ top: HEADER_H / 2 }} className={handle} />
      <CordPort id="t" type="source" position={Position.Top} className={handle} />
      <CordPort id="b" type="source" position={Position.Bottom} className={handle} />
      <div data-thread-node={data.ref} className="h-full w-full flex flex-col rounded-[14px] overflow-hidden bg-white dark:bg-surface"
        style={{ boxShadow: nodeFrame(accent, !!selected, false) }}>
        <div className="ade-node-drag flex items-center gap-2.5 pl-4 pr-3 shrink-0 cursor-grab active:cursor-grabbing select-none border-b border-black/[0.06] dark:border-[rgba(84,84,88,0.55)]"
          style={{ height: HEADER_H }}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] leading-5 font-semibold text-gray-900 dark:text-[#f5f5f7]">{row?.title ?? t("canvas.thread.missing")}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] text-gray-500 dark:text-white/60">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: agentTile(row?.agentId ?? "") }} />
              <span className="shrink-0">{card?.agentLabel ?? ""}</span>
              <span className="rounded-[5px] px-1.5 py-px font-semibold bg-gray-200/70 dark:bg-white/[0.08] text-gray-600 dark:text-white/60">{t("tabs.team.protocol")}</span>
            </span>
          </span>
        </div>
        {/* `nodrag nowheel`: dentro do cartão o mouse é da conversa (rolar, digitar), não do canvas. */}
        <div className="nodrag nowheel flex-1 min-h-0 flex flex-col">
          {row && card ? <StructuredConversationView card={card} thread={row} cards={[card]} /> : null}
        </div>
      </div>
    </div>
  );
});
