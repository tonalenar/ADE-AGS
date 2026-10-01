import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Alert, AnimateSpin, Button, FolderIcon, Input, SegmentedControl, TextArea } from "neogestify-ui-components";

import { ModelSelector } from "@/features/runs/ModelSelector";
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
        <div className="flex items-center gap-2 px-4 h-12">
          <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/35">
            {t("missions.form.draftHint")}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={save}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {editing ? t("missions.form.save") : t("missions.form.create")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label={t("missions.form.name")}>
          <Input size="sm" value={form.title} onChange={(e) => set("title", e.target.value)} autoFocus className={INPUT} />
        </Field>

        <Field label={t("missions.form.objective")} hint={t("missions.form.objectiveHint")}>
          <TextArea
            size="sm"
            resize="none"
            rows={5}
            value={form.objective}
            onChange={(e) => set("objective", e.target.value)}
            placeholder={t("fleet.orchestrate.objectivePlaceholder")}
            className="w-full resize-none rounded-lg px-2.5 py-2 outline-none
              bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10
              focus:border-blue-400 dark:focus:border-blue-500
              text-[12px] leading-relaxed text-gray-800 dark:text-gray-200"
          />
        </Field>

        <Field group label={t("missions.form.project")}>
          <div className="flex items-center gap-1.5">
            <Input
              size="sm"
              value={form.cwd}
              onChange={(e) => set("cwd", e.target.value)}
              aria-label={t("missions.form.project")}
              className={`${INPUT} font-mono`}
            />
            <Button variant="icon" onClick={pickFolder} aria-label={t("missions.form.pickFolder")} className="w-8 h-8 p-0 shrink-0">
              <FolderIcon className="w-3.5 h-3.5" />
            </Button>
          </div>
        </Field>

        <Field group label={t("missions.form.executionMode")}>
          <SegmentedControl
            size="sm"
            aria-label={t("missions.form.executionMode")}
            value={form.executionMode}
            onChange={(value) => {
              const executionMode = value as MissionForm["executionMode"];
              setForm((current) => switchExecutionMode(current, executionMode));
            }}
            options={[
              { value: "automatic", label: t("missions.form.automatic") },
              { value: "specific", label: t("missions.form.specific") },
              { value: "squad", label: t("missions.form.squad") },
            ]}
          />
        </Field>

        {form.executionMode === "automatic" && (
          <Field group label={t("fleet.orchestrate.leadModel")} hint={t("fleet.new.modelHint")}>
            <SegmentedControl
              size="sm"
              aria-label={t("fleet.orchestrate.leadModel")}
              value={form.mode === "fixed" ? "hard" : form.mode}
              onChange={(value) => set("mode", value as ModelMode)}
              options={COMPLEXITIES.map((complexity) => ({ value: complexity, label: t(`fleet.complexity.${complexity}`) }))}
            />
          </Field>
        )}

        {form.executionMode === "specific" && (
          <Field group label={t("missions.form.leadProviderModel")}>
            <select className={SELECT} aria-label={t("squads.form.provider")} value={form.agentId}
              onChange={(event) => setForm((current) => ({ ...current, agentId: event.target.value, model: null, reasoningEffort: null, mode: "fixed", accountId: null, autoAccount: true }))}>
              {!agents.some((agent) => agent.agentId === form.agentId) && <option value={form.agentId}>{form.agentId} ? {t("squads.unavailable")}</option>}
              {agents.map((agent) => <option key={agent.agentId} value={agent.agentId} disabled={providerDisabled(agent, true)}>{agent.label}{leadUnsupported(agent) ? " · " + t("squads.leadUnsupported") : ""}</option>)}
            </select>
            {leadUnsupported(agents.find((agent) => agent.agentId === form.agentId)) && <Alert variant="warning">{t("squads.leadUnsupported")}</Alert>}
            <ModelSelector roster={roster} onRoster={setRoster} agentId={form.agentId} accountId={form.accountId} autoAccount={form.autoAccount}
              reasoningEffort={form.reasoningEffort}
              model={form.mode === "fixed" ? form.model : null} complexity={form.mode === "fixed" ? null : form.mode}
              onChange={(patch) => setForm((current) => ({ ...current, model: patch.model, reasoningEffort: patch.reasoningEffort ?? null, mode: patch.complexity ?? "fixed" }))} />
          </Field>
        )}

        {form.executionMode === "squad" && (
          <Field label={t("missions.form.squad")} hint={t("missions.form.squadHint")}>
            <select
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
            </select>
            {selectedSquad && <SquadExecutionSummary squad={selectedSquad} />}
            {selectedSquad && !selectedSquad.available && (
              <Alert variant="warning">{selectedSquad.unavailableReasons.join("; ")}</Alert>
            )}
            {squads.length === 0 && (
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-gray-500 dark:text-white/40">
                <span>{t("missions.form.noSquads")}</span>
                <Button variant="ghost" size="sm" onClick={() => navigate("/squads")}>{t("squads.manage")}</Button>
              </div>
            )}
          </Field>
        )}

        {form.executionMode === "specific" && (
          <Field group label={t("fleet.new.account")}>
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
          </Field>
        )}

        <div className="flex items-start gap-4">
          <Field group label={t("fleet.orchestrate.parallel")} hint={t("fleet.orchestrate.parallelHint")}>
            <SegmentedControl
              size="sm"
              aria-label={t("fleet.orchestrate.parallel")}
              value={String(form.maxParallel)}
              onChange={(v) => set("maxParallel", Number(v))}
              options={PARALLEL.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </Field>
          <div className="w-32">
            <Field label={t("fleet.orchestrate.budget")} hint={t("fleet.new.budgetHint")}>
              <Input
                size="sm"
                value={form.budget}
                onChange={(e) => set("budget", e.target.value)}
                inputMode="decimal"
                placeholder="1.00"
                className={INPUT}
              />
            </Field>
          </div>
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

function Field({ label, hint, group = false, children }: {
  label: string;
  hint?: string;
  /** Un grupo de botones y no un campo: dentro de un `<label>`, un click en el título se
   *  reenviaría al primer botón. */
  group?: boolean;
  children: React.ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="flex flex-col gap-1.5" {...(group ? { role: "group", "aria-label": label } : {})}>
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">{label}</span>
        {hint && <span className="text-[10px] text-gray-400 dark:text-white/30">{hint}</span>}
      </span>
      {children}
    </Tag>
  );
}

const INPUT = `w-full rounded-lg px-2.5 h-8 outline-none text-[12px]
  bg-gray-100 dark:bg-white/5
  border border-gray-200 dark:border-white/10
  focus:border-blue-400 dark:focus:border-blue-500
  text-gray-800 dark:text-gray-200`;

const SELECT = `w-full rounded-lg px-2.5 h-8 outline-none text-[12px]
  bg-gray-100 dark:bg-[#12161c] border border-gray-200 dark:border-white/10
  focus:border-blue-400 dark:focus:border-blue-500 text-gray-800 dark:text-gray-200`;
