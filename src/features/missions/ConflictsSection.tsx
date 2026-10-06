import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConflictsPanel } from "./ConflictsPanel";
import { concludeMissionMerge, missionConflicts, resolveMissionConflict } from "./conflictsIpc";
import type { IntegrationConflicts } from "./conflictsTypes";

/** Carga los conflictos reales de la integración y aplica la resolución elegida; no inventa nada. */
export function ConflictsSection({ missionId, onDone }: { missionId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState<IntegrationConflicts | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    missionConflicts(missionId).then((c) => { setConflicts(c); setError(""); }).catch((e) => setError(String(e)));
  }, [missionId]);
  useEffect(load, [load]);

  const guard = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (e) { setError(String(e)); }
  };

  if (error) return <p className="text-[11px] text-red-500 dark:text-red-400">{t("missions.conflicts.loadError", { error })}</p>;
  if (!conflicts) return null;
  return (
    <ConflictsPanel
      conflicts={conflicts}
      onResolve={(path, content) => guard(async () => setConflicts(await resolveMissionConflict(missionId, path, content)))}
      onConclude={() => guard(async () => { await concludeMissionMerge(missionId); onDone(); })}
    />
  );
}
