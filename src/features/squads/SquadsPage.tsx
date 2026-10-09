import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Alert, Button, EmptyState, LocationIcon } from "neogestify-ui-components";

import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";

import { inputFromSquad, SquadDialog } from "./SquadDialog";
import { useSquadAccountLabel } from "./accountLabel";
import { useSquadsStore } from "./store";
import { assignmentIsUnavailable } from "./types";
import type { Squad } from "./types";

const SQUAD_CHANGED = "cc-squad-changed";

export function SquadsPage() {
  const { t } = useTranslation();
  const squads = useSquadsStore((state) => state.squads);
  const roles = useSquadsStore((state) => state.roles);
  const load = useSquadsStore((state) => state.load);
  const loadRoles = useSquadsStore((state) => state.loadRoles);
  const create = useSquadsStore((state) => state.create);
  const update = useSquadsStore((state) => state.update);
  const remove = useSquadsStore((state) => state.remove);
  const accountLabel = useSquadAccountLabel();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [error, setError] = useState("");
  const selected = squads.find((squad) => squad.id === selectedId) ?? null;

  useEffect(() => {
    load().catch((cause) => setError(String(cause)));
    loadRoles().catch((cause) => setError(String(cause)));
    getRoster().then(setRoster).catch(() => setRoster(null));
  }, [load, loadRoles]);

  useEffect(() => {
    const off = listen<{ squad_id: string }>(SQUAD_CHANGED, () => { load().catch(console.error); });
    return () => { off.then((unlisten) => unlisten()).catch(() => {}); };
  }, [load]);

  useEffect(() => {
    if (selectedId && !squads.some((squad) => squad.id === selectedId)) setSelectedId(null);
  }, [selectedId, squads]);

  const agentLabel = useMemo(() => (id: string) => roster?.agents.find((agent) => agent.agentId === id)?.label ?? id, [roster]);
  const save = async (input: Parameters<typeof create>[0]) => {
    if (dialog === "edit" && selected) {
      await update(selected.id, input);
    } else {
      const squad = await create(input);
      setSelectedId(squad.id);
    }
  };

  const deleteSelected = async () => {
    if (!selected || !window.confirm(t("squads.deleteConfirm", { name: selected.name }))) return;
    setError("");
    try {
      await remove(selected.id);
      setSelectedId(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-white dark:bg-surface-sunken">
      <div className="flex items-center gap-3 pl-4 pr-14 h-[52px] shrink-0 border-b border-black/[0.08] dark:border-white/[0.08]">
        <span className="flex-1 text-[13.5px] font-bold text-gray-900 dark:text-white">{t("squads.title")}</span>
        <span className="text-[10.5px] text-gray-400 dark:text-white/35">{t("squads.roleIsWork")}</span>
        <Button variant="primary" size="sm" onClick={() => setDialog("create")}>{t("squads.new")}</Button>
      </div>

      {error && <div className="px-4 py-2 border-b border-red-200/60 dark:border-red-500/20"><Alert variant="danger">{error}</Alert></div>}

      <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0 cc-scroll border-r border-gray-200 dark:border-white/8">
          {squads.length === 0 ? (
            <EmptyState className="py-14 px-4" icon={<LocationIcon className="w-8 h-8" />}
              title={t("squads.empty.title")} description={t("squads.empty.description")} />
          ) : squads.map((squad) => (
            <Button key={squad.id} variant="custom" onClick={() => setSelectedId(squad.id)} aria-pressed={selectedId === squad.id}
              className={`cc-t w-full flex flex-col items-stretch gap-1 px-3 py-2.5 text-left rounded-none border-b border-gray-100 dark:border-white/5
                ${selectedId === squad.id ? "bg-accent-500/10" : "hover:bg-gray-100 dark:hover:bg-white/4"}`}>
              <span className="flex items-center gap-2">
                <span title={squad.name} className="flex-1 truncate text-[12px] font-medium text-gray-900 dark:text-gray-100">{squad.name}</span>
                {!squad.available && <span className="text-[9px] font-semibold text-amber-700 dark:text-amber-300">{t("squads.unavailable")}</span>}
              </span>
              <span className="text-[10px] text-gray-400 dark:text-white/35">
                {t("squads.roleCount", { count: squad.members.length })} · {agentLabel(squad.lead.agentId)}
              </span>
              {squad.members.some((member) => assignmentIsUnavailable(member.availability)) && (
                <span className="text-[9px] text-amber-700 dark:text-amber-300">
                  {t("squads.memberUnavailableCount", { count: squad.members.filter((member) => assignmentIsUnavailable(member.availability)).length })}
                </span>
              )}
            </Button>
          ))}
        </div>

        <div className="flex-1 min-w-0 cc-scroll">
          {selected ? (
            <SquadDetail squad={selected} agentLabel={agentLabel} accountLabel={accountLabel} onEdit={() => setDialog("edit")} onDelete={deleteSelected} />
          ) : (
            <p className="p-6 text-[12px] text-gray-400 dark:text-white/35">{t("squads.pick")}</p>
          )}
        </div>
      </div>

      {dialog && (
        <SquadDialog
          editing={dialog === "edit"}
          initial={dialog === "edit" && selected ? inputFromSquad(selected) : undefined}
          squad={dialog === "edit" ? selected ?? undefined : undefined}
          roles={roles}
          onClose={() => setDialog(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function SquadDetail({ squad, agentLabel, accountLabel, onEdit, onDelete }: {
  squad: Squad;
  agentLabel: (id: string) => string;
  accountLabel: (accountId: string | null, autoAccount: boolean) => string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const assignment = (agentId: string, model: string | null, accountId: string | null, autoAccount: boolean, availability: Squad["lead"]["availability"], reason: string | null, complexity: Squad["lead"]["complexity"] = null) => (
    <div className="text-[10.5px] text-gray-500 dark:text-white/45">
      {agentLabel(agentId)} · {model ?? (complexity ? t(`fleet.complexity.${complexity}`) : t("squads.providerDefault"))} · {accountLabel(accountId, autoAccount)}
      {availability !== "available" && (
        <div className={availability === "unknown" ? "text-gray-400 dark:text-white/35" : "text-amber-700 dark:text-amber-300"}>
          {t(`squads.availability.${availability}`)}{reason ? ` · ${reason}` : ""}
        </div>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 title={squad.name} className="truncate text-[15px] font-semibold text-gray-900 dark:text-white">{squad.name}</h2>
          {squad.description && <p className="mt-1 text-[11.5px] text-gray-500 dark:text-white/45">{squad.description}</p>}
        </div>
        {!squad.available && <span className="rounded px-2 py-1 text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300">{t("squads.unavailable")}</span>}
        <Button variant="ghost" size="sm" onClick={onEdit}>{t("squads.edit")}</Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>{t("squads.delete")}</Button>
      </div>
      {!squad.available && <Alert variant="warning">{squad.unavailableReasons.join("; ")}</Alert>}

      <section className="rounded-xl border border-violet-300/50 dark:border-violet-400/15 bg-violet-500/5 p-3">
        <h3 className="text-[11.5px] font-semibold text-gray-800 dark:text-gray-200">{t("squads.lead")}</h3>
        {assignment(squad.lead.agentId, squad.lead.model, squad.lead.accountId, squad.lead.autoAccount, squad.lead.availability, squad.lead.unavailableReason, squad.lead.complexity)}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[11.5px] font-semibold text-gray-800 dark:text-gray-200">{t("squads.teamRoles")}</h3>
        {squad.members.length === 0 && <p className="text-[10.5px] text-gray-400 dark:text-white/35">{t("squads.form.noRoles")}</p>}
        {squad.members.map((member) => (
          <article key={member.roleId} className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-white/10 p-3">
            <div className="flex-1 min-w-0">
              <h4 className="text-[11.5px] font-semibold text-gray-800 dark:text-gray-200">
                {t(`squads.roleNames.${member.roleId}`, { defaultValue: member.roleId })}
              </h4>
              {assignment(member.agentId, member.model, member.accountId, member.autoAccount, member.availability, member.unavailableReason, member.complexity)}
            </div>
          </article>
        ))}
      </section>
      <p className="text-[10px] text-gray-400 dark:text-white/30">{t("squads.providerRoutingHint")}</p>
    </div>
  );
}
