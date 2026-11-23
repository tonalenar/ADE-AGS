import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSetting, setSetting } from "@/shared/ipc/settings";
import { DEFAULT_MAX_AGENTS, MAX_AGENTS_SETTING, MAX_MAX_AGENTS, MIN_MAX_AGENTS, parseMaxAgents } from "./lineageModel";

/** O limite de agentes de um orquestrador trabalhando ao mesmo tempo (`team.max_agents`; o backend recusa o novo além dele). */
export function MaxAgentsSetting() {
  const { t } = useTranslation();
  const [value, setValue] = useState(DEFAULT_MAX_AGENTS);
  useEffect(() => {
    let alive = true;
    Promise.resolve(getSetting(MAX_AGENTS_SETTING)).then((raw) => { if (alive) setValue(parseMaxAgents(typeof raw === "string" ? raw : null)); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <label title={t("chat.team.maxAgents.hint")} className="mx-3.5 mb-1 flex items-center gap-2 text-chat-caption text-gray-600 dark:text-white/55">
      <input type="number" min={MIN_MAX_AGENTS} max={MAX_MAX_AGENTS} value={value} aria-label={t("chat.team.maxAgents.label")}
        onChange={(e) => {
          const next = parseMaxAgents(e.target.value);
          setValue(next);
          Promise.resolve(setSetting(MAX_AGENTS_SETTING, String(next))).catch(() => undefined);
        }}
        className="w-12 h-6 px-1 rounded-md border border-gray-200 dark:border-white/[0.12] bg-transparent text-center" />
      {t("chat.team.maxAgents.label")}
    </label>
  );
}
