import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { placeOf } from "./teamModel";
import { TeamNodeBadge } from "./TeamNodeBadge";
import { startTeams, useTeamStore } from "./teamStore";
import { useRoleLabel } from "./TeamParts";

const PILL = "shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px] font-semibold bg-gray-200/70 dark:bg-white/[0.08] text-gray-600 dark:text-white/60";

/**
 * O que o time diz de um terminal nas Abas e na Grade: a marca de orquestrador ou o papel, a etiqueta
 * "subagente" e o estado com a política (`TeamNodeBadge`). Mesma fonte do chat e do canvas, sem outro
 * canal. Fora de um time não desenha nada. `compact` (a aba) mostra só a etiqueta curta.
 */
export function TeamTabMarks({ tabId, compact = false }: { tabId: string; compact?: boolean }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  useEffect(() => startTeams(), []);
  const teams = useTeamStore((s) => s.teams);
  const place = useMemo(() => placeOf(teams, tabId), [teams, tabId]);
  if (!place) return null;
  const member = place.member;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[10.5px]">
      <span className={PILL} title={t("chat.team.node.title")}>{member ? roleLabel(member.role) : t("canvas.orchestrator")}</span>
      {member?.subagent && <span className={PILL}>{t("role.subagentTag")}</span>}
      {!compact && <TeamNodeBadge tabId={tabId} />}
    </span>
  );
}
