import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { teamRequester } from "./teamPermissions";
import { useTeamStore } from "./teamStore";

/**
 * O papel no time de quem pede (o cartão do pedido e a caixa de Permissões): "Revisor · só leitura",
 * ou "Orquestrador". Nada fora de time.
 */
export function TeamRoleTag({ conversation, className = "" }: { conversation: string | null; className?: string }) {
  const { t } = useTranslation();
  const teams = useTeamStore((s) => s.teams);
  const who = useMemo(() => teamRequester(teams, conversation), [teams, conversation]);
  if (!who) return null;
  const role = t(`chat.team.roles.${who.role}`, { defaultValue: who.role });
  const text = who.policy ? `${role} · ${t(`chat.team.policy.${who.policy}`)}` : role;
  return (
    <span title={t("chat.team.permission.tag")}
      className={`shrink-0 text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60 ${className}`}>
      {text}
    </span>
  );
}
