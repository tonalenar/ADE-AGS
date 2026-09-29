import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Alert, AnimateSpin, Button, FolderIcon, Input, SegmentedControl, TextArea } from "neogestify-ui-components";

import { ModelSearch } from "@/features/runs/ModelSearch";
import { getRoster } from "@/features/runs/ipc";
import { COMPLEXITIES, launchableAgents } from "@/features/runs/routingView";
import type { Roster } from "@/features/runs/types";
import { AccountPickerStep, AUTO_ACCOUNT } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";

import { missingFields, toInput, type MissionForm, type ModelMode } from "./missionView";
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
  const [form, setForm] = useState<MissionForm>(initial);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof MissionForm>(key: K, value: MissionForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Solo para ofrecer modelos. Crear el borrador no depende de que el roster conteste.
  useEffect(() => {
    getRoster().then(setRoster).catch(() => setRoster(null));
  }, []);

  const agents = launchableAgents(roster);
  const models = useMemo(
    () => (agents.find((a) => a.agentId === form.agentId)?.models ?? []).filter((m) => !m.unavailable && m.toolcall !== false),
    [agents, form.agentId]
  );

  const missing = missingFields(form);
  const canSave = missing.length === 0 && !busy;

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

        <Field group label={t("fleet.orchestrate.leadModel")} hint={form.mode === "fixed" ? undefined : t("fleet.new.modelHint")}>
          <div className="flex flex-col gap-2">
            <SegmentedControl
              size="sm"
              aria-label={t("fleet.orchestrate.leadModel")}
              value={form.mode}
              onChange={(v) => {
                const mode = v as ModelMode;
                setForm((f) => ({
                  ...f,
                  mode,
                  model: mode === "fixed" && !f.model ? (models.find((m) => m.id === "opus")?.id ?? models[0]?.id ?? "") : f.model,
                }));
              }}
              options={[
                ...COMPLEXITIES.map((c) => ({ value: c, label: t(`fleet.complexity.${c}`) })),
                { value: "fixed", label: t("fleet.new.fixedModel") },
              ]}
            />
            {form.mode === "fixed" && (
              <ModelSearch
                agents={agents}
                value={{ agentId: form.agentId, model: form.model }}
                onChange={(pick) => setForm((f) => ({
                  ...f,
                  agentId: pick.agentId,
                  model: pick.model,
                  // Otra TUI tiene otras cuentas: la elegida ya no aplica.
                  ...(pick.agentId !== f.agentId ? { autoAccount: true, accountId: null } : {}),
                }))}
              />
            )}
          </div>
        </Field>

        <Field group label={t("fleet.new.account")}>
          <AccountPickerStep
            agentId={form.agentId}
            value={accountValue}
            onChange={(v) => setForm((f) => ({
              ...f,
              autoAccount: v === AUTO_ACCOUNT,
              accountId: v === AUTO_ACCOUNT ? null : (v ?? null),
            }))}
            showLabel={false}
            allowAuto
          />
        </Field>

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
