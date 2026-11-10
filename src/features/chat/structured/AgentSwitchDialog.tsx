import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

/**
 * A confirmação de trocar o agente da conversa (a cada troca): para quem, o que o agente novo recebe (um resumo,
 * como dado) e o que se perde (o que só o antigo guardava por dentro). Nada muda antes de confirmar.
 */
export function AgentSwitchDialog({ from, to, busy, error, noApproval = false, mode = "protocol", hasContext = true, onConfirm, onClose }: {
  from: string;
  to: string;
  busy: boolean;
  error: string | null;
  /** Conversa por protocolo troca no mesmo fio; TUI abre outra aba e mantém a sessão anterior. */
  mode?: "protocol" | "newTui";
  /** Só vale em `newTui`: algumas TUIs não expõem transcript estruturado para transferir. */
  hasContext?: boolean;
  /** O agente novo não pergunta e o acesso é Supervisionado: avisa que ele nega o que pediria aprovação. */
  noApproval?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const body = mode === "protocol"
    ? t("chat.agentSwitch.body", { agent: to })
    : t(hasContext ? "chat.agentSwitch.tuiBody" : "chat.agentSwitch.tuiNoContext", { agent: to });
  const loss = t(mode === "protocol" ? "chat.agentSwitch.loss" : "chat.agentSwitch.tuiLoss", { from });
  const confirm = mode === "newTui" ? "chat.agentSwitch.tuiConfirm" : "chat.agentSwitch.confirm";
  return (
    <AppDialog title={t("chat.agentSwitch.title", { agent: to })} size="md" onClose={busy ? () => undefined : onClose} closeOnEsc
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{busy ? t("chat.agentSwitch.busy") : t(confirm, { agent: to })}</Button>
        </>
      )}>
      <div className="flex flex-col gap-3 text-chat-ui text-gray-800 dark:text-white/85">
        <p className="m-0">{body}</p>
        <p className="m-0 text-gray-600 dark:text-white/60">{loss}</p>
        {noApproval && <p className="m-0 text-amber-700 dark:text-amber-400">{t("chat.agentSwitch.noApproval", { agent: to })}</p>}
        {error && <p role="alert" className="m-0 text-red-700 dark:text-red-400">{t("chat.agentSwitch.failed", { error })}</p>}
      </div>
    </AppDialog>
  );
}
