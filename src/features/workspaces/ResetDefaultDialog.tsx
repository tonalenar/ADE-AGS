import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
} from "neogestify-ui-components";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { AppDialog } from "@/shared/ui/AppDialog";

interface ResetDefaultDialogProps {
  onClose: () => void;
}

/** Advertencia antes de "Nuevo workspace": el bucket default tiene tabs sin guardar y se perderían. */
export function ResetDefaultDialog({ onClose }: ResetDefaultDialogProps) {
  const { t } = useTranslation();
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await resetDefaultWorkspace();
      onClose();
    } catch (cause) {
      // Sem isso, a confirmação não fazia nada e ninguém dizia por quê: o erro fica na tela e o diálogo segue aberto.
      setError(t("workspace.resetDefault.failed", { detail: String(cause) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("workspace.resetDefault.title")}
      onClose={onClose}
      size="sm"
      closeOnBackdrop
      closeOnEsc
      variant="danger"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={handleConfirm}>
            {t("workspace.resetDefault.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t("workspace.resetDefault.body")}
      </p>
      {error && (
        <p role="alert" className="mt-3 w-full rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </AppDialog>
  );
}
