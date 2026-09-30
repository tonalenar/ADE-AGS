import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Button, Input, TextArea } from "neogestify-ui-components";

import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { AccountPickerStep, AUTO_ACCOUNT } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";

import type { FunctionalRole, Squad, SquadInput, SquadMemberInput } from "./types";

const EMPTY: SquadInput = {
  name: "",
  description: "",
  lead: { agentId: "", model: null, accountId: null, autoAccount: true, complexity: "hard" },
  members: [],
};

export function inputFromSquad(squad: Squad): SquadInput {
  return {
    name: squad.name,
    description: squad.description,
    lead: {
      agentId: squad.lead.agentId,
      model: squad.lead.model,
      accountId: squad.lead.accountId,
      autoAccount: squad.lead.autoAccount,
      complexity: squad.lead.complexity,
    },
    members: squad.members.map((member) => ({
      roleId: member.roleId,
      agentId: member.agentId,
      model: member.model,
      accountId: member.accountId,
      autoAccount: member.autoAccount,
      complexity: member.complexity,
      isolateDefault: member.isolateDefault,
    })),
  };
}

export function SquadDialog({ initial = EMPTY, roles, editing, onClose, onSave }: {
  initial?: SquadInput;
  roles: FunctionalRole[];
  editing: boolean;
  onClose: () => void;
  onSave: (input: SquadInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<SquadInput>(initial);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { getRoster().then(setRoster).catch(() => setRoster(null)); }, []);

  const remainingRoles = useMemo(
    () => roles.filter((role) => !form.members.some((member) => member.roleId === role.id)),
    [roles, form.members]
  );
  const ready = Boolean(form.name.trim() && form.lead.agentId && form.members.every((member) => member.agentId));

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
        lead: { ...form.lead, model: form.lead.model?.trim() || null },
        members: form.members.map((member) => ({ ...member, model: member.model?.trim() || null })),
      });
      onClose();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={editing ? t("squads.form.editTitle") : t("squads.form.createTitle")}
      size="lg"
      closeOnEsc
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2 px-4 h-12">
          <span className="flex-1 text-[10.5px] text-gray-400 dark:text-white/35">{t("squads.form.roleIsWork")}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" size="sm" disabled={!ready || busy} onClick={save}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}>
            {editing ? t("squads.form.save") : t("squads.form.create")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("squads.form.name")}>
          <Input size="sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className={INPUT} autoFocus />
        </Field>
        <Field label={t("squads.form.description")}>
          <TextArea size="sm" resize="none" rows={2} value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className={TEXTAREA} />
        </Field>

        <section className="flex flex-col gap-2 rounded-xl border border-violet-300/50 dark:border-violet-400/15 bg-violet-500/5 p-3">
          <h3 className="text-[12px] font-semibold text-gray-800 dark:text-gray-200">{t("squads.lead")}</h3>
          <AgentConfig
            roster={roster}
            agentId={form.lead.agentId}
            model={form.lead.model}
            accountId={form.lead.accountId}
            autoAccount={form.lead.autoAccount}
            complexity={form.lead.complexity}
            onChange={(patch) => setForm((current) => ({ ...current, lead: { ...current.lead, ...patch } }))}
          />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-[12px] font-semibold text-gray-800 dark:text-gray-200">{t("squads.teamRoles")}</h3>
            {remainingRoles.length > 0 && (
              <select className={SELECT} aria-label={t("squads.form.addRole")} value=""
                onChange={(event) => {
                  const roleId = event.target.value;
                  if (!roleId) return;
                  setForm((current) => ({
                    ...current,
                    members: [...current.members, memberDefault(roleId)],
                  }));
                }}>
                <option value="">{t("squads.form.addRole")}</option>
                {remainingRoles.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
              </select>
            )}
          </div>
          {form.members.length === 0 && (
            <p className="text-[10.5px] text-gray-400 dark:text-white/35">{t("squads.form.noRoles")}</p>
          )}
          {form.members.map((member) => {
            const role = roles.find((entry) => entry.id === member.roleId);
            return (
              <div key={member.roleId} className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-white/10 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <h4 className="text-[11.5px] font-semibold text-gray-800 dark:text-gray-200">{role?.label ?? member.roleId}</h4>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-gray-400 dark:text-white/35">{role?.description}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setForm((current) => ({
                    ...current, members: current.members.filter((entry) => entry.roleId !== member.roleId),
                  }))}>{t("squads.form.removeRole")}</Button>
                </div>
                <AgentConfig
                  roster={roster}
                  agentId={member.agentId}
                  model={member.model}
                  accountId={member.accountId}
                  autoAccount={member.autoAccount}
                  complexity={member.complexity}
                  isolateDefault={member.isolateDefault}
                  onChange={(patch) => setForm((current) => ({
                    ...current,
                    members: current.members.map((entry) => entry.roleId === member.roleId ? { ...entry, ...patch } : entry),
                  }))}
                />
              </div>
            );
          })}
        </section>
        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}

