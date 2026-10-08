import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { numberedPoints, splitObjective } from "./objectiveFormat";

/** Acima disto o objetivo vem recolhido (o texto inteiro fica a um clique). */
const COLLAPSE_OVER = 420;

const CARD = "flex flex-col rounded-xl bg-white dark:bg-surface px-5 py-[18px] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.05)]";
const TEXT = "text-[13.5px] leading-[19px]";

/**
 * O objetivo de uma missão, num cartão (prancheta 2): o título dentro, a introdução e a lista
 * numerada dos pontos. Os longos (briefings de várias páginas escritos como um parágrafo só)
 * vêm recolhidos e o texto completo reparte-se em partes com título. Os curtos são um parágrafo.
 */
export function MissionObjective({ objective, title }: { objective: string; title?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const parts = useMemo(() => splitObjective(objective), [objective]);
  const points = useMemo(() => numberedPoints(parts), [parts]);
  const structured = parts.sections.length > 0;
  const long = objective.length > COLLAPSE_OVER;
  const heading = title && <h3 className="text-[15px] leading-5 font-semibold text-gray-900 dark:text-[#f5f5f7]">{title}</h3>;

  if (!long && !structured) {
    return (
      <div className={CARD}>
        {heading}
        <p className={`whitespace-pre-wrap text-gray-600 dark:text-white/60 ${title ? "mt-1.5" : ""} ${TEXT}`}>{objective}</p>
      </div>
    );
  }

  const intro = parts.intro.length > 360 && !open ? parts.intro.slice(0, 357).trimEnd() + "…" : parts.intro;
  return (
    <div className={CARD} data-testid="mission-objective">
      {heading}
      {intro && <p className={`mt-1.5 ${points.length > 0 && !open ? "mb-3.5" : "mb-1"} whitespace-pre-wrap text-gray-600 dark:text-white/60 ${TEXT}`}>{intro}</p>}
      {!open && points.length > 0 && (
        <ol className="flex flex-col" aria-label={t("missions.objective.points")}>
          {points.map((point) => (
            <li key={point.n} className={`flex gap-3 py-[7px] text-gray-900 dark:text-[#f5f5f7] border-b last:border-b-0 border-black/[0.06] dark:border-[rgba(84,84,88,0.35)] ${TEXT}`}>
              <span className="w-[18px] shrink-0 text-right text-[13px] font-semibold tabular-nums text-accent-600 dark:text-accent-400">{point.n}</span>
              <span>{point.label}</span>
            </li>
          ))}
        </ol>
      )}
      {open && (
        <div className="flex flex-col gap-3">
          {parts.sections.map((section, i) => (
            <div key={i} className="flex flex-col gap-1 border-l-2 border-accent-500/30 pl-3">
              <h4 className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
                {section.n !== null && <span className="mr-1.5 tabular-nums text-accent-600 dark:text-accent-400">{section.n}.</span>}
                {section.label}
              </h4>
              <p className={`whitespace-pre-wrap text-gray-600 dark:text-white/60 ${TEXT}`}>{section.body}</p>
            </div>
          ))}
          {!structured && <p className={`whitespace-pre-wrap text-gray-600 dark:text-white/60 ${TEXT}`}>{objective}</p>}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-1">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(objective)}
          className="h-7 rounded-md px-2 text-[13px] text-gray-500 hover:bg-black/[0.04] dark:text-white/50 dark:hover:bg-white/[0.06]">
          {t("missions.objective.copy")}
        </button>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-accent-600 hover:bg-accent-500/10 dark:text-accent-400">
          {open ? t("missions.objective.collapse") : t("missions.objective.expand")}
          <svg viewBox="0 0 18 18" aria-hidden className={`h-3.5 w-3.5 transition-transform ${open ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M7 4.5 11 9l-4 4.5" /></svg>
        </button>
      </div>
    </div>
  );
}
