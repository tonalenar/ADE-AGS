import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Button, Input, TextArea } from "neogestify-ui-components";

import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { AccountPickerStep, AUTO_ACCOUNT } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { addSquadRole, availableSquadRoles, EMPTY_SQUAD_INPUT, removeSquadRole, subagentDefaultIsReady } from "./squadForm";
import { FastSwitch } from "./FastSwitch";
import { SubagentDefaultSection } from "./SubagentDefaultSection";
import { modelSelectionMode, modelsForAccount, withModelEffort } from "./modelSelection";
import { ModelSelector } from "@/features/runs/ModelSelector";
import { leadUnsupported, providerDisabled } from "@/features/runs/leadProviders";
import type { FunctionalRole, Squad, SquadInput, SquadMemberInput } from "./types";

export { inputFromSquad } from "./squadForm";

export function SquadDialog({ initial = EMPTY_SQUAD_INPUT, roles, editing, squad, onClose, onSave }: {
  initial?: SquadInput;
  roles: FunctionalRole[];
  editing: boolean;
  squad?: Squad;
  onClose: () => void;
  onSave: (input: SquadInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<SquadInput>(initial);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Falhar ao carregar os provedores não pode parecer "nenhum provedor": mostra o erro e deixa tentar de novo.
  const [rosterError, setRosterError] = useState("");
  const loadRoster = () => {
    setRosterError("");
    getRoster().then(setRoster).catch((e) => { setRoster(null); setRosterError(String(e)); });
  };
  useEffect(() => { loadRoster(); }, []);

  const remainingRoles = useMemo(() => availableSquadRoles(roles, form.members), [roles, form.members]);
  // Funções recolhidas: com 3–4 funções abertas o modal virava uma parede. Ao editar começam
  // recolhidas (o cabeçalho resume provedor e modelo); uma função recém-adicionada abre.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(editing ? initial.members.map((m) => m.roleId) : []));
  const toggle = (roleId: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
    return next;
  });
  const providerLabel = (agentId: string) => roster?.agents.find((a) => a.agentId === agentId)?.label ?? agentId;
  const canSaveAssignment = (assignment: { agentId: string; model: string | null; complexity: SquadMemberInput["complexity"] }) =>
    Boolean(assignment.agentId && (modelSelectionMode(assignment.model, assignment.complexity) !== "specific" || assignment.model?.trim()));
  // O Lead precisa do contrato de orquestração: um provedor sem ele não pode liderar missão, e o
  // backend o marcaria como indisponível depois. Não se deixa salvar.
  const leadAgent = roster?.agents.find((agent) => agent.agentId === form.lead.agentId);
  const ready = Boolean(form.name.trim() && canSaveAssignment(form.lead) && form.members.every(canSaveAssignment)
    && subagentDefaultIsReady(form.defaultSubagent) && !leadUnsupported(leadAgent));

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
        defaultSubagent: form.defaultSubagent
          ? { ...form.defaultSubagent, model: form.defaultSubagent.model?.trim() || null }
          : null,
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
        <div className="flex items-center gap-2 px-5 h-14">
          <span className="flex-1 text-[11.5px] leading-[15px] text-gray-500 dark:text-gray-400">{t("squads.form.roleIsWork")}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" size="sm" disabled={!ready || busy} onClick={save}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}>
            {editing ? t("squads.form.save") : t("squads.form.create")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 rounded-xl bg-black/[0.025] dark:bg-white/[0.035] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06)] p-4">
          <Field label={t("squads.form.name")}>
            <Input size="sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className={INPUT} autoFocus />
          </Field>
          <Field label={t("squads.form.description")}>
            <TextArea size="sm" resize="none" rows={2} value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className={TEXTAREA} />
          </Field>
        </div>

        <section className="flex flex-col gap-3 rounded-xl bg-black/[0.025] dark:bg-white/[0.035] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06)] p-4 ring-1 ring-glow/25">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-glow/15 text-amber-600 dark:text-glow">
              <CrownIcon className="h-4 w-4" />
            </span>
            <h3 className="flex-1 text-[13.5px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-50">{t("squads.lead")}</h3>
            {form.lead.agentId && <Summary provider={providerLabel(form.lead.agentId)} model={form.lead.model} />}
          </div>
          <AgentConfig
            roster={roster}
            lead
            onRoster={setRoster}
            agentId={form.lead.agentId}
            model={form.lead.model}
            reasoningEffort={form.lead.reasoningEffort}
            fastMode={form.lead.fastMode}
            accountId={form.lead.accountId}
            autoAccount={form.lead.autoAccount}
            complexity={form.lead.complexity}
            availability={squad?.lead.availability}
            unavailableReason={squad?.lead.unavailableReason}
            onChange={(patch) => setForm((current) => ({ ...current, lead: { ...current.lead, ...patch } }))}
          />
        </section>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-gray-400">
              {t("squads.teamRoles")} <span className="font-mono tabular-nums normal-case tracking-normal">· {form.members.length}</span>
            </h3>
            {remainingRoles.length > 0 && (
              <PopupSelect className="min-w-44" aria-label={t("squads.form.addRole")} value="" placeholder={`+ ${t("squads.form.addRole")}`}
                onChange={(event) => {
                  const roleId = event.target.value;
                  if (!roleId) return;
                  setForm((current) => addSquadRole(current, roleId));
                  setCollapsed((cur) => { const next = new Set(cur); next.delete(roleId); return next; });
                }}>
                <option value="" disabled>{t("squads.form.addRole")}</option>
                {remainingRoles.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
              </PopupSelect>
            )}
          </div>
          {form.members.length === 0 && (
            <p className="rounded-xl border border-dashed border-black/10 dark:border-white/10 px-4 py-5 text-center text-[12px] text-gray-400 dark:text-gray-500">{t("squads.form.noRoles")}</p>
          )}
          {form.members.map((member) => {
            const role = roles.find((entry) => entry.id === member.roleId);
            const open = !collapsed.has(member.roleId);
            return (
              <div key={member.roleId} className="flex flex-col gap-3 rounded-xl bg-white dark:bg-surface-raised/50 shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.07)] px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <button type="button" onClick={() => toggle(member.roleId)} aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
                    <span className="min-w-0">
                      <span title={role?.label ?? member.roleId} className="block truncate text-[13px] font-semibold text-gray-900 dark:text-gray-50">{role?.label ?? member.roleId}</span>
                      {open && role?.description && <span className="mt-0.5 block text-[11.5px] leading-[15px] text-gray-500 dark:text-gray-400">{role.description}</span>}
                    </span>
                  </button>
                  {member.agentId && <Summary provider={providerLabel(member.agentId)} model={member.model} />}
                  <button type="button" onClick={() => setForm((current) => removeSquadRole(current, member.roleId))}
                    title={t("squads.form.removeRole")} aria-label={t("squads.form.removeRole")}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-500/10 hover:text-red-500">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.5h6V7" /></svg>
                  </button>
                </div>
                {open && <AgentConfig
                  roster={roster}
                  onRoster={setRoster}
                  agentId={member.agentId}
                  model={member.model}
                  reasoningEffort={member.reasoningEffort}
                  fastMode={member.fastMode}
                  accountId={member.accountId}
                  autoAccount={member.autoAccount}
                  complexity={member.complexity}
                  isolateDefault={member.isolateDefault}
                  availability={squad?.members.find((saved) => saved.roleId === member.roleId)?.availability}
                  unavailableReason={squad?.members.find((saved) => saved.roleId === member.roleId)?.unavailableReason}
                  onChange={(patch) => setForm((current) => ({
                    ...current,
                    members: current.members.map((entry) => entry.roleId === member.roleId ? { ...entry, ...patch } : entry),
                  }))}
                />}
              </div>
            );
          })}
        </section>
        <SubagentDefaultSection roster={roster} onRoster={setRoster} value={form.defaultSubagent}
          onChange={(defaultSubagent) => setForm((current) => ({ ...current, defaultSubagent }))} />
        {rosterError && (
          <Alert variant="danger">
            {rosterError} <button type="button" onClick={loadRoster} className="underline">{t("missions.action.retry")}</button>
          </Alert>
        )}
        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}

type AgentPatch = Partial<Omit<SquadMemberInput, "roleId">>;

function AgentConfig({ roster, onRoster, agentId, model, reasoningEffort, fastMode, accountId, autoAccount, complexity, isolateDefault, availability, unavailableReason, onChange, lead = false }: {
  lead?: boolean;
  roster: Roster | null;
  onRoster: (roster: Roster) => void;
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  accountId: string | null;
  autoAccount: boolean;
  complexity: SquadMemberInput["complexity"];
  isolateDefault?: boolean;
  availability?: Squad["lead"]["availability"];
  unavailableReason?: string | null;
  onChange: (patch: AgentPatch) => void;
}) {
  const { t } = useTranslation();
  const selectedAgent = roster?.agents.find((agent) => agent.agentId === agentId);
  const accountValue = autoAccount ? AUTO_ACCOUNT : (accountId ?? undefined);
  return (
    <div className="grid grid-cols-1 gap-y-3.5 pt-1">
      <Field label={t("squads.form.provider")}>
        <PopupSelect className={SELECT} value={agentId} onChange={(event) => onChange({ agentId: event.target.value, model: null, reasoningEffort: null, fastMode: false, accountId: null, autoAccount: true })}>
          <option value="">{t("squads.form.chooseProvider")}</option>
          {agentId && (!roster || !roster.agents.some((agent) => agent.agentId === agentId)) && (
            <option value={agentId}>{agentId} · {t("squads.unavailable")}</option>
          )}
          {roster?.agents.filter((agent) => lead || agent.capabilities.headless).map((agent) => (
            <option key={agent.agentId} value={agent.agentId} disabled={providerDisabled(agent, lead)}>
              {agent.label}
            </option>
          ))}
        </PopupSelect>
        {lead && leadUnsupported(selectedAgent) && <span role="alert" className="text-[10px] text-amber-700 dark:text-amber-300">{t("squads.leadUnsupported")}</span>}
        {selectedAgent && !selectedAgent.launchable && (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">{selectedAgent.unavailable ?? t("squads.unavailable")}</span>
        )}
      </Field>
      <ModelSelector roster={roster} agentId={agentId} accountId={accountId} autoAccount={autoAccount}
        model={model} reasoningEffort={reasoningEffort} complexity={complexity} onChange={onChange} onRoster={onRoster} />
      {agentId === "codex" && (
        <FastSwitch checked={fastMode === true} model={model} catalog={modelsForAccount(selectedAgent, accountId, autoAccount)}
          onChange={(fast) => onChange({ fastMode: fast })} />
      )}
      <Field group label={t("squads.form.account")}>
        {agentId ? (
          <AccountPickerStep agentId={agentId} value={accountValue}
            onChange={(value) => {
              const nextAuto = value === AUTO_ACCOUNT;
              const nextAccount = nextAuto ? null : (value ?? null);
              onChange({ autoAccount: nextAuto, accountId: nextAccount,
                reasoningEffort: withModelEffort({ model, complexity }, reasoningEffort ?? null,
                  modelsForAccount(selectedAgent, nextAccount, nextAuto)).reasoningEffort });
            }}
            showLabel={false} allowAuto preserveUnavailableValue />
        ) : <span className="text-[10px] text-gray-400 dark:text-white/35">{t("squads.form.chooseProvider")}</span>}
      </Field>
      {isolateDefault !== undefined && (
        <label className="flex items-center gap-2 text-[12px] text-gray-600 dark:text-gray-300">
          <input type="checkbox" className="h-4 w-4 rounded accent-[var(--color-accent-500)]" checked={isolateDefault} onChange={(event) => onChange({ isolateDefault: event.target.checked })} />
          {t("squads.form.isolateDefault")}
        </label>
      )}
      {availability && availability !== "available" && (
        <p className={`text-[10px] ${availability === "unknown" ? "text-gray-400 dark:text-white/35" : "text-amber-700 dark:text-amber-300"}`}>
          {t(`squads.availability.${availability}`)}{unavailableReason ? ` · ${unavailableReason}` : ""}
        </p>
      )}
    </div>
  );
}

function Field({ label, hint, group = false, children }: { label: string; hint?: string; group?: boolean; children: React.ReactNode }) {
  const Tag = group ? "div" : "label";
  return <Tag className="flex flex-col gap-1.5" {...(group ? { role: "group", "aria-label": label } : {})}>
    <span className="flex items-baseline gap-2 text-[12px] font-medium text-gray-600 dark:text-gray-300">
      {label}{hint && <span className="font-normal text-gray-400 dark:text-gray-500">{hint}</span>}
    </span>
    {children}
  </Tag>;
}

const INPUT = `w-full rounded-md px-3 h-[30px] outline-none text-[13px] bg-white dark:bg-surface-raised
  shadow-[0_0_0_0.5px_rgba(0,0,0,0.16)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.12)] border border-transparent
  focus:border-accent-500 focus:ring-[3px] focus:ring-accent-500/25 text-gray-900 dark:text-gray-100`;
const SELECT = "w-full";
const TEXTAREA = `w-full rounded-md px-3 py-2 outline-none text-[13px] leading-[18px] bg-white dark:bg-surface-raised
  shadow-[0_0_0_0.5px_rgba(0,0,0,0.16)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.12)] border border-transparent
  focus:border-accent-500 focus:ring-[3px] focus:ring-accent-500/25 text-gray-900 dark:text-gray-100`;

/** O resumo no cabeçalho de um agente recolhido: provedor e modelo (mono). */
function Summary({ provider, model }: { provider: string; model: string | null }) {
  return (
    <span className="hidden sm:flex shrink-0 items-center gap-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2.5 h-6 text-[11.5px] text-gray-600 dark:text-gray-300">
      <span title={provider} className="max-w-28 truncate">{provider}</span>
      {model && <><span className="text-gray-400">·</span><span title={model} className="max-w-40 truncate font-mono text-[11px]">{model}</span></>}
    </span>
  );
}

function CrownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5L3 7.5Z" />
    </svg>
  );
}
