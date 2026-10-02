import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import { modelIsUnverified, modelSelectionMode, modelSelectionPatch, modelsForAccount, reasoningOptions, withModelEffort, type ModelSelectionMode } from "@/features/squads/modelSelection";
import { refreshRosterModels } from "./ipc";
import type { Complexity, Roster } from "./types";

/** One persisted contract across Lead, workers, and Mission provider selection. */
export function ModelSelector({ roster, agentId, accountId, autoAccount, model, complexity, reasoningEffort = null, onChange, onRoster }: {
  roster: Roster | null; agentId: string; accountId: string | null; autoAccount: boolean;
  model: string | null; complexity: Complexity | null;
  reasoningEffort?: string | null;
  onChange: (patch: { model: string | null; complexity: Complexity | null; reasoningEffort?: string | null }) => void;
  onRoster: (roster: Roster) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const agent = roster?.agents.find((entry) => entry.agentId === agentId);
  const catalog = modelsForAccount(agent, accountId, autoAccount);
  const mode = modelSelectionMode(model, complexity);
  const selected = catalog.find((entry) => entry.id === model);
  const efforts = reasoningOptions(model, catalog);
  const selectModel = (patch: { model: string | null; complexity: Complexity | null }) => onChange(withModelEffort(patch, reasoningEffort, catalog));
  const groups = [
    { label: t("models.native"), models: catalog.filter((entry) => entry.source === "native") },
    { label: t("models.reference"), models: catalog.filter((entry) => entry.source === "provider_catalog") },
    { label: t("models.more"), models: catalog.filter((entry) => entry.source !== "native" && entry.source !== "ade_history" && entry.source !== "provider_catalog") },
    { label: t("models.history"), models: catalog.filter((entry) => entry.source === "ade_history") },
  ];
  const refresh = async () => {
    if (loading || !agentId) return;
    setLoading(true); setError("");
    try { onRoster(await refreshRosterModels(agentId, autoAccount ? null : accountId)); }
    catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  };
  return <div className="flex flex-col gap-2" role="group" aria-label={t("squads.form.modelMode")}>
    <label htmlFor={`${id}-mode`} className="text-[10.5px] font-semibold text-gray-600 dark:text-gray-300">{t("squads.form.modelMode")}</label>
    <select id={`${id}-mode`} className={SELECT} value={mode} disabled={!agentId}
      onChange={(event) => selectModel(modelSelectionPatch(event.target.value as ModelSelectionMode, model, complexity))}>
      <option value="provider-default">{t("squads.form.mode.providerDefault")}</option>
      <option value="complexity">{t("squads.form.mode.complexity")}</option>
      <option value="specific">{t("squads.form.mode.specific")}</option>
    </select>
    {mode === "complexity" && <select aria-label={t("squads.form.complexity")} className={SELECT} value={complexity ?? "standard"}
      onChange={(event) => selectModel({ model: null, complexity: event.target.value as Complexity })}>
      {(["trivial", "standard", "hard"] as const).map((value) => <option key={value} value={value}>{t(`fleet.complexity.${value}`)}</option>)}
    </select>}
    {mode === "specific" && <>
      <select aria-label={t("squads.form.model")} className={SELECT} value={selected ? model ?? "" : "__manual__"}
        onChange={(event) => selectModel({ model: event.target.value === "__manual__" ? "" : event.target.value, complexity: null })}>
        {groups.filter((group) => group.models.length > 0).map((group) => <optgroup key={group.label} label={group.label}>
          {group.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}{entry.source === "ade_history" ? ` · ${t("squads.form.unverified")}` : entry.availability === "unavailable" ? ` · ${t("squads.unavailable")}` : ""}</option>)}
        </optgroup>)}
        <option value="__manual__">{t("squads.form.manualModel")}</option>
      </select>
      {!selected && <Input size="sm" aria-label={t("squads.form.modelId")} placeholder={t("squads.form.modelPlaceholder")} value={model ?? ""}
        onChange={(event) => selectModel({ model: event.target.value, complexity: null })} />}
      {modelIsUnverified(model, catalog) && <span className="text-[10px] text-amber-700 dark:text-amber-300">{t("squads.form.unverified")}</span>}
      {selected?.availability === "unknown" && <span className="text-[10px] text-gray-400">{t("squads.form.entitlementUnknown")}</span>}
      {selected?.availability === "unavailable" && <span className="text-[10px] text-amber-700">{selected.unavailable ?? t("squads.unavailable")}</span>}
      <Button variant="ghost" size="sm" disabled={loading || !agentId} onClick={refresh} aria-busy={loading}>
        {t(loading ? "models.refreshing" : "models.refresh")}
      </Button>
    </>}
    <label htmlFor={`${id}-effort`} className="text-[10.5px] font-semibold text-gray-600 dark:text-gray-300">{t("models.effort")}</label>
    <select id={`${id}-effort`} className={SELECT} value={reasoningEffort ?? ""} disabled={mode !== "specific"}
      onChange={(event) => onChange({ model, complexity, reasoningEffort: event.target.value || null })}>
      <option value="">{t("models.effort.auto")}</option>
      {reasoningEffort && !efforts.includes(reasoningEffort) && <option value={reasoningEffort} disabled>{t(`models.effort.${reasoningEffort}`, { defaultValue: reasoningEffort })} · {t("squads.form.unverified")}</option>}
      {efforts.map((effort) => <option key={effort} value={effort}>{t(`models.effort.${effort}`, { defaultValue: effort })}</option>)}
    </select>
    {mode === "specific" && selected?.reasoningLevels == null && <span className="text-[10px] text-gray-400">{t("models.effort.unknown")}</span>}
    {error && <span role="alert" className="text-[10px] text-red-600">{error}</span>}
  </div>;
}

const SELECT = "rounded-lg px-2.5 h-8 text-[11.5px] bg-gray-100 dark:bg-surface-raised border border-gray-200 dark:border-white/10 text-gray-800 dark:text-gray-200";
