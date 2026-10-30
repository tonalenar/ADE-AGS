import { useTranslation } from "react-i18next";

import { useCanvasRoles, type AgentRoleChoice } from "./agentRole";
import { SubagentSwitch } from "./SubagentSwitch";

/**
 * O que este terminal vai ser: "Sem especificação" (o orquestrador decide quando a corda o liga a ele)
 * ou uma função — QA, Backend, Frontend…, as do catálogo e as criadas com `ags role create`.
 * "Subagente" marca o terminal como apoio do orquestrador. Serve ao assistente de novo agente e
 * à edição do papel no canvas.
 */
export function RolePicker({ value, onChange }: { value: AgentRoleChoice; onChange: (next: AgentRoleChoice) => void }) {
  const { t } = useTranslation();
  const roles = useCanvasRoles();
  const chip = (selected: boolean) =>
    `min-w-0 truncate rounded-lg px-3 h-8 text-left text-[12.5px] transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
      selected
        ? "bg-accent-500/15 text-accent-700 dark:text-accent-300 shadow-[inset_0_0_0_1px_rgba(10,132,255,0.55)]"
        : "bg-black/[0.04] dark:bg-white/[0.06] text-gray-700 dark:text-gray-300 hover:bg-black/[0.07] dark:hover:bg-white/[0.1]"}`;
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label={t("role.title")} className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        <button type="button" role="radio" aria-checked={value.roleId === null} className={`${chip(value.roleId === null)} col-span-2 sm:col-span-3`}
          title={t("role.noneHint")} onClick={() => onChange({ ...value, roleId: null })}>
          {t("role.none")}
          <span className="ml-2 text-[11px] opacity-70">{t("role.noneHint")}</span>
        </button>
        {roles.map((role) => (
          <button key={role.id} type="button" role="radio" aria-checked={value.roleId === role.id} className={chip(value.roleId === role.id)}
            title={role.instructions} onClick={() => onChange({ ...value, roleId: role.id })}>
            {role.label}
          </button>
        ))}
      </div>
      <SubagentSwitch value={value.subagent} onChange={(subagent) => onChange({ ...value, subagent })} />
    </div>
  );
}
