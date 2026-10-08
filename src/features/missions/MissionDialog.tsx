import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Alert, AnimateSpin, Button, FolderIcon } from "neogestify-ui-components";

import { findDuplicateMission } from "./duplicates";
import { useMissionsStore } from "./store";
import { ModelSelector } from "@/features/runs/ModelSelector";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { Segmented } from "@/shared/ui/Segmented";
import { modelsForAccount, withModelEffort } from "@/features/squads/modelSelection";
import { getRoster } from "@/features/runs/ipc";
import { COMPLEXITIES } from "@/features/runs/routingView";
import { leadUnsupported, providerDisabled } from "@/features/runs/leadProviders";
import type { Roster } from "@/features/runs/types";
import { AccountPickerStep, AUTO_ACCOUNT } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";
import { listSquads } from "@/features/squads/ipc";
import { useSquadAccountLabel } from "@/features/squads/accountLabel";
import type { Squad } from "@/features/squads/types";

import { missingFields, switchExecutionMode, toInput, type MissionForm, type ModelMode } from "./missionView";
import type { MissionInput } from "./types";

const PARALLEL = [1, 2, 3, 4] as const;

/**
 * Crear o editar un borrador. Guardar NO lanza nada: la misión queda en borrador hasta que
 * se aprieta "Iniciar" en su detalle.
 */
