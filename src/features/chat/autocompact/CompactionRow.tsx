import { useTranslation } from "react-i18next";

import type { TimelineItem } from "@/features/chat/timeline/types";

import { compactTokens, compactionOf } from "./model";

/**
 * O aviso da compactação de contexto no fio: «Compactando contexto…» enquanto roda e «Contexto compactado 182k → 42k
 * tokens» quando termina (só o «antes» se o agente não informou o «depois»). O gatilho diz quem pediu: o agente, a
 * pessoa ou o autocompact da ADE. Uma linha, com o excesso truncado.
 */
export function CompactionRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  const compaction = compactionOf(item);
  if (!compaction) return null;
  const { state, trigger, before, after, error } = compaction;
  const label = state === "running" ? t("chat.compaction.running")
    : state === "error" ? t("chat.compaction.failed")
      : before !== null && after !== null ? t("chat.compaction.doneTokens", { before: compactTokens(before), after: compactTokens(after) })
        : before !== null ? t("chat.compaction.doneBefore", { before: compactTokens(before) })
          : t("chat.compaction.done");
  const by = t(`chat.compaction.trigger.${trigger}`);
  const text = `${label} · ${by}${state === "error" && error ? ` · ${error}` : ""}`;
  return (
    <div role="status" aria-label={text} data-compaction={state}
      className={`flex w-full items-center gap-3 px-1 py-1 text-chat-note ${state === "error" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-white/50"}`}>
      <span aria-hidden="true" className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
      <span className="flex min-w-0 items-center gap-1.5">
        {state === "running" && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-500 motion-reduce:animate-none" />}
        <span className="min-w-0 truncate">{text}</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
    </div>
  );
}
