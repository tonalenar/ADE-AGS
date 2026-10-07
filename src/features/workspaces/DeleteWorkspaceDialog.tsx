import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { getMemoryWorkspaceStats } from "@/features/memory/ipc";
import { AppDialog } from "@/shared/ui/AppDialog";
import { deleteWithChoice, type DeleteChoice } from "./deleteWorkspaceFlow";

/**
 * Pergunta "exportar memória antes de apagar?" ao apagar um workspace. Apagar é um soft-delete de
 * 30 dias; se a exportação falhar, nada é apagado e o erro fica visível aqui.
 */
export function DeleteWorkspaceDialog({
  workspaceId,
  workspaceName,
  remove,
  onClose,
  onDeleted,
}: {
  workspaceId: string;
  workspaceName: string;
  remove: (id: string) => Promise<void>;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<DeleteChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    getMemoryWorkspaceStats(workspaceId)
      .then((s) => alive && setEntries(typeof s?.entries === "number" ? s.entries : null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const run = async (choice: DeleteChoice) => {
    setBusy(choice);
    setError(null);
    try {
      await deleteWithChoice(workspaceId, choice, remove);
      onDeleted?.();
      onClose();
    } catch (e) {
      setError(t(choice === "export" ? "workspaceDelete.exportFailed" : "workspaceDelete.deleteFailed", { detail: String(e) }));
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  return (
    <AppDialog
      title={t("workspaceDelete.title")}
      onClose={() => !disabled && onClose()}
      size="sm"
      closeOnBackdrop={!disabled}
      closeOnEsc={!disabled}
      variant="danger"
      footer={
        <>
          <Button variant="outline" disabled={disabled} onClick={onClose}>
            {t("workspaceDelete.cancel")}
          </Button>
          <Button variant="danger" disabled={disabled} onClick={() => void run("skip")}>
            {t("workspaceDelete.skip")}
          </Button>
          <Button autoFocus variant="primary" disabled={disabled} onClick={() => void run("export")}>
            {busy === "export" ? t("workspaceDelete.exporting") : t("workspaceDelete.export")}
          </Button>
        </>
      }
    >
      <div role="alertdialog" aria-label={t("workspaceDelete.title")} className="flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-300">
        <p>
          {entries === null
            ? t("workspaceDelete.bodyUnknown", { name: workspaceName })
            : t("workspaceDelete.body", { name: workspaceName, count: entries })}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("workspaceDelete.retention")}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("workspaceDelete.keys")}</p>
        {error && (
          <p role="alert" className="rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </AppDialog>
  );
}