type AgentPatch = Partial<Omit<SquadMemberInput, "roleId">>;

function AgentConfig({ roster, agentId, model, accountId, autoAccount, complexity, isolateDefault, onChange }: {
  roster: Roster | null;
  agentId: string;
  model: string | null;
  accountId: string | null;
  autoAccount: boolean;
  complexity: SquadMemberInput["complexity"];
  isolateDefault?: boolean;
  onChange: (patch: AgentPatch) => void;
}) {
  const { t } = useTranslation();
  const selectedAgent = roster?.agents.find((agent) => agent.agentId === agentId);
  const modelList = `squad-models-${agentId || "none"}-${isolateDefault ? "member" : "lead"}`;
  const accountValue = autoAccount ? AUTO_ACCOUNT : (accountId ?? undefined);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      <Field label={t("squads.form.provider")}>
        <select className={SELECT} value={agentId} onChange={(event) => onChange({ agentId: event.target.value, model: null, accountId: null, autoAccount: true })}>
          <option value="">{t("squads.form.chooseProvider")}</option>
          {roster?.agents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.label}{agent.launchable ? "" : ` · ${t("squads.unavailable")}`}
            </option>
          ))}
        </select>
        {selectedAgent && !selectedAgent.launchable && (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">{selectedAgent.unavailable ?? t("squads.unavailable")}</span>
        )}
      </Field>
      <Field label={t("squads.form.model")} hint={t("squads.providerDefault")}>
        <Input size="sm" list={modelList} value={model ?? ""} onChange={(event) => onChange({ model: event.target.value || null })} className={INPUT} />
        <datalist id={modelList}>{selectedAgent?.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</datalist>
      </Field>
      <Field group label={t("squads.form.account")}>
        {agentId ? (
          <AccountPickerStep agentId={agentId} value={accountValue}
            onChange={(value) => onChange({ autoAccount: value === AUTO_ACCOUNT, accountId: value === AUTO_ACCOUNT ? null : (value ?? null) })}
            showLabel={false} allowAuto />
        ) : <span className="text-[10px] text-gray-400 dark:text-white/35">{t("squads.form.chooseProvider")}</span>}
      </Field>
      <Field label={t("squads.form.complexity")}>
        <select className={SELECT} value={complexity ?? ""} onChange={(event) => onChange({ complexity: (event.target.value || null) as SquadMemberInput["complexity"] })}>
          <option value="">{t("squads.form.providerDefault")}</option>
          {(["trivial", "standard", "hard"] as const).map((value) => <option key={value} value={value}>{t(`fleet.complexity.${value}`)}</option>)}
        </select>
      </Field>
      {isolateDefault !== undefined && (
        <label className="md:col-span-2 flex items-center gap-2 text-[10.5px] text-gray-600 dark:text-white/55">
          <input type="checkbox" checked={isolateDefault} onChange={(event) => onChange({ isolateDefault: event.target.checked })} />
          {t("squads.form.isolateDefault")}
        </label>
      )}
    </div>
  );
}

function memberDefault(roleId: string): SquadMemberInput {
  return { roleId, agentId: "", model: null, accountId: null, autoAccount: true, complexity: null, isolateDefault: true };
}

function Field({ label, hint, group = false, children }: { label: string; hint?: string; group?: boolean; children: React.ReactNode }) {
  const Tag = group ? "div" : "label";
  return <Tag className="flex flex-col gap-1.5" {...(group ? { role: "group", "aria-label": label } : {})}>
    <span className="flex items-baseline gap-2 text-[10.5px] font-semibold text-gray-600 dark:text-gray-300">
      {label}{hint && <span className="font-normal text-gray-400 dark:text-white/30">{hint}</span>}
    </span>
    {children}
  </Tag>;
}

const INPUT = `w-full rounded-lg px-2.5 h-8 outline-none text-[11.5px] bg-gray-100 dark:bg-white/5
  border border-gray-200 dark:border-white/10 focus:border-blue-400 dark:focus:border-blue-500 text-gray-800 dark:text-gray-200`;
const SELECT = `min-w-40 rounded-lg px-2.5 h-8 outline-none text-[11.5px] bg-gray-100 dark:bg-[#12161c]
  border border-gray-200 dark:border-white/10 focus:border-blue-400 dark:focus:border-blue-500 text-gray-800 dark:text-gray-200`;
const TEXTAREA = `w-full rounded-lg px-2.5 py-2 outline-none text-[11.5px] bg-gray-100 dark:bg-white/5
  border border-gray-200 dark:border-white/10 focus:border-blue-400 dark:focus:border-blue-500 text-gray-800 dark:text-gray-200`;
