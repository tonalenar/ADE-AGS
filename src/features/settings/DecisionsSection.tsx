import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import { clearDecisionKey, decisionShadowCsv, decisionShadowReport, getDecisionSettings, setDecisionKey, setDecisionSettings, testDecisionConnection, type ShadowReport } from "@/features/settings/decisionsIpc";
import { clampTimeout, defaultDecisionSettings, modelAfterProviderChange, modelsFor, sendsOffMachine, urlAfterProviderChange, urlHost, type DecisionProviderId, type DecisionSettings } from "@/features/settings/decisionsModel";

const PROVIDERS: DecisionProviderId[] = ["none", "laya_local", "laya_studio", "jev"];

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function DecisionsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<DecisionSettings>(defaultDecisionSettings);
  const [keyDraft, setKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<ShadowReport | null>(null);

  useEffect(() => {
    getDecisionSettings()
      .then((loaded) => setSettings({
        ...loaded,
        model: modelAfterProviderChange(loaded.model, loaded.provider),
      }))
      .catch((error: unknown) => setStatus(String(error)));
  }, []);

  const providerLabel = (id: DecisionProviderId) => t(`settings.decisions.provider.${id === "laya_local" ? "layaLocal" : id === "laya_studio" ? "layaStudio" : id}`);

  const save = async () => {
    setStatus("");
    try {
      const next = await setDecisionSettings({
        enabled: settings.enabled,
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: modelAfterProviderChange(settings.model, settings.provider),
        timeoutMs: clampTimeout(settings.timeoutMs),
        memoryApproval: settings.memoryApproval,
        dreamTriage: settings.dreamTriage,
        fleetGate: settings.fleetGate,
        missionGate: settings.missionGate,
      });
      if (clearKey) await clearDecisionKey();
      if (keyDraft.trim()) await setDecisionKey(keyDraft.trim());
      setKeyDraft("");
      setClearKey(false);
      const fresh = await getDecisionSettings();
      setSettings({ ...next, keySaved: fresh.keySaved });
      setStatus(t("settings.decisions.saved"));
    } catch (error) {
      setStatus(String(error));
    }
  };

  const test = async () => {
    setStatus("");
    try {
      const result = await testDecisionConnection();
      setStatus(result.ok
        ? t("settings.decisions.testOk", { ms: result.latencyMs })
        : t("settings.decisions.testFail", { ms: result.latencyMs, error: result.error ?? "" }));
    } catch (error) {
      setStatus(String(error));
    }
  };

  const loadReport = async () => {
    setStatus("");
    try {
      setReport(await decisionShadowReport());
    } catch (error) {
      setStatus(String(error));
    }
  };

  const exportCsv = async () => {
    const csv = await decisionShadowCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "decision-shadow.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SettingsSection title={t("settings.decisions")} description={t("settings.decisions.desc")}>
      <SettingsGroup>
        <SettingsToggleRow
          checked={settings.enabled}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
          label={t("settings.decisions.enabled")}
          description={t("settings.decisions.enabledHint")}
        />
        <SettingsRow label={t("settings.decisions.provider")}>
          <select
            aria-label={t("settings.decisions.provider")}
            value={settings.provider}
            onChange={(event) => {
              const provider = event.target.value as DecisionProviderId;
              setSettings({
                ...settings,
                provider,
                baseUrl: urlAfterProviderChange(settings.baseUrl, provider),
                model: modelAfterProviderChange(settings.model, provider),
              });
            }}
            className="h-8 rounded-md bg-transparent px-2 text-[13px] text-gray-900 dark:text-gray-100"
          >
            {PROVIDERS.map((id) => <option key={id} value={id}>{providerLabel(id)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.baseUrl")} hint={t("settings.decisions.baseUrlHint")}>
          <input
            aria-label={t("settings.decisions.baseUrl")}
            value={settings.baseUrl}
            onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
            className="h-8 w-64 rounded-md bg-transparent px-2 font-mono text-[12px] text-gray-900 dark:text-gray-100"
          />
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.model")}>
          <select
            aria-label={t("settings.decisions.model")}
            value={modelAfterProviderChange(settings.model, settings.provider)}
            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            className="h-8 rounded-md bg-transparent px-2 text-[13px] text-gray-900 dark:text-gray-100"
          >
            {modelsFor(settings.provider).map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.timeout")} hint={t("settings.decisions.timeoutHint")}>
          <input
            aria-label={t("settings.decisions.timeout")}
            type="number"
            min={50}
            max={30000}
            value={settings.timeoutMs}
            onChange={(event) => setSettings({ ...settings, timeoutMs: Number(event.target.value) })}
            className="h-8 w-24 rounded-md bg-transparent px-2 text-right text-[13px] text-gray-900 dark:text-gray-100"
          />
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.key")} hint={settings.keySaved ? t("settings.decisions.keySaved") : t("settings.decisions.keyHint")}>
          <input
            aria-label={t("settings.decisions.key")}
            type="password"
            autoComplete="off"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            className="h-8 w-48 rounded-md bg-transparent px-2 text-[13px] text-gray-900 dark:text-gray-100"
          />
        </SettingsRow>
        <SettingsToggleRow
          checked={clearKey}
          onChange={setClearKey}
          label={t("settings.decisions.keyClear")}
        />
      </SettingsGroup>

      {sendsOffMachine(settings) && (
        <p
          role="note"
          className="rounded-md border border-amber-200/70 bg-amber-50/80 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/[0.07] dark:text-amber-200"
        >
          {t("settings.decisions.remoteWarn", { host: urlHost(settings.baseUrl) ?? settings.baseUrl })}
        </p>
      )}

      <SettingsGroup>
        <SettingsToggleRow checked={settings.memoryApproval} onChange={(memoryApproval) => setSettings({ ...settings, memoryApproval })} label={t("settings.decisions.point.memory")} description={t("settings.decisions.point.memoryHint")} />
        <SettingsToggleRow checked={settings.dreamTriage} onChange={(dreamTriage) => setSettings({ ...settings, dreamTriage })} label={t("settings.decisions.point.dream")} description={t("settings.decisions.point.dreamHint")} />
        <SettingsToggleRow checked={settings.fleetGate} onChange={(fleetGate) => setSettings({ ...settings, fleetGate })} label={t("settings.decisions.point.fleet")} description={t("settings.decisions.point.fleetHint")} />
        <SettingsToggleRow checked={settings.missionGate} onChange={(missionGate) => setSettings({ ...settings, missionGate })} label={t("settings.decisions.point.mission")} description={t("settings.decisions.point.missionHint")} />
      </SettingsGroup>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} className="h-8 rounded-md bg-gray-900 px-3 text-[13px] text-white dark:bg-white dark:text-gray-900">{t("settings.decisions.save")}</button>
        <button type="button" onClick={() => void test()} className="h-8 rounded-md border border-gray-300 px-3 text-[13px] text-gray-800 dark:border-white/20 dark:text-gray-100">{t("settings.decisions.test")}</button>
        <button type="button" onClick={() => void loadReport()} className="h-8 rounded-md border border-gray-300 px-3 text-[13px] text-gray-800 dark:border-white/20 dark:text-gray-100">{t("settings.decisions.refresh")}</button>
        <button type="button" onClick={() => void exportCsv().catch((error: unknown) => setStatus(String(error)))} className="h-8 rounded-md border border-gray-300 px-3 text-[13px] text-gray-800 dark:border-white/20 dark:text-gray-100">{t("settings.decisions.export")}</button>
      </div>
      {status && <p className="text-[12.5px] text-gray-600 dark:text-white/70">{status}</p>}

      <SettingsSection title={t("settings.decisions.report")}>
        {!report || report.points.length === 0 ? (
          <p className="text-[12.5px] text-gray-500 dark:text-white/45">{t("settings.decisions.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <table className="w-full text-left text-[12.5px] text-gray-800 dark:text-gray-100">
              <thead>
                <tr className="text-gray-500 dark:text-white/45">
                  <th className="py-1 pr-3 font-medium">{t("settings.decisions.col.point")}</th>
                  <th className="py-1 pr-3 font-medium">{t("settings.decisions.col.total")}</th>
                  <th className="py-1 pr-3 font-medium">{t("settings.decisions.agreement")}</th>
                  <th className="py-1 pr-3 font-medium">{t("settings.decisions.latency")}</th>
                  <th className="py-1 pr-3 font-medium">{t("settings.decisions.errors")}</th>
                  <th className="py-1 font-medium">{t("settings.decisions.timeouts")}</th>
                </tr>
              </thead>
              <tbody>
                {report.points.map((point) => (
                  <Fragment key={point.point}>
                    <tr className="border-t border-gray-200 dark:border-white/10">
                      <td className="py-1 pr-3">{point.point}</td>
                      <td className="py-1 pr-3">{point.total}</td>
                      <td className={`py-1 pr-3 ${point.lowSample ? "text-gray-400 dark:text-white/35" : ""}`}>{pct(point.agreementRate)}</td>
                      <td className="py-1 pr-3">{point.p50Ms ?? "—"} / {point.p95Ms ?? "—"} ms</td>
                      <td className="py-1 pr-3">{pct(point.errorRate)}</td>
                      <td className="py-1">{pct(point.timeoutRate)}</td>
                    </tr>
                    <tr>
                      <td colSpan={6} className="pb-2">
                        {point.lowSample && (
                          <p className="mb-1 text-[12px] text-amber-700 dark:text-amber-300">
                            {t("settings.decisions.lowSample", { have: point.compared, n: report.minSample })}
                          </p>
                        )}
                        <ul className="flex flex-col gap-1">
                          {point.questions.map((q) => (
                            <li key={q.question} className="text-[12px] text-gray-700 dark:text-gray-200">
                              <span className="font-medium">{q.question}</span>{" "}
                              {t("settings.decisions.q.agree", { pct: pct(q.agreementRate), n: q.compared })}
                              {q.blindLabels.length > 0 && q.blindRate > 0 && (
                                <> {t("settings.decisions.q.blind", { labels: q.blindLabels.join(", "), pct: pct(q.blindRate) })}</>
                              )}
                              <div className="break-all font-mono text-[11px] text-gray-500 dark:text-white/45">
                                {q.pairs.map((pair) => `${pair.heuristic} → ${pair.provider} ×${pair.count}`).join("   ")}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            <div>
              <h4 className="mb-1 text-[13px] font-medium text-gray-900 dark:text-white">{t("settings.decisions.disagreements")}</h4>
              {report.disagreements.length === 0 ? (
                <p className="text-[12.5px] text-gray-500 dark:text-white/45">{t("settings.decisions.noDisagreement")}</p>
              ) : (
                <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-gray-700 dark:text-gray-200">
                  {report.disagreements.map((row) => (
                    <li key={`${row.point}-${row.stateHash}-${row.heuristic}`} className="break-all">{row.point} {row.stateHash} {row.heuristic} ≠ {row.providerDecision}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SettingsSection>
    </SettingsSection>
  );
}