export function MissionDialog({ initial, editing, onClose, onSave }: {
  initial: MissionForm;
  editing: boolean;
  onClose: () => void;
  onSave: (input: MissionInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [form, setForm] = useState<MissionForm>(initial);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [squads, setSquads] = useState<Squad[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof MissionForm>(key: K, value: MissionForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Solo para ofrecer modelos. Crear el borrador no depende de que el roster conteste.
  useEffect(() => {
    getRoster().then(setRoster).catch(() => setRoster(null));
    listSquads().then(setSquads).catch(() => setSquads([]));
  }, []);

  const agents = roster?.agents ?? [];
  const missing = missingFields(form);
  const selectedSquad = squads.find((squad) => squad.id === form.squadId) ?? null;
  const canSave = !(form.executionMode === "specific" && leadUnsupported(agents.find((agent) => agent.agentId === form.agentId))) && missing.length === 0 && (form.executionMode !== "squad" || Boolean(form.squadId)) && !(form.executionMode === "specific" && form.mode === "fixed" && form.model === "") && !busy;

  const missions = useMissionsStore((s) => s.missions);
  const duplicate = useMemo(
    () => findDuplicateMission(missions, { title: form.title, objective: form.objective }),
    [missions, form.title, form.objective]
  );

  const pickFolder = async () => {
    const dir = await open({ directory: true, defaultPath: form.cwd || undefined });
    if (typeof dir === "string") set("cwd", dir);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(toInput(form));
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const accountValue = form.autoAccount ? AUTO_ACCOUNT : (form.accountId ?? undefined);

  return (
    <AppDialog
      title={editing ? t("missions.form.editTitle") : t("missions.form.title")}
      size="md"
      closeOnEsc
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={save}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {editing ? t("missions.form.save") : t("missions.form.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("missions.form.name")}>
          <input value={form.title} onChange={(e) => set("title", e.target.value)} autoFocus className={FIELD} />
        </Field>

        <Field label={t("missions.form.objective")} hint={t("missions.form.objectiveHint")}>
          <textarea
            rows={4}
            value={form.objective}
            onChange={(e) => set("objective", e.target.value)}
            placeholder={t("fleet.orchestrate.objectivePlaceholder")}
            className="block w-full resize-none rounded-[10px] bg-black/[0.05] px-3 py-2.5 text-[13px] leading-[19px] text-gray-900 outline-none
              placeholder:text-gray-400 focus:ring-[3px] focus:ring-accent-500/30 dark:bg-surface-raised dark:text-[#f5f5f7] dark:placeholder:text-white/30"
          />
        </Field>

        {duplicate && (
          <Alert variant="warning">
            {duplicate.isRunning
              ? t("missions.duplicate.bannerRunning", { title: duplicate.mission.title })
              : t("missions.duplicate.bannerRecent", { title: duplicate.mission.title })}
          </Alert>
        )}

        <Field label={t("missions.form.project")}>
          <div className="flex items-center gap-2">
            <label className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[7px] bg-black/[0.05] px-2.5 focus-within:ring-[3px] focus-within:ring-accent-500/30 dark:bg-surface-raised">
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-white/35" />
              <input
                value={form.cwd}
                onChange={(e) => set("cwd", e.target.value)}
                aria-label={t("missions.form.project")}
                className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-gray-900 outline-none dark:text-[#f5f5f7]"
              />
            </label>
            <Button variant="outline" onClick={pickFolder} aria-label={t("missions.form.pickFolder")}>{t("missions.form.pick")}</Button>
          </div>
        </Field>

        <div>
          <div className={LABEL}>{t("missions.form.config")}</div>
          <div className="overflow-hidden rounded-xl border border-black/[0.1] bg-gray-50 dark:border-[rgba(84,84,88,0.55)] dark:bg-surface-deep">
            <Row label={t("missions.form.executionMode")}>
              <Segmented
                label={t("missions.form.executionMode")}
                value={form.executionMode}
                onChange={(value) => setForm((current) => switchExecutionMode(current, value))}
                options={[
                  { value: "automatic", label: t("missions.form.automatic") },
                  { value: "specific", label: t("missions.form.specific") },
                  { value: "squad", label: t("missions.form.squad") },
                ]}
              />
            </Row>

            {form.executionMode === "automatic" && (
              <Row label={t("fleet.orchestrate.leadModel")} hint={t("fleet.new.modelHint")}>
                <Segmented
                  label={t("fleet.orchestrate.leadModel")}
                  value={(form.mode === "fixed" ? "hard" : form.mode) as ModelMode}
                  onChange={(value) => set("mode", value)}
                  options={COMPLEXITIES.map((complexity) => ({ value: complexity as ModelMode, label: t(`fleet.complexity.${complexity}`) }))}
                />
              </Row>
            )}

            {form.executionMode === "specific" && (
              <Row stacked label={t("missions.form.leadProviderModel")}>
                <PopupSelect className={SELECT} aria-label={t("squads.form.provider")} value={form.agentId}
                  onChange={(event) => setForm((current) => ({ ...current, agentId: event.target.value, model: null, reasoningEffort: null, mode: "fixed", accountId: null, autoAccount: true }))}>
                  {!agents.some((agent) => agent.agentId === form.agentId) && <option value={form.agentId}>{form.agentId} ? {t("squads.unavailable")}</option>}
                  {agents.map((agent) => <option key={agent.agentId} value={agent.agentId} disabled={providerDisabled(agent, true)}>{agent.label}{leadUnsupported(agent) ? " · " + t("squads.leadUnsupported") : ""}</option>)}
                </PopupSelect>
                {leadUnsupported(agents.find((agent) => agent.agentId === form.agentId)) && <Alert variant="warning">{t("squads.leadUnsupported")}</Alert>}
                <ModelSelector roster={roster} onRoster={setRoster} agentId={form.agentId} accountId={form.accountId} autoAccount={form.autoAccount}
                  reasoningEffort={form.reasoningEffort}
                  model={form.mode === "fixed" ? form.model : null} complexity={form.mode === "fixed" ? null : form.mode}
                  onChange={(patch) => setForm((current) => ({ ...current, model: patch.model, reasoningEffort: patch.reasoningEffort ?? null, mode: patch.complexity ?? "fixed" }))} />
              </Row>
            )}

            {form.executionMode === "specific" && (
              <Row stacked label={t("fleet.new.account")}>
                <AccountPickerStep
                  agentId={form.agentId}
                  value={accountValue}
                  onChange={(value) => setForm((current) => ({
                    ...current,
                    autoAccount: value === AUTO_ACCOUNT,
                    accountId: value === AUTO_ACCOUNT ? null : (value ?? null),
                    reasoningEffort: withModelEffort({ model: current.model || null, complexity: null }, current.reasoningEffort ?? null,
                      modelsForAccount(roster?.agents.find((agent) => agent.agentId === current.agentId),
                        value === AUTO_ACCOUNT ? null : (value ?? null), value === AUTO_ACCOUNT)).reasoningEffort,
                  }))}
                  showLabel={false}
                  allowAuto
                />
              </Row>
            )}

            {form.executionMode === "squad" && (
              <Row stacked label={t("missions.form.squad")} hint={t("missions.form.squadHint")}>
                <PopupSelect
                  value={form.squadId ?? ""}
                  onChange={(event) => set("squadId", event.target.value || null)}
                  className={SELECT}
                >
                  <option value="">{t("missions.form.chooseSquad")}</option>
                  {squads.map((squad) => (
                    <option key={squad.id} value={squad.id}>
                      {squad.name}{squad.available ? "" : ` · ${t("squads.unavailable")}`}
                    </option>
                  ))}
                </PopupSelect>
                {selectedSquad && <SquadExecutionSummary squad={selectedSquad} />}
                {selectedSquad && !selectedSquad.available && (
                  <Alert variant="warning">{selectedSquad.unavailableReasons.join("; ")}</Alert>
                )}
                {squads.length === 0 && (
                  <div className="flex items-center justify-between gap-2 text-[11.5px] text-gray-500 dark:text-white/45">
                    <span>{t("missions.form.noSquads")}</span>
                    <Button variant="ghost" size="sm" onClick={() => navigate("/squads")}>{t("squads.manage")}</Button>
                  </div>
                )}
              </Row>
            )}

            <Row label={t("fleet.orchestrate.parallel")} hint={t("fleet.orchestrate.parallelHint")}>
              <Segmented
                label={t("fleet.orchestrate.parallel")}
                value={String(form.maxParallel)}
                onChange={(v) => set("maxParallel", Number(v))}
                options={PARALLEL.map((n) => ({ value: String(n), label: String(n) }))}
                className="w-40"
              />
            </Row>

            <Row label={t("fleet.orchestrate.budget")} hint={t("fleet.new.budgetHint")}>
              <input
                value={form.budget}
                onChange={(e) => set("budget", e.target.value)}
                inputMode="decimal"
                placeholder="1.00"
                aria-label={t("fleet.orchestrate.budget")}
                className={`${FIELD} w-28 text-right font-mono`}
              />
            </Row>
          </div>
          <p className="mt-2 px-1 text-[11.5px] leading-4 text-gray-400 dark:text-white/35">{t("missions.form.draftHint")}</p>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}

function SquadExecutionSummary({ squad }: { squad: Squad }) {
  const { t } = useTranslation();
  const accountLabel = useSquadAccountLabel();
  const { agents } = useRosterForLabels();
  const agentLabel = (agentId: string) => agents.find((agent) => agent.agentId === agentId)?.label ?? agentId;
  const modelLabel = (agentId: string, model: string | null) => {
    if (!model) return t("squads.providerDefault");
    return agents.find((agent) => agent.agentId === agentId)?.models.find((entry) => entry.id === model)?.label ?? model;
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-white/3 p-2.5">
      <div className="text-[11px] font-semibold text-gray-800 dark:text-gray-200">{squad.name}</div>
      <div className="text-[10.5px] text-gray-500 dark:text-white/45">
        {t("squads.lead")}: {agentLabel(squad.lead.agentId)} · {modelLabel(squad.lead.agentId, squad.lead.model)} · {accountLabel(squad.lead.accountId, squad.lead.autoAccount)}
        {squad.lead.availability !== "available" && (
          <span className={`ml-1 ${squad.lead.availability === "unknown" ? "text-gray-400 dark:text-white/35" : "text-amber-700 dark:text-amber-300"}`}>
            · {t(`squads.availability.${squad.lead.availability}`)}
          </span>
        )}
      </div>
      {squad.members.map((member) => (
        <div key={member.roleId} className="flex items-center justify-between gap-3 text-[10.5px]">
          <span className="font-medium text-gray-700 dark:text-gray-300">{t(`squads.roleNames.${member.roleId}`, { defaultValue: member.roleId })}</span>
          <span className="truncate text-right text-gray-500 dark:text-white/45">
            {agentLabel(member.agentId)} · {modelLabel(member.agentId, member.model)} · {accountLabel(member.accountId, member.autoAccount)}
          </span>
          {member.availability !== "available" && (
            <span className={member.availability === "unknown" ? "text-gray-400 dark:text-white/35" : "text-amber-700 dark:text-amber-300"}>
              {t(`squads.availability.${member.availability}`)}{member.unavailableReason ? ` · ${member.unavailableReason}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function useRosterForLabels() {
  const [agents, setAgents] = useState<Roster["agents"]>([]);
  useEffect(() => { getRoster().then((roster) => setAgents(roster.agents)).catch(() => setAgents([])); }, []);
  return { agents };
}

const LABEL = "mb-1.5 text-[12px] leading-4 text-gray-500 dark:text-white/60";

/** Rótulo pequeno (12px, cinza) e o controle embaixo, como nos sheets das pranchetas. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col">
      <span className={`${LABEL} flex items-baseline gap-2`}>
        <span>{label}</span>
        {hint && <span className="text-[11px] text-gray-400 dark:text-white/30">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * Uma linha da lista agrupada "Configuração": o rótulo (e a dica por baixo) à esquerda e o controle
 * à direita, separadas por um fio que começa depois da margem. `stacked` põe o controle embaixo, na
 * largura toda, para os que são largos demais para ficar ao lado (provedor, modelo, conta, squad).
 */
function Row({ label, hint, stacked = false, children }: { label: string; hint?: string; stacked?: boolean; children: React.ReactNode }) {
  const title = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[13.5px] leading-[19px] text-gray-900 dark:text-[#f5f5f7]">{label}</span>
      {hint && <span className="text-[11.5px] leading-4 text-gray-500 dark:text-white/50">{hint}</span>}
    </span>
  );
  return (
    <div role="group" aria-label={label}
      className="relative min-h-11 px-3.5 py-2 before:absolute before:left-3.5 before:right-0 before:top-0 before:h-px before:bg-black/[0.08] first:before:hidden dark:before:bg-[rgba(84,84,88,0.55)]">
      {stacked ? (
        <div className="flex flex-col gap-2 py-1">{title}{children}</div>
      ) : (
        <div className="flex items-center justify-between gap-3">{title}{children}</div>
      )}
    </div>
  );
}

/** O campo de texto das pranchetas: 30px, fundo cinza, raio 7, anel de acento ao focar. */
const FIELD = `block h-[30px] w-full rounded-[7px] bg-black/[0.05] px-2.5 text-[13px] text-gray-900 outline-none
  placeholder:text-gray-400 focus:ring-[3px] focus:ring-accent-500/30 dark:bg-surface-raised dark:text-[#f5f5f7] dark:placeholder:text-white/30`;

const SELECT = "w-full";
