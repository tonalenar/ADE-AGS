import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import { clearDecisionKey, decisionShadowCsv, decisionShadowReport, getDecisionSettings, setDecisionKey, setDecisionSettings, testDecisionConnection, type PointReport, type ShadowReport } from "@/features/settings/decisionsIpc";
import { defaultDecisionSettings, isDirty, modelAfterProviderChange, modelsFor, parseTimeout, sendsOffMachine, urlAfterProviderChange, urlHost, type DecisionProviderId, type DecisionSettings } from "@/features/settings/decisionsModel";

const PROVIDERS: DecisionProviderId[] = ["none", "laya_local", "laya_studio", "jev"];
const POINT_LABEL: Record<string, string> = {
  memory_approval: "settings.decisions.point.memory",
  dream_triage: "settings.decisions.point.dream",
  fleet_gate: "settings.decisions.point.fleet",
  mission_gate: "settings.decisions.point.mission",
};

const FIELD = "h-8 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] text-gray-900 outline-none transition-shadow placeholder:text-gray-400 focus:border-accent-500 focus:ring-[3px] focus:ring-accent-500/25 dark:border-white/15 dark:bg-surface-raised dark:text-gray-100 dark:placeholder:text-white/30";
const BTN = "h-8 rounded-lg border border-gray-300 px-3 text-[13px] text-gray-800 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/15 dark:text-gray-100 dark:hover:bg-white/8";
const BTN_PRIMARY = "h-8 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-accent-600 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent-500";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.8" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

