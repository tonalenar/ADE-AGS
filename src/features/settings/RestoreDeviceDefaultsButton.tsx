import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, useTheme } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { appConfirm } from "@/shared/ui/appConfirm";
import { AlertaToast } from "@/shared/ui/alerts";
import { DEVICE_DEFAULTS } from "@/features/settings/deviceDefaults";
import {
  changedDeviceDefaults,
  restoreDeviceDefaults,
  type DeviceDefault,
} from "@/features/settings/deviceDefaultsModel";

/** Os eventos que mudam um ajuste do aparelho sem passar pelo botão: o botão relê o que está fora do padrão. */
const REFRESH_EVENTS = ["storage", "focus", "ade-appearance-mode-changed", "cc-custom-theme-changed"] as const;

/**
 * "Restaurar padrões do aparelho", no cabeçalho das Configurações. Fica desativado quando nada está fora
 * do padrão; ao clicar, lista o que vai mudar e só então restaura (o mesmo "confirmar antes" do T3 Code).
 */
export function RestoreDeviceDefaultsButton() {
  const { t } = useTranslation();
  const { setTheme } = useTheme();
  const [changed, setChanged] = useState<readonly DeviceDefault[] | null>(null);

  const refresh = useCallback(() => {
    void changedDeviceDefaults(DEVICE_DEFAULTS).then(setChanged);
  }, []);

  useEffect(() => {
    refresh();
    for (const event of REFRESH_EVENTS) window.addEventListener(event, refresh);
    return () => {
      for (const event of REFRESH_EVENTS) window.removeEventListener(event, refresh);
    };
  }, [refresh]);

  const restore = async () => {
    // Relê antes de confirmar: a lista do cabeçalho pode estar velha.
    const current = await changedDeviceDefaults(DEVICE_DEFAULTS);
    setChanged(current);
    if (current.length === 0) {
      void AlertaToast(t("settings.restoreDefaults"), t("settings.restoreDefaults.nothing"), "info", 3000);
      return;
    }
    const confirmed = await appConfirm({
      title: t("settings.restoreDefaults.title"),
      lead: t("settings.restoreDefaults.lead"),
      items: current.map((item) => t(item.labelKey)),
      note: t("settings.restoreDefaults.note"),
      confirmLabel: t("settings.restoreDefaults.confirm"),
      cancelLabel: t("btn.cancel"),
      tone: "warning",
    });
    if (!confirmed) return;

    const outcome = await restoreDeviceDefaults(current, { setTheme });
    refresh();
    if (outcome.failed.length > 0) {
      const names = outcome.failed.map((item) => t(item.labelKey)).join(", ");
      void AlertaToast(t("settings.restoreDefaults"), t("settings.restoreDefaults.failed", { items: names }), "error", 6000);
    } else {
      void AlertaToast(t("settings.restoreDefaults"), t("settings.restoreDefaults.done"), "success", 3000);
    }
  };

  return (
    <Button size="sm" variant="ghost" disabled={changed === null || changed.length === 0} onClick={() => void restore()}>
      <RefreshIcon className="mx-0.5 w-3.5 h-3.5" />
      <span className="max-sm:sr-only">{t("settings.restoreDefaults")}</span>
    </Button>
  );
}
