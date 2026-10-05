import { Alert } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

import { failureActionKey, failureKey, failureLabelKey } from "./failureClass";
import type { Mission } from "./types";

/** Por qué falló la misión y qué hacer, en el detalle. Sin clasificación muestra la acción genérica. */
export function FailureNotice({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const key = failureKey(mission);
  if (!key) return null;
  return (
    <Alert variant="warning">
      <div className="font-medium">{t(failureLabelKey(key))}</div>
      <div>{t(failureActionKey(mission), { defaultValue: t("missions.failure.action.unknown") })}</div>
      {mission.failureDetail && <div className="mt-1 text-xs opacity-70">{mission.failureDetail}</div>}
    </Alert>
  );
}
