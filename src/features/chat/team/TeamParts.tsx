import { useTranslation } from "react-i18next";

import { agentAccent } from "@/features/agents/agentTile";

import { agentMono, stateTone, type MemberState } from "./teamModel";

/**
 * Peças pequenas do time, as mesmas no painel, no fio e na sidebar: o quadradinho do agente (a letra
 * na cor dele, como na prancheta) e o estado com a bolinha.
 */

/** O quadradinho com a letra do agente. A cor é a do agente (`agentAccent`), nunca um hex aqui. */
export function AgentMono({ agentId, label, size = 22 }: { agentId: string; label: string; size?: 14 | 16 | 20 | 22 }) {
  const text = size <= 14 ? "text-[8px] rounded" : size <= 16 ? "text-[9px] rounded" : size <= 20 ? "text-[10px] rounded-[5px]" : "text-[11px] rounded-md";
  return (
    <span aria-hidden="true" style={{ width: size, height: size, background: agentAccent(agentId) }}
      className={`shrink-0 inline-flex items-center justify-center font-bold text-white ${text}`}>
      {agentMono(agentId, label)}
    </span>
  );
}

/** "● trabalhando", na cor do estado. */
export function StateDot({ state, className = "" }: { state: MemberState; className?: string }) {
  const { t } = useTranslation();
  return <span className={`${stateTone(state)} ${className}`}>● {t(`chat.team.state.${state}`)}</span>;
}

/** O nome do papel, pelos catálogos (o id fica como está se não houver tradução). */
export function useRoleLabel(): (role: string) => string {
  const { t } = useTranslation();
  return (role: string) => t(`chat.team.roles.${role}`, { defaultValue: role });
}
