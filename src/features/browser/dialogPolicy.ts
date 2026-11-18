/**
 * A pergunta à pessoa sobre o que um agente faz numa página (AGENTS.md §2.3: ações destrutivas são do usuário).
 *
 * O runtime da página rejeita sozinho um `alert`, `confirm` ou `prompt` disparado com o agente dirigindo
 * (é síncrono: a página não pode esperar a app). Esta pergunta sai para a app, no `AppConfirmHost`. Se a
 * pessoa permitir um `confirm`, a app manda o `allow` ao runtime, que o aceita uma vez na próxima repetição.
 */
import i18n from "@/i18n";
import { appConfirm } from "@/shared/ui/appConfirm";

import type { DialogAsk } from "./protocol";

/** Mostra à pessoa um diálogo que o agente disparou. `allow` leva a permissão de volta ao runtime (`dialogs allow`). */
export async function askPersonAboutDialog(ask: DialogAsk, allow: (key: string) => unknown): Promise<void> {
  if (ask.kind === "confirm") {
    const permitted = await appConfirm({
      title: i18n.t("browser.agentDialog.title"),
      lead: i18n.t("browser.agentDialog.confirmLead", { message: ask.message }),
      note: i18n.t("browser.agentDialog.confirmNote"),
      confirmLabel: i18n.t("browser.agentDialog.allow"),
      cancelLabel: i18n.t("browser.agentDialog.refuse"),
      tone: "warning",
    });
    if (permitted) await allow(ask.key);
    return;
  }
  // Um aviso ou um pedido de texto: a pessoa só fica sabendo. Nada se aceita em seu nome.
  await appConfirm({
    title: i18n.t("browser.agentDialog.title"),
    lead: i18n.t(ask.kind === "alert" ? "browser.agentDialog.alertLead" : "browser.agentDialog.promptLead", { message: ask.message }),
    note: i18n.t("browser.agentDialog.infoNote"),
    confirmLabel: i18n.t("browser.agentDialog.ok"),
    cancelLabel: i18n.t("btn.close"),
    tone: "warning",
  });
}

/**
 * Conta à pessoa que um reset falhou em parte. Só informa: não espera resposta, para o agente não ficar preso
 * num aviso que ninguém leu. O agente recebe o mesmo texto no resultado.
 */
export function tellPersonAboutResetFailure(detail: string): Promise<boolean> {
  return appConfirm({
    title: i18n.t("browser.agentReset.title"),
    lead: i18n.t("browser.agentReset.failed", { detail }),
    note: i18n.t("browser.agentDialog.infoNote"),
    confirmLabel: i18n.t("browser.agentDialog.ok"),
    cancelLabel: i18n.t("btn.close"),
    tone: "danger",
  });
}

/** Pede à pessoa que confirme o reset da sessão de um site. `false` = nada é apagado. */
export function askPersonAboutReset(target: string | null): Promise<boolean> {
  return appConfirm({
    title: i18n.t("browser.agentReset.title"),
    lead: i18n.t("browser.agentReset.lead", { target: target ?? i18n.t("browser.agentReset.targetUnknown") }),
    note: i18n.t("browser.agentReset.note"),
    confirmLabel: i18n.t("browser.agentReset.confirm"),
    cancelLabel: i18n.t("btn.cancel"),
    tone: "danger",
  });
}
