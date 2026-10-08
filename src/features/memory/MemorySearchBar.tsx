import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTranslation } from "react-i18next";

import { MEMORY_KINDS, type MarksFilter, type SearchState, type StatusFilter } from "./memorySearch";

const STATUSES: StatusFilter[] = ["all", "pending", "approved", "rejected"];
const MARKS: MarksFilter[] = ["all", "duplicate", "contradiction", "both"];
const field = "h-7 rounded-md border border-transparent bg-gray-200/70 px-2.5 text-[12px] text-gray-900 placeholder:text-gray-400 focus:border-accent-500 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/25 dark:bg-surface-raised dark:text-gray-100 dark:placeholder:text-white/30";

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
      <div className="relative flex min-w-[8rem] flex-1 items-center">
        <svg aria-hidden="true" viewBox="0 0 16 16"
          className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 fill-none stroke-current stroke-[1.8] text-gray-400 dark:text-white/35">
          <circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" />
        </svg>
        <input type="search" aria-label={t("memorySearch.query")} placeholder={t("memorySearch.queryPlaceholder")} value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })} className={`${field} w-full pl-8`} />
      </div>
      <PopupSelect aria-label={t("memorySearch.kind")} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as SearchState["kind"] })}>
        <option value="all">{t("memorySearch.kindAll")}</option>
        {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`memorySearch.kinds.${k}`)}</option>)}
      </PopupSelect>
      {canMission && (
        <PopupSelect aria-label={t("memorySearch.scope")} value={scope} onChange={(e) => onScope(e.target.value as "workspace" | "mission")}>
          <option value="workspace">{t("memorySearch.scopeWorkspace")}</option>
          <option value="mission">{t("memorySearch.scopeMission")}</option>
        </PopupSelect>
      )}
      <PopupSelect aria-label={t("memorySearch.status")} value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as StatusFilter })}>
        {STATUSES.map((s) => <option key={s} value={s}>{t(`memorySearch.statuses.${s}`)}</option>)}
      </PopupSelect>
      <PopupSelect aria-label={t("memorySearch.marks")} value={value.marks} onChange={(e) => onChange({ ...value, marks: e.target.value as MarksFilter })}>
        {MARKS.map((m) => <option key={m} value={m}>{t(`memorySearch.marksOptions.${m}`)}</option>)}
      </PopupSelect>
      <label className="inline-flex h-7 items-center gap-1.5 rounded-full bg-gray-200/70 px-2.5 text-[12px] text-gray-700 dark:bg-surface-raised dark:text-gray-200">
        <input type="checkbox" className="size-3.5 accent-accent-500" checked={value.expired} onChange={(e) => onChange({ ...value, expired: e.target.checked })} />
        {t("memorySearch.expired")}
      </label>
    </form>
  );
}
