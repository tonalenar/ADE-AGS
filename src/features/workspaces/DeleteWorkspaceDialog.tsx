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
        // Alerta do macOS (prancheta 3): os botões empilhados na largura toda — o principal em
        // cima, apagar sem exportar em vermelho, Cancelar embaixo. A ordem no DOM fica
        // Cancelar → Apagar → Exportar (a de leitura/tab de antes); o col-reverse só a desenha.
        <div className="flex w-full flex-col-reverse gap-2">
          <p className="pt-1 text-center text-[11px] text-gray-400 dark:text-white/35">{t("workspaceDelete.retention")}</p>
          <Button variant="outline" className="w-full justify-center h-[30px]" disabled={disabled} onClick={onClose}>
            {t("workspaceDelete.cancel")}
          </Button>
          <Button variant="danger" className="w-full justify-center h-[30px]" disabled={disabled} onClick={() => void run("skip")}>
            {t("workspaceDelete.skip")}
          </Button>
          <Button autoFocus variant="primary" className="w-full justify-center h-[30px]" disabled={disabled} onClick={() => void run("export")}>
            {busy === "export" ? t("workspaceDelete.exporting") : t("workspaceDelete.export")}
          </Button>
        </div>
      }
    >
      <div role="alertdialog" aria-label={t("workspaceDelete.title")} className="flex flex-col items-center gap-3 pt-2 text-center">
        <span aria-hidden className="flex h-16 w-16 items-center justify-center rounded-full bg-[rgba(255,159,10,0.16)] text-[#ff9f0a]">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 10v4.2" /><circle cx="12" cy="17" r="0.6" fill="currentColor" />
          </svg>
        </span>
        <p className="text-[13.5px] leading-[19px] text-gray-600 dark:text-white/60">
          {entries === null
            ? t("workspaceDelete.bodyUnknown", { name: workspaceName })
            : t("workspaceDelete.body", { name: workspaceName, count: entries })}
        </p>
        <p className="text-[11.5px] text-gray-400 dark:text-white/35">{t("workspaceDelete.keys")}</p>
        {error && (
          <p role="alert" className="w-full rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </AppDialog>
  );
}
