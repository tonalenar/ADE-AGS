import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { choiceFromLabel, loadCanvasRoles, type AgentRoleChoice, type CanvasRole } from "./agentRole";
import { RolePicker } from "./RolePicker";

/** Edita o que um terminal já aberto é: função (ou nenhuma, o orquestrador decide) e subagente. */
export function RoleEditDialog({ name, label, subagent, onClose, onSave }: {
  name: string;
  /** O rótulo da função que está no canvas, se houver. */
  label?: string;
  subagent: boolean;
  onClose: () => void;
  onSave: (choice: AgentRoleChoice) => void;
}) {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<CanvasRole[] | null>(null);
  const [choice, setChoice] = useState<AgentRoleChoice>({ roleId: null, subagent });
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
  return (
    <AppDialog
      title={`${t("role.editTitle")} — ${name}`}
      size="md"
      closeOnEsc
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={roles === null} onClick={() => { onSave(choice); onClose(); }}>{t("role.save")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("role.stepHint")}</p>
        <RolePicker value={choice} onChange={setChoice} />
      </div>
    </AppDialog>
  );
}