/** A bolinha de estado do cabeçalho: observando (verde) ou desligado (cinza). */
function StatusPill({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${on ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-gray-500/12 text-gray-600 dark:text-white/50"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-gray-400"}`} />
      {label}
    </span>
  );
}

function Stat({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-[11px] text-gray-500 dark:text-white/40">{label}</span>
      <span className={`text-[14px] font-medium tabular-nums ${muted ? "text-gray-400 dark:text-white/35" : "text-gray-900 dark:text-white"}`}>{value}</span>
    </span>
  );
}

export function DecisionsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<DecisionSettings>(defaultDecisionSettings);
  const [saved, setSaved] = useState<DecisionSettings>(defaultDecisionSettings);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  // O texto do campo de timeout enquanto se edita: apagar tudo para digitar de novo não pode virar 0.
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const [conn, setConn] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState<ShadowReport | null>(null);

  useEffect(() => {
    getDecisionSettings()
      .then((loaded) => {
        // Uma config já gravada com um modelo que o provedor não aceita (Jev com multilingual) é corrigida
        // na tela e aparece como alteração a salvar.
        setSettings({ ...loaded, model: modelAfterProviderChange(loaded.model, loaded.provider) });
        setSaved(loaded);
      })
      .catch((error: unknown) => setStatus(String(error)));
    decisionShadowReport().then(setReport).catch(() => undefined);
  }, []);

  const dirty = useMemo(() => isDirty(settings, saved) || keyDraft.trim() !== "", [settings, saved, keyDraft]);
  const providerLabel = (id: DecisionProviderId) => t(`settings.decisions.provider.${id === "laya_local" ? "layaLocal" : id === "laya_studio" ? "layaStudio" : id}`);
  const active = settings.enabled && settings.provider !== "none";

  const save = async () => {
    setStatus("");
    try {
      const next = await setDecisionSettings({
        enabled: settings.enabled,
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: modelAfterProviderChange(settings.model, settings.provider),
        timeoutMs: timeoutDraft === null ? parseTimeout(String(settings.timeoutMs)) : parseTimeout(timeoutDraft),
        memoryApproval: settings.memoryApproval,
        dreamTriage: settings.dreamTriage,
        fleetGate: settings.fleetGate,
        missionGate: settings.missionGate,
      });
      if (keyDraft.trim()) await setDecisionKey(keyDraft.trim());
      setKeyDraft("");
      const fresh = await getDecisionSettings();
      const stored = { ...next, keySaved: fresh.keySaved };
      setSettings(stored);
      setSaved(stored);
      setStatus(t("settings.decisions.saved"));
    } catch (error) {
      setStatus(String(error));
    }
  };

  const removeKey = async () => {
    setStatus("");
    try {
      await clearDecisionKey();
      setSettings((cur) => ({ ...cur, keySaved: false }));
      setSaved((cur) => ({ ...cur, keySaved: false }));
    } catch (error) {
      setStatus(String(error));
    }
  };

  const test = async () => {
    setStatus("");
    setConn(null);
    setTesting(true);
    try {
      const result = await testDecisionConnection();
      setConn(result.ok
        ? { ok: true, text: t("settings.decisions.testOk", { ms: result.latencyMs }) }
        : { ok: false, text: t("settings.decisions.testFail", { ms: result.latencyMs, error: result.error ?? "" }) });
    } catch (error) {
      setConn({ ok: false, text: String(error) });
    } finally {
      setTesting(false);
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

  const pointName = (point: PointReport) => (POINT_LABEL[point.point] ? t(POINT_LABEL[point.point]) : point.point);

  return (
    <SettingsSection
      title={t("settings.decisions")}
      description={t("settings.decisions.desc")}
      action={<StatusPill on={active} label={t(active ? "settings.decisions.status.on" : "settings.decisions.status.off")} />}
    >
      <SettingsGroup>
        <SettingsToggleRow
          checked={settings.enabled}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
          label={t("settings.decisions.enabled")}
          description={t("settings.decisions.enabledHint")}
        />
        <SettingsRow label={t("settings.decisions.provider")}>
          <PopupSelect
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
            className="min-w-44"
          >
            {PROVIDERS.map((id) => <option key={id} value={id}>{providerLabel(id)}</option>)}
          </PopupSelect>
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.baseUrl")} hint={t("settings.decisions.baseUrlHint")}>
          <input
            aria-label={t("settings.decisions.baseUrl")}
            value={settings.baseUrl}
            spellCheck={false}
            onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
            className={`${FIELD} w-72 font-mono text-[12px]`}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.model")}>
          <PopupSelect
            aria-label={t("settings.decisions.model")}
            value={modelAfterProviderChange(settings.model, settings.provider)}
            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            className="min-w-44"
          >
            {modelsFor(settings.provider).map((model) => <option key={model} value={model}>{model}</option>)}
          </PopupSelect>
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.timeout")} hint={t("settings.decisions.timeoutHint")}>
          <span className="flex items-center gap-2">
            <input
              aria-label={t("settings.decisions.timeout")}
              type="number"
              min={50}
              max={30000}
              value={timeoutDraft ?? String(settings.timeoutMs)}
              onChange={(event) => {
                setTimeoutDraft(event.target.value);
                const typed = Number(event.target.value);
                if (event.target.value.trim() !== "" && Number.isFinite(typed)) setSettings({ ...settings, timeoutMs: typed });
              }}
              onBlur={() => {
                if (timeoutDraft === null) return;
                setSettings({ ...settings, timeoutMs: parseTimeout(timeoutDraft) });
                setTimeoutDraft(null);
              }}
              className={`${FIELD} w-24 text-right tabular-nums`}
            />
            <span className="text-[12px] text-gray-500 dark:text-white/40">ms</span>
          </span>
        </SettingsRow>
        <SettingsRow label={t("settings.decisions.key")} hint={settings.keySaved ? t("settings.decisions.key.saved") : t("settings.decisions.keyHint")}>
          <span className="flex items-center gap-1.5">
            <span className="relative">
              <input
                aria-label={t("settings.decisions.key")}
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={keyDraft}
                placeholder={settings.keySaved ? "••••••••••••" : t("settings.decisions.key.placeholder")}
                onChange={(event) => setKeyDraft(event.target.value)}
                className={`${FIELD} w-72 pr-9 font-mono text-[12px]`}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={t(showKey ? "settings.decisions.key.hide" : "settings.decisions.key.show")}
                aria-label={t(showKey ? "settings.decisions.key.hide" : "settings.decisions.key.show")}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-black/5 hover:text-gray-700 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <EyeIcon off={showKey} />
              </button>
            </span>
            {settings.keySaved && (
              <button type="button" onClick={() => void removeKey()} className={`${BTN} text-red-600 dark:text-red-300`}>
                {t("settings.decisions.keyClear")}
              </button>
            )}
          </span>
        </SettingsRow>
      </SettingsGroup>

      {sendsOffMachine(settings) && (
        <p
          role="note"
          className="rounded-lg border border-amber-200/70 bg-amber-50/80 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/[0.07] dark:text-amber-200"
        >
          {t("settings.decisions.remoteWarn", { host: urlHost(settings.baseUrl) ?? settings.baseUrl })}
        </p>
      )}

      <h3 className="px-1 pt-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-white/40">{t("settings.decisions.group.points")}</h3>
      <SettingsGroup>
        <SettingsToggleRow checked={settings.memoryApproval} onChange={(memoryApproval) => setSettings({ ...settings, memoryApproval })} label={t("settings.decisions.point.memory")} description={t("settings.decisions.point.memoryHint")} />
        <SettingsToggleRow checked={settings.dreamTriage} onChange={(dreamTriage) => setSettings({ ...settings, dreamTriage })} label={t("settings.decisions.point.dream")} description={t("settings.decisions.point.dreamHint")} />
        <SettingsToggleRow checked={settings.fleetGate} onChange={(fleetGate) => setSettings({ ...settings, fleetGate })} label={t("settings.decisions.point.fleet")} description={t("settings.decisions.point.fleetHint")} />
        <SettingsToggleRow checked={settings.missionGate} onChange={(missionGate) => setSettings({ ...settings, missionGate })} label={t("settings.decisions.point.mission")} description={t("settings.decisions.point.missionHint")} />
      </SettingsGroup>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={!dirty} className={BTN_PRIMARY}>{t("settings.decisions.save")}</button>
        <button type="button" onClick={() => void test()} disabled={testing} className={BTN}>{testing ? t("settings.decisions.testing") : t("settings.decisions.test")}</button>
        {dirty && <span className="text-[12px] text-amber-600 dark:text-amber-300">{t("settings.decisions.dirty")}</span>}
        {conn && (
          <span role="status" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${conn.ok ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-red-500/12 text-red-700 dark:text-red-300"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${conn.ok ? "bg-emerald-500" : "bg-red-500"}`} />
            {conn.text}
          </span>
        )}
      </div>
      {status && <p className="text-[12.5px] text-gray-600 dark:text-white/70">{status}</p>}

      <SettingsSection
        title={t("settings.decisions.report")}
        action={
          <span className="flex gap-2">
            <button type="button" onClick={() => void loadReport()} className={BTN}>{t("settings.decisions.refresh")}</button>
            <button type="button" onClick={() => void exportCsv().catch((error: unknown) => setStatus(String(error)))} className={BTN}>{t("settings.decisions.export")}</button>
          </span>
        }
      >
        {!report || report.points.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center text-[12.5px] text-gray-500 dark:border-white/15 dark:text-white/45">{t("settings.decisions.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {report.points.map((point) => (
              <div key={point.point} className="rounded-xl border border-gray-200 bg-white/60 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-gray-900 dark:text-white">{pointName(point)}</span>
                  <span className="font-mono text-[11px] text-gray-400 dark:text-white/35">{point.point}</span>
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  <Stat label={t("settings.decisions.col.total")} value={String(point.total)} />
                  <Stat label={t("settings.decisions.agreement")} value={pct(point.agreementRate)} muted={point.lowSample} />
                  <Stat label={t("settings.decisions.latency")} value={`${point.p50Ms ?? "—"} / ${point.p95Ms ?? "—"} ms`} />
                  <Stat label={t("settings.decisions.errors")} value={pct(point.errorRate)} />
                  <Stat label={t("settings.decisions.timeouts")} value={pct(point.timeoutRate)} />
                </div>
                {point.lowSample && (
                  <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">
                    {t("settings.decisions.lowSample", { have: point.compared, n: report.minSample })}
                  </p>
                )}
                <ul className="mt-2 flex flex-col gap-1.5">
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
              </div>
            ))}
            <Fragment>
              <h4 className="text-[13px] font-medium text-gray-900 dark:text-white">{t("settings.decisions.disagreements")}</h4>
              {report.disagreements.length === 0 ? (
                <p className="text-[12.5px] text-gray-500 dark:text-white/45">{t("settings.decisions.noDisagreement")}</p>
              ) : (
                <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-gray-700 dark:text-gray-200">
                  {report.disagreements.map((row) => (
                    <li key={`${row.point}-${row.stateHash}-${row.heuristic}`} className="break-all">{row.point} {row.stateHash} {row.heuristic} ≠ {row.providerDecision}</li>
                  ))}
                </ul>
              )}
            </Fragment>
          </div>
        )}
      </SettingsSection>
    </SettingsSection>
  );
}
