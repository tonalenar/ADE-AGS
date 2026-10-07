import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { numberedPoints, splitObjective } from "./objectiveFormat";

/** Acima disto o objetivo vem recolhido (o texto inteiro fica a um clique). */
const COLLAPSE_OVER = 420;

/**
 * O objetivo de uma missão. Os longos (briefings de várias páginas escritos como um parágrafo só) viravam
 * uma parede de texto: aqui vêm recolhidos, com a introdução e a lista numerada dos pontos, e o texto
 * completo reparte-se em partes com título. Os curtos continuam como um parágrafo.
 */
export function MissionObjective({ objective }: { objective: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const parts = useMemo(() => splitObjective(objective), [objective]);
  const points = useMemo(() => numberedPoints(parts), [parts]);
  const structured = parts.sections.length > 0;
  const long = objective.length > COLLAPSE_OVER;
  const text = "text-[12px] leading-relaxed text-gray-700 dark:text-gray-300";

  if (!long && !structured) return <p className={`whitespace-pre-wrap ${text}`}>{objective}</p>;

  const intro = parts.intro.length > 360 && !open ? parts.intro.slice(0, 357).trimEnd() + "…" : parts.intro;
  return (
    <div className="flex flex-col gap-2.5" data-testid="mission-objective">
      {intro && <p className={`whitespace-pre-wrap ${text}`}>{intro}</p>}
      {!open && points.length > 0 && (
        <ol className="flex flex-col gap-1" aria-label={t("missions.objective.points")}>
          {points.map((point) => (
            <li key={point.n} className="flex items-baseline gap-2 text-[12px] text-gray-700 dark:text-gray-300">
              <span className="w-5 shrink-0 text-right tabular-nums text-[11px] font-semibold text-accent-600 dark:text-accent-300">{point.n}</span>
              <span>{point.label}</span>
            </li>
          ))}
        </ol>
      )}
      {open && (
        <div className="flex flex-col gap-3">
          {parts.sections.map((section, i) => (
            <div key={i} className="flex flex-col gap-1 border-l-2 border-gray-200 pl-3 dark:border-white/10">
              <h4 className="text-[11px] font-semibold text-gray-800 dark:text-gray-100">
                {section.n !== null && <span className="mr-1.5 tabular-nums text-accent-600 dark:text-accent-300">{section.n}.</span>}
                {section.label}
              </h4>
              <p className={`whitespace-pre-wrap ${text}`}>{section.body}</p>
            </div>
          ))}
          {!structured && <p className={`whitespace-pre-wrap ${text}`}>{objective}</p>}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className="self-start text-[11.5px] font-medium text-accent-600 hover:underline dark:text-accent-300">
          {open ? t("missions.objective.collapse") : t("missions.objective.expand")}
        </button>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(objective)}
          className="self-start text-[11.5px] text-gray-500 hover:underline dark:text-gray-400">
          {t("missions.objective.copy")}
        </button>
      </div>
    </div>
  );
}
