import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasRoles, type AgentRoleChoice } from "./agentRole";

/**
 * O que este terminal vai ser: "Sem especificação" (o orquestrador decide quando a corda o liga a ele)
 * ou uma função — QA, Backend, Frontend…, as do catálogo e as criadas com `ags role create`.
 * "Subagente" marca o terminal como apoio do orquestrador. Serve ao assistente de novo agente e
 * à edição do papel no canvas.
 */
export function RolePicker({ value, onChange }: { value: AgentRoleChoice; onChange: (next: AgentRoleChoice) => void }) {
  const { t } = useTranslation();
  const roles = useCanvasRoles();
  const switchId = useId();
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
      <div className="flex items-center justify-between gap-3 rounded-[10px] bg-white px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-black/20 dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55)]">
        <span className="min-w-0">
          <span id={switchId} className="block text-[13px] leading-[17px] text-gray-900 dark:text-[#f5f5f7]">{t("role.subagent")}</span>
          <span className="block text-[11px] leading-[14px] text-gray-500 dark:text-white/60">{t("role.subagentHint")}</span>
        </span>
        <button type="button" role="switch" aria-checked={value.subagent} aria-labelledby={switchId}
          onClick={() => onChange({ ...value, subagent: !value.subagent })}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${value.subagent ? "bg-[#34c759] dark:bg-[#30d158]" : "bg-gray-300 dark:bg-surface-overlay"}`}>
          <span aria-hidden="true" className={`absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.35)] transition-transform motion-reduce:transition-none ${value.subagent ? "translate-x-4" : ""}`} />
        </button>
      </div>
    </div>
  );
}
