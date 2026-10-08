import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Button, Input } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import type { TerminalDeliveryInput, TerminalTestResult } from "./types";

const SELECT = "w-full";

export function MissionFinishDialog({ onClose, onFinish }: {
  onClose: () => void;
  onFinish: (input: TerminalDeliveryInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [testResult, setTestResult] = useState<TerminalTestResult>("not_run");
  const [pullRequest, setPullRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onFinish({ testResult, pullRequest: pullRequest.trim() || null });
      onClose();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("missions.delivery.form.title")}
      size="sm"
      closeOnEsc
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2 px-4 h-12">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t("btn.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}>
            {t("missions.delivery.form.submit")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{t("missions.delivery.form.testLabel")}</span>
          <PopupSelect className={SELECT} value={testResult} onChange={(event) => setTestResult(event.target.value as TerminalTestResult)}>
            {(["passed", "failed", "not_run"] as const).map((result) => (
              <option key={result} value={result}>{t(`missions.delivery.test.${result}`)}</option>
            ))}
          </PopupSelect>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{t("missions.delivery.form.prLabel")}</span>
          <Input size="sm" value={pullRequest} onChange={(event) => setPullRequest(event.target.value)}
            placeholder={t("missions.delivery.form.prPlaceholder")} className="font-mono" />
          <span className="text-[10.5px] leading-relaxed text-gray-400 dark:text-white/35">{t("missions.delivery.form.prHint")}</span>
        </label>

        <Alert variant="info">{t("missions.delivery.form.hint")}</Alert>
        {error && <Alert variant="warning">{error}</Alert>}
      </div>
    </AppDialog>
  );
}
