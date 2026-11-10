import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import type { McpAppApprovalRequest } from "./mcpAppHandlers";

/**
 * A aprovação humana de um pedido do app MCP. É da ADE, fora do iframe: o app não desenha, não cobre nem
 * fecha este diálogo. Fechar (X, Esc) é negar, e o app recebe erro.
 *
 * O texto e os argumentos foram escritos pelo app: aparecem como dados, em bloco, nunca como texto da interface.
 */
export function McpAppApprovalDialog({ request, onDecide }: { request: McpAppApprovalRequest; onDecide: (allowed: boolean) => void }) {
  const { t } = useTranslation();
  const tool = request.kind === "tool";
  return (
    <AppDialog
      title={tool ? t("chat.mcpApp.approval.toolTitle") : t("chat.mcpApp.approval.messageTitle")}
      size="sm"
      onClose={() => onDecide(false)}
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={() => onDecide(false)}>{t("chat.mcpApp.approval.deny")}</Button>
          <Button variant="primary" onClick={() => onDecide(true)}>
            {tool ? t("chat.mcpApp.approval.allowTool") : t("chat.mcpApp.approval.allowMessage")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-chat-note text-gray-800 dark:text-gray-200">
        <p className="m-0 text-gray-600 dark:text-white/60">
          {tool ? t("chat.mcpApp.approval.toolHelp") : t("chat.mcpApp.approval.messageHelp")}
        </p>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-gray-500 dark:text-white/45">{t("chat.mcpApp.approval.server")}</dt>
          <dd data-approval="server" className="m-0 min-w-0 break-words font-mono text-chat-code">{request.server}</dd>
          {request.kind === "tool" && (
            <>
              <dt className="text-gray-500 dark:text-white/45">{t("chat.mcpApp.approval.tool")}</dt>
              <dd data-approval="tool" className="m-0 min-w-0 break-words font-mono text-chat-code">{request.tool}</dd>
            </>
          )}
        </dl>
        <div>
          <p className="m-0 mb-1 text-gray-500 dark:text-white/45">
            {request.kind === "tool" ? t("chat.mcpApp.approval.args") : t("chat.mcpApp.approval.message")}
          </p>
          <pre data-approval="body" className="m-0 max-h-56 overflow-auto cc-no-bar rounded-lg px-3 py-2 font-mono text-chat-code leading-snug whitespace-pre-wrap break-words
            bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-white/80">
            {request.kind === "tool" ? request.args : request.text}
          </pre>
        </div>
      </div>
    </AppDialog>
  );
}
