import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon } from "neogestify-ui-components";

import type { SessionHistoryEntry } from "@/features/sessions/types";

import {
  EMPTY_FILTERS,
  hasActiveFilters,
  shortenPath,
  type DateRange,
  type SessionFilterState,
} from "./filters";

interface SessionFiltersProps {
  /** Historial completo — de acá salen las opciones de cada desplegable. */
  entries: SessionHistoryEntry[];
  value: SessionFilterState;
  onChange: (next: SessionFilterState) => void;
  /** Cuántas entradas quedan tras filtrar, para el contador. */
  resultCount: number;
}

/**
 * La franja de filtros, debajo del buscador.
 *
 * El texto no está acá: se escribe en el buscador grande del encabezado, que es por donde
 * se entra a esta pantalla. Acá quedan los cortes que no se pueden tipear — agente,
 * carpeta, fecha, skill — en una sola fila que no le roba alto a la lista.
 */
export function SessionFilters({ entries, value, onChange, resultCount }: SessionFiltersProps) {
  const { t } = useTranslation();
  const patch = (p: Partial<SessionFilterState>) => onChange({ ...value, ...p });

  // Las opciones salen de lo que HAY en el historial: no tiene sentido ofrecer filtrar
  // por un agente o una carpeta sin ninguna sesión.
  const agents = Array.from(
    new Map(entries.map((e) => [e.agentId, e.agentLabel])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const cwds = Array.from(new Set(entries.map((e) => e.cwd))).sort();
  const skills = Array.from(
    new Set(entries.flatMap((e) => e.skills.map((s) => s.name)))
  ).sort();

  const active = hasActiveFilters(value);

  return (
    <div className="flex items-center gap-1.5 shrink-0 px-3 py-1.5
      border-b border-gray-200 dark:border-white/8
      bg-gray-100/40 dark:bg-white/2">

      <PopupSelect
        value={value.agentId}
        onChange={(e) => patch({ agentId: e.target.value })}
        className="min-w-0">
        <option value="">{t("sessions.filters.allAgents")}</option>
        {agents.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </PopupSelect>

      {cwds.length > 1 && (
        <PopupSelect
          value={value.cwd}
          onChange={(e) => patch({ cwd: e.target.value })}
          className="min-w-0">
          <option value="">{t("sessions.filters.allFolders")}</option>
          {cwds.map((c) => <option key={c} value={c}>{shortenPath(c)}</option>)}
        </PopupSelect>
      )}

      <PopupSelect
        value={value.dateRange}
        onChange={(e) => patch({ dateRange: e.target.value as DateRange })}
        className="min-w-0">
        <option value="all">{t("sessions.filters.anyDate")}</option>
        <option value="today">{t("sessions.filters.today")}</option>
        <option value="week">{t("sessions.filters.week")}</option>
        <option value="month">{t("sessions.filters.month")}</option>
      </PopupSelect>

      {skills.length > 0 && (
        <PopupSelect
          value={value.skill}
          onChange={(e) => patch({ skill: e.target.value })}
          className="min-w-0">
          <option value="">{t("sessions.filters.anySkill")}</option>
          {skills.map((s) => <option key={s} value={s}>{s}</option>)}
        </PopupSelect>
      )}

      <div className="flex-1" />

      {active && (
        <>
          <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
            {t("sessions.filters.results", { count: resultCount })}
          </span>
          <Button variant="custom"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="cc-t flex items-center gap-1 shrink-0 px-1.5 h-5.5 rounded-md
              text-[10.5px] text-gray-500 dark:text-white/45
              hover:text-gray-800 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <CloseIcon className="w-3 h-3" />
            {t("sessions.filters.clear")}
          </Button>
        </>
      )}
    </div>
  );
}
