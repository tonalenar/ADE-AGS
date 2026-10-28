/**
 * A confirmação ao trocar/fechar/excluir uma conversa com agentes ainda trabalhando.
 *
 * Fala só do que a pessoa precisa saber: QUEM está trabalhando (o nome do agente, sem pasta nem caminho),
 * que a conversa FICA SALVA para abrir quando quiser, e que o que está em andamento agora será interrompido.
 */
import i18n from "i18next";

import { appConfirm, type ConfirmRequest } from "@/shared/ui/appConfirm";

/** O que a pessoa pediu que obrigou a fechar os terminais. */
export type SwitchIntent = "open" | "new" | "save" | "delete";

/** Os agentes que trabalham, pelo nome, sem repetir: dois Claude Code viram "Claude Code ×2". Pura. */
export function workingLabels(tabs: { agentLabel: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(tab.agentLabel, (counts.get(tab.agentLabel) ?? 0) + 1);
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

type T = (key: string) => string;

/** O pedido de confirmação de cada situação. Pura (recebe o `t`). */
export function switchRequest(intent: SwitchIntent, labels: string[], t: T): ConfirmRequest {
  const k = (name: string) => t(`conversations.switch.${name}`);
  const lead = labels.length > 1 ? k("leadMany") : k("leadOne");
  if (intent === "delete") {
    return {
      title: k("title.delete"), lead, items: labels, note: k("note.delete"),
      confirmLabel: k("confirm.delete"), cancelLabel: k("cancel.delete"), tone: "danger",
    };
  }
  return {
    title: k(`title.${intent}`),
    lead,
    items: labels,
    note: k("note.save"),
    confirmLabel: k(`confirm.${intent}`),
    cancelLabel: k("cancel.stay"),
  };
}

/** Pergunta; `true` = pode salvar e fechar os terminais. */
export function confirmSwitchWork(tabs: { agentLabel: string }[], intent: SwitchIntent): Promise<boolean> {
  return appConfirm(switchRequest(intent, workingLabels(tabs), (key) => i18n.t(key)));
}
