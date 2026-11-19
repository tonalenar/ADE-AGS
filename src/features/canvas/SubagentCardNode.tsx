import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { EphemeralSubagentCard, EphemeralSubagentKind, EphemeralSubagentStatus } from "./subagentsModel";

export interface SubagentCardNodeData extends Record<string, unknown> {
  card: EphemeralSubagentCard;
  onClick: (card: EphemeralSubagentCard) => void;
}

export type SubagentCardFlowNode = Node<SubagentCardNodeData, "subagentCard">;

const KIND_KEY: Record<EphemeralSubagentKind, string> = {
  internal: "canvas.subagent.running",
  delegated: "canvas.subagent.delegated",
  child: "canvas.subagent.child",
};

const STATUS_DOT: Record<EphemeralSubagentStatus, string> = {
  working: "bg-emerald-500 motion-safe:animate-pulse",
  waiting: "bg-amber-500",
  idle: "bg-gray-400 dark:bg-white/35",
};

/**
 * Cartão compacto e efêmero pendurado no nó pai por uma corda pontilhada: representa um subagente
 * interno em execução, uma tarefa delegada do harness ou uma conversa filha ativa. Some sozinho
 * assim que o trabalho termina.
 */
export const SubagentCardNode = memo(function SubagentCardNode({ data }: NodeProps<SubagentCardFlowNode>) {
  const { t } = useTranslation();
  const { card, onClick } = data;
  const kindLabel = t(KIND_KEY[card.kind]);
  const statusLabel = t(`canvas.subagent.status.${card.status}`);
  const title = card.title || kindLabel;

  return (
    <div className="relative h-full w-full">
      <Handle
        id="t"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="w-2! h-2! border-2! border-white! dark:border-surface! bg-accent-500!"
      />
      <button
        type="button"
        data-subagent-card={card.id}
        data-subagent-kind={card.kind}
        onClick={(e) => {
          e.stopPropagation();
          onClick(card);
        }}
        title={card.openRef ? `${title} — ${t("canvas.subagent.open")}` : title}
        className="nodrag cc-t group flex h-full w-full flex-col justify-between rounded-xl border border-black/10
          bg-white/95 px-3 py-2 text-left shadow-sm transition-colors hover:border-accent-500/50
          dark:border-white/10 dark:bg-surface/95 dark:hover:border-accent-400/50"
      >
        <div className="flex w-full items-center gap-1.5 text-[10.5px] font-medium text-gray-500 dark:text-white/60">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[card.status]}`} />
          <span className="min-w-0 flex-1 truncate uppercase tracking-[0.04em]">{kindLabel}</span>
          <span className="shrink-0 rounded-full bg-black/[0.05] px-1.5 py-px text-[9.5px] font-semibold text-gray-600 dark:bg-white/[0.08] dark:text-white/70">
            {statusLabel}
          </span>
        </div>
        <div className="flex w-full items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-4 text-gray-900 dark:text-white">
            {title}
          </span>
          {card.subtitle && (
            <span className="shrink-0 max-w-20 truncate font-mono text-[10px] text-gray-400 dark:text-white/40">
              {card.subtitle}
            </span>
          )}
        </div>
      </button>
    </div>
  );
});
