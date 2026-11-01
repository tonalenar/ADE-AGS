import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

/**
 * A confirmação de trocar o agente da conversa (a cada troca): para quem, o que o agente novo recebe (um resumo,
 * como dado) e o que se perde (o que só o antigo guardava por dentro). Nada muda antes de confirmar.
 */
export function AgentSwitchDialog({ from, to, busy, error, onConfirm, onClose }: {
  from: string;
  to: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog title={t("chat.agentSwitch.title", { agent: to })} size="md" onClose={busy ? () => undefined : onClose} closeOnEsc
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{busy ? t("chat.agentSwitch.busy") : t("chat.agentSwitch.confirm", { agent: to })}</Button>
        </>
      )}>
      <div className="flex flex-col gap-3 text-chat-ui text-gray-800 dark:text-white/85">
        <p className="m-0">{t("chat.agentSwitch.body", { agent: to })}</p>
        <p className="m-0 text-gray-600 dark:text-white/60">{t("chat.agentSwitch.loss", { from })}</p>
        {error && <p role="alert" className="m-0 text-red-700 dark:text-red-400">{t("chat.agentSwitch.failed", { error })}</p>}
      </div>
    </AppDialog>
  );
}
