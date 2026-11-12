import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { agentName } from "@/features/agents/agentTile";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow, ChatSwitch } from "@/features/settings/SettingsSection";

import { chatAutocompactPlans, saveAutoCompactConfig } from "./ipc";
import { MAX_PCT, MIN_PCT, DEFAULT_PCT, autoCompactEnabledFor, clampPct, effectivePct, type AutoCompactConfig, type AutoCompactPlan } from "./model";
import { useAutoCompact } from "./store";

/** `claude-code` aparece uma vez por superfície: a tela agrupa por agente e mostra o mecanismo de cada superfície. */
function groupByAgent(plans: AutoCompactPlan[]): [string, AutoCompactPlan[]][] {
  const map = new Map<string, AutoCompactPlan[]>();
  for (const plan of plans) {
    if (plan.surface === "fleet") continue;
    map.set(plan.agentId, [...(map.get(plan.agentId) ?? []), plan]);
  }
  return [...map.entries()];
}

/**
 * Personalização do autocompact de contexto: liga e desliga global e por agente, o limiar em % da janela e o mapa do que
 * cada agente suporta (com o motivo quando está desligado). A ADE só compacta no fim do turno, pelo comando nativo do
 * agente; terminais nunca recebem digitação da ADE.
 */
export function AutoCompactSetting() {
  const { t } = useTranslation();
  const config = useAutoCompact((s) => s.config);
  const loaded = useAutoCompact((s) => s.loaded);
  const load = useAutoCompact((s) => s.load);
  const setConfig = useAutoCompact((s) => s.set);
  const [plans, setPlans] = useState<AutoCompactPlan[] | null>(null);
  const [error, setError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let alive = true;
    chatAutocompactPlans().then((rows) => alive && setPlans(rows), () => alive && setPlans([]));
    return () => { alive = false; };
  }, []);

  const commit = (next: AutoCompactConfig) => {
    const previous = config;
    setConfig(next);
    saveAutoCompactConfig(next).then(() => setError(false), () => { setConfig(previous); setError(true); });
  };
  const patchAgent = (agentId: string, patch: { enabled?: boolean; thresholdPct?: number | null }) => {
    const current = { ...(config.agents[agentId] ?? {}) };
    if (patch.enabled !== undefined) current.enabled = patch.enabled;
    if (patch.thresholdPct === null) delete current.thresholdPct;
    else if (patch.thresholdPct !== undefined) current.thresholdPct = patch.thresholdPct;
    commit({ ...config, agents: { ...config.agents, [agentId]: current } });
  };
  const saveThreshold = (agentId: string) => {
    const value = Number(drafts[agentId]);
    if (!Number.isFinite(value)) return;
    patchAgent(agentId, { thresholdPct: clampPct(value) });
    setDrafts((d) => { const { [agentId]: _drop, ...rest } = d; return rest; });
  };

  const groups = plans ? groupByAgent(plans) : [];
  return (
    <SettingsSection title={t("chat.autocompact.title")} description={t("chat.autocompact.description")}>
      <SettingsGroup>
        <SettingsToggleRow label={t("chat.autocompact.global")} description={t("chat.autocompact.globalHint")}
          checked={config.enabled} disabled={!loaded} onChange={(enabled) => commit({ ...config, enabled })} />
        {groups.map(([agentId, rows]) => {
          const chat = rows.find((r) => r.surface === "chat");
          const manageable = rows.some((r) => r.supported);
          const enabled = autoCompactEnabledFor(config, agentId);
          const explicit = config.agents[agentId]?.thresholdPct;
          const draft = drafts[agentId] ?? String(effectivePct(config, agentId));
          return (
            <div key={agentId} className="flex flex-col gap-2 px-4 py-3.5" data-autocompact-agent={agentId}>
              <div className="flex items-center justify-between gap-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-gray-900 dark:text-white">{agentName(agentId)}</span>
                  {!manageable && <span className="text-[13px] text-gray-500 dark:text-white/50">{t("chat.autocompact.off")}</span>}
                </span>
                <ChatSwitch label={t("chat.autocompact.agentSwitch", { agent: agentName(agentId) })}
                  checked={manageable && (config.agents[agentId]?.enabled ?? true)} disabled={!loaded || !manageable}
                  onChange={(next) => patchAgent(agentId, { enabled: next })} />
              </div>
              {chat?.supported && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="mr-auto text-[13px] text-gray-500 dark:text-white/50" htmlFor={`autocompact-pct-${agentId}`}>
                    {t("chat.autocompact.threshold")}
                  </label>
                  <input id={`autocompact-pct-${agentId}`} type="number" min={MIN_PCT} max={MAX_PCT} step={1} value={draft}
                    disabled={!loaded || !enabled} onChange={(e) => setDrafts((d) => ({ ...d, [agentId]: e.target.value }))}
                    className="h-8 w-20 rounded-md border border-gray-300 bg-white px-2 text-[13px] text-gray-900 outline-none focus:ring-2 focus:ring-accent-500/40 disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-white" />
                  <span className="text-[13px] text-gray-500 dark:text-white/50">%</span>
                  <Button variant="outline" size="sm" onClick={() => saveThreshold(agentId)} disabled={!loaded || !enabled || drafts[agentId] === undefined}>
                    {t("chat.autocompact.save")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => patchAgent(agentId, { thresholdPct: null })} disabled={!loaded || explicit === undefined}>
                    {t("chat.autocompact.useDefault", { pct: DEFAULT_PCT })}
                  </Button>
                </div>
              )}
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {rows.map((row) => (
                  <li key={row.surface} className="text-[12px] leading-4 text-gray-500 dark:text-white/45">
                    <span className="font-medium">{t(`chat.autocompact.surface.${row.surface}`)}</span>
                    {": "}{t(`chat.autocompact.reason.${row.reason}`)}
                    {" "}<span className="opacity-80">({t(`chat.autocompact.measure.${row.measure}`)})</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <SettingsRow label={t("chat.autocompact.fleet")} hint={t("chat.autocompact.fleetHint")}><span /></SettingsRow>
      </SettingsGroup>
      <p className="m-0 px-1 text-[12px] leading-4 text-gray-500 dark:text-white/45">{t("chat.autocompact.terminalsNote")}</p>
      {error && <p role="alert" className="m-0 text-[12px] text-red-600 dark:text-red-400">{t("chat.autocompact.saveFailed")}</p>}
    </SettingsSection>
  );
}
