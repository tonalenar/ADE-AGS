import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "neogestify-ui-components";

import { getRoster } from "@/features/runs/ipc";
import type { Roster } from "@/features/runs/types";
import { isWorking } from "@/features/missions/stalled";
import { FastSwitch } from "@/features/squads/FastSwitch";
import { useSquadAccountLabel } from "@/features/squads/accountLabel";
import { modelsForAccount, reasoningOptions } from "@/features/squads/modelSelection";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";
import { screenOf } from "@/features/terminal/terminalRegistry";
import { AppDialog } from "@/shared/ui/AppDialog";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { choiceFromLabel, loadCanvasRoles, type AgentRoleChoice, type CanvasRole } from "./agentRole";
import { RolePicker } from "./RolePicker";
import { DEFAULT_EFFORTS, readTuning, retune, tuningChanged } from "./tabTuning";

/**
 * Edita o que um terminal já aberto é: função (ou nenhuma, o orquestrador decide) e subagente; mostra a conta em uso e
 * deixa mudar o esforço e, no Codex, o modo Fast. Esforço e Fast ficam no comando do agente: mudar reinicia o agente
 * e retoma a mesma conversa.
 */
export function RoleEditDialog({ name, label, subagent, tab, tunable = true, onClose, onSave }: {
  name: string;
  /** O rótulo da função que está no canvas, se houver. */
  label?: string;
  subagent: boolean;
  tab: Tab;
  tunable?: boolean;
  onClose: () => void;
  onSave: (choice: AgentRoleChoice) => void;
}) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<CanvasRole[] | null>(null);
  const [choice, setChoice] = useState<AgentRoleChoice>({ roleId: null, subagent });
  const accountLabel = useSquadAccountLabel();
  const isAgent = tunable && tab.agentId !== SHELL_AGENT_ID;
  const before = useMemo(() => readTuning(tab.agentId, tab.command), [tab.agentId, tab.command]);
  const [effort, setEffort] = useState<string | null>(before.effort);
  const [fast, setFast] = useState(before.fast);
  const [roster, setRoster] = useState<Roster | null>(null);

  useEffect(() => {
    let alive = true;
    void loadCanvasRoles().then((all) => {
      if (!alive) return;
      setRoles(all);
      // O rótulo guardado vira a escolha correspondente do catálogo.
      setChoice(choiceFromLabel(all, label, subagent));
    });
    return () => { alive = false; };
  }, [label, subagent]);
  useEffect(() => {
    if (!isAgent) return;
    let alive = true;
    getRoster().then((r) => { if (alive) setRoster(r); }).catch(() => {});
    return () => { alive = false; };
  }, [isAgent]);

  const catalog = useMemo(
    () => modelsForAccount(roster?.agents.find((a) => a.agentId === tab.agentId), tab.accountId ?? null, !tab.accountId),
    [roster, tab.agentId, tab.accountId],
  );
  const efforts = useMemo(() => {
    const known = reasoningOptions(before.model, catalog);
    const base = known.length > 0 ? known : DEFAULT_EFFORTS;
    return effort && !base.includes(effort) ? [...base, effort] : base;
  }, [before.model, catalog, effort]);

  const save = async () => {
    if (isAgent && tuningChanged(before, effort, fast)) {
      // Reiniciar no meio de um turno o interrompe: pergunta antes.
      if (isWorking(screenOf(tab.id)?.lines ?? [])) {
        const ok = await ask(t("role.restartConfirm", { name }), { title: t("role.editTitle"), kind: "warning" });
        if (!ok) return;
      }
      const { updateTab, restartAgent } = useTabsStore.getState();
      updateTab(tab.id, { command: retune(tab.agentId, tab.command, { effort, fast: tab.agentId === "codex" && fast }) });
      restartAgent(tab.id);
    }
    onSave(choice);
    onClose();
  };

  return (
    <AppDialog
      title={`${t("role.editTitle")} — ${name}`}
      size="md"
      closeOnEsc
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={roles === null} onClick={() => void save()}>{t("role.save")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("role.stepHint")}</p>
          <RolePicker value={choice} onChange={setChoice} />
        </div>
        {isAgent && (
          <div className="flex flex-col gap-3 border-t border-black/[0.08] pt-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-gray-600 dark:text-gray-300">{t("role.account")}</span>
              <span className="min-w-0 truncate rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[12px] text-gray-700 dark:bg-white/[0.07] dark:text-gray-200" title={accountLabel(tab.accountId ?? null, false)}>
                {tab.agentLabel} · {accountLabel(tab.accountId ?? null, false)}
              </span>
            </div>
            <label className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-gray-600 dark:text-gray-300">{t("models.effort")}</span>
              <PopupSelect className="min-w-44" aria-label={t("models.effort")} value={effort ?? ""} onChange={(event) => setEffort(event.target.value || null)}>
                <option value="">{t("models.effort.auto")}</option>
                {efforts.map((level) => <option key={level} value={level}>{t(`models.effort.${level}`, { defaultValue: level })}</option>)}
              </PopupSelect>
            </label>
            {tab.agentId === "codex" && <FastSwitch checked={fast} model={before.model} catalog={catalog} onChange={setFast} />}
            <p className="text-[11px] leading-[14px] text-gray-500 dark:text-white/50">{t("role.tuningHint")}</p>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
