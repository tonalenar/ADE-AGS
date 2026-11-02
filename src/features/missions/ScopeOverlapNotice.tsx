import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { chatTeamOverlaps } from "@/features/chat/team/ipc";
import { missionScopeOverlaps } from "./conflictsIpc";
import type { ScopeOverlap } from "./conflictsTypes";

const EMPTY: ScopeOverlap[] = [];

/** Recarrega a cada mensagem entre agentes (uma delegação nova muda o que está em andamento). */
function useOverlaps(load: (() => Promise<ScopeOverlap[]>) | null, key: string): ScopeOverlap[] {
  const [found, setFound] = useState<ScopeOverlap[]>(EMPTY);
  useEffect(() => {
    if (!load) { setFound(EMPTY); return; }
    let alive = true;
    const refresh = () => { load().then((list) => { if (alive) setFound(Array.isArray(list) ? list : EMPTY); }).catch(() => { if (alive) setFound(EMPTY); }); };
    refresh();
    const off = listen("cc-peer-message", refresh);
    return () => { alive = false; off.then((fn) => fn()).catch(() => {}); };
    // `key` identifica a fonte; `load` muda a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return found;
}

/**
 * "Escopos sobrepostos": duas tarefas em andamento declararam o mesmo lugar (`Escopo:` na delegação ou
 * `write_scopes` no plano). Só aviso, antecipa o conflito que só apareceria no merge. `compact` = QG.
 */
export function ScopeOverlapBanner({ overlaps, compact = false }: { overlaps: readonly ScopeOverlap[]; compact?: boolean }) {
  const { t } = useTranslation();
  if (overlaps.length === 0) return null;
  const shell = compact
    ? "ags-hq__detail"
    : "rounded-xl bg-amber-50 dark:bg-amber-400/10 p-3 ring-1 ring-inset ring-amber-500/30 dark:ring-amber-400/25";
  return (
    <section className={shell} role="status" aria-label={t("missions.scopes.title")}>
      <h3 className={compact ? "mb-1 text-[11px] font-semibold text-amber-300" : "mb-1 text-[12px] font-semibold text-amber-800 dark:text-amber-200"}>
        {t("missions.scopes.title")}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {overlaps.map((o) => (
          <li key={`${o.a}|${o.b}`} className={compact ? "text-[10.5px] text-gray-200" : "text-[11.5px] text-gray-700 dark:text-gray-200"} title={`${o.aTask} · ${o.bTask}`}>
            {t("missions.scopes.pair", { a: o.a, b: o.b, paths: o.paths.join(", ") })}
          </li>
        ))}
      </ul>
      <p className={compact ? "mt-1 text-[10px] text-gray-400" : "mt-1 text-[11px] text-gray-500 dark:text-white/50"}>{t("missions.scopes.hint")}</p>
    </section>
  );
}

export function MissionScopeOverlaps({ missionId, compact = false }: { missionId: string | null; compact?: boolean }) {
  const overlaps = useOverlaps(missionId ? () => missionScopeOverlaps(missionId) : null, `m:${missionId ?? ""}`);
  return <ScopeOverlapBanner overlaps={overlaps} compact={compact} />;
}

export function ChatTeamScopeOverlaps({ teamId }: { teamId: string | null }) {
  const overlaps = useOverlaps(teamId ? () => chatTeamOverlaps(teamId) : null, `t:${teamId ?? ""}`);
  return <ScopeOverlapBanner overlaps={overlaps} />;
}
