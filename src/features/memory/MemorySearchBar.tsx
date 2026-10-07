import { useTranslation } from "react-i18next";

import { MEMORY_KINDS, type MarksFilter, type SearchState, type StatusFilter } from "./memorySearch";

const STATUSES: StatusFilter[] = ["all", "pending", "approved", "rejected"];
const MARKS: MarksFilter[] = ["all", "duplicate", "contradiction", "both"];
const field = "rounded border border-gray-200 bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-neutral-900";

/** Busca e filtros da memória. Controlado: quem usa guarda o estado e aplica com debounce. */
export function MemorySearchBar({ value, onChange, scope, onScope, canMission }: {
  value: SearchState;
  onChange: (next: SearchState) => void;
  scope: "workspace" | "mission";
  onScope: (scope: "workspace" | "mission") => void;
  canMission: boolean;
}) {
  const { t } = useTranslation();
  return (
    <form role="search" aria-label={t("memorySearch.label")} className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => e.preventDefault()}>
      <input type="search" aria-label={t("memorySearch.query")} placeholder={t("memorySearch.queryPlaceholder")} value={value.query}
        onChange={(e) => onChange({ ...value, query: e.target.value })} className={`${field} min-w-[8rem] flex-1`} />
      <select aria-label={t("memorySearch.kind")} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as SearchState["kind"] })} className={field}>
        <option value="all">{t("memorySearch.kindAll")}</option>
        {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`memorySearch.kinds.${k}`)}</option>)}
      </select>
      {canMission && (
        <select aria-label={t("memorySearch.scope")} value={scope} onChange={(e) => onScope(e.target.value as "workspace" | "mission")} className={field}>
          <option value="workspace">{t("memorySearch.scopeWorkspace")}</option>
          <option value="mission">{t("memorySearch.scopeMission")}</option>
        </select>
      )}
      <select aria-label={t("memorySearch.status")} value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as StatusFilter })} className={field}>
        {STATUSES.map((s) => <option key={s} value={s}>{t(`memorySearch.statuses.${s}`)}</option>)}
      </select>
      <select aria-label={t("memorySearch.marks")} value={value.marks} onChange={(e) => onChange({ ...value, marks: e.target.value as MarksFilter })} className={field}>
        {MARKS.map((m) => <option key={m} value={m}>{t(`memorySearch.marksOptions.${m}`)}</option>)}
      </select>
      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={value.expired} onChange={(e) => onChange({ ...value, expired: e.target.checked })} />
        {t("memorySearch.expired")}
      </label>
    </form>
  );
}
