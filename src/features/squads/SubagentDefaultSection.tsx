import { useTranslation } from "react-i18next";

import { ModelSelector } from "@/features/runs/ModelSelector";
import type { Roster } from "@/features/runs/types";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { FastSwitch } from "./FastSwitch";
import { modelsForAccount } from "./modelSelection";
import type { SubagentDefault } from "./types";

/**
 * O LLM que os subagentes recrutados usam por padrão. "Automático" (valor `null`) deixa a
 * orquestradora escolher e justificar; um agente concreto traz as mesmas opções de modelo
 * (catálogo da conta principal), esforço e, só no Codex, o modo Fast.
 */
export function SubagentDefaultSection({ roster, onRoster, value, onChange }: {
  roster: Roster | null;
  onRoster: (roster: Roster) => void;
  value: SubagentDefault | null | undefined;
  onChange: (next: SubagentDefault | null) => void;
}) {
  const { t } = useTranslation();
  const agentId = value?.agentId ?? "";
  const agent = roster?.agents.find((entry) => entry.agentId === agentId);
  const catalog = modelsForAccount(agent, null, true);
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-white/10 p-3">
      <h3 className="text-[12px] font-semibold text-gray-800 dark:text-gray-200">{t("squads.subagent.title")}</h3>
      <p className="text-[10.5px] text-gray-400 dark:text-white/35">{t("squads.subagent.hint")}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[10.5px] font-semibold text-gray-600 dark:text-gray-300">{t("squads.form.provider")}</span>
          <PopupSelect aria-label={t("squads.subagent.provider")} value={agentId}
            onChange={(event) => onChange(event.target.value ? { agentId: event.target.value, model: null, reasoningEffort: null, fastMode: false } : null)}>
            <option value="">{t("squads.subagent.auto")}</option>
            {agentId && !agent && <option value={agentId}>{agentId} · {t("squads.unavailable")}</option>}
            {roster?.agents.filter((entry) => entry.launchable).map((entry) => (
              <option key={entry.agentId} value={entry.agentId}>{entry.label}</option>
            ))}
          </PopupSelect>
        </label>
        {value && (
          <>
            <ModelSelector roster={roster} agentId={value.agentId} accountId={null} autoAccount allowComplexity={false}
              model={value.model} complexity={null} reasoningEffort={value.reasoningEffort ?? null} onRoster={onRoster}
              onChange={(patch) => onChange({ ...value, model: patch.model, reasoningEffort: patch.reasoningEffort ?? null })} />
            {value.agentId === "codex" && (
              <FastSwitch checked={value.fastMode === true} model={value.model} catalog={catalog}
                onChange={(fastMode) => onChange({ ...value, fastMode })} />
            )}
          </>
        )}
      </div>
      {!value && <p className="text-[10px] text-gray-400 dark:text-white/35">{t("squads.subagent.autoHint")}</p>}
    </section>
  );
}
