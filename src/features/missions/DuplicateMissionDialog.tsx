import { useTranslation } from "react-i18next";
import { Button, WarningIcon } from "neogestify-ui-components";
import { AppDialog } from "@/shared/ui/AppDialog";

interface DuplicateTarget {
  id: string;
  title: string;
  status: string;
  isRunning: boolean;
}

export function DuplicateMissionDialog({
  duplicate,
  onClose,
  onConfirm,
}: {
  duplicate: DuplicateTarget;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AppDialog
      title={t("missions.duplicate.title")}
      size="sm"
      closeOnEsc
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2 px-4 h-12">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            {t("missions.duplicate.startAnyway")}
          </Button>
        </div>
      }
    >
      <div className="flex gap-3 items-start py-1">
        <span className="shrink-0 text-amber-500 mt-0.5">
          <WarningIcon className="w-5 h-5" />
        </span>
        <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300">
          <p>
            {duplicate.isRunning
              ? t("missions.duplicate.runningMessage", { title: duplicate.title })
              : t("missions.duplicate.recentMessage", {
                  title: duplicate.title,
                  status: t(`missions.status.${duplicate.status}`, { defaultValue: duplicate.status }),
                })}
          </p>
          <p className="text-[11.5px] text-gray-500 dark:text-gray-400">
            {t("missions.duplicate.confirmHint")}
          </p>
        </div>
      </div>
    </AppDialog>
  );
}
