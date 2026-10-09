import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { getSetting, setSetting } from "@/shared/ipc/settings";
import { AlertaToast } from "neogestify-ui-components";

/** La clave que lee `runs/sandbox.rs`. Sin valor es "auto". */
const SANDBOX_KEY = "runs.sandbox";

type Mode = "off" | "auto" | "strict";

interface SandboxStatus {
  mode: Mode;
  backend: "none" | "bubblewrap" | "seatbelt" | "job-object";
  fsIsolation: boolean;
  reason: "disabled" | "missing-bwrap" | "missing-sandbox-exec" | "windows" | null;
}

/**
 * Aislamiento de los agentes de la flota: con el sandbox, escriben solo en su carpeta, su
 * cuenta y los temporales. Muestra lo que esta máquina puede garantizar de verdad.
 */
export function SandboxSetting() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("auto");
  const [status, setStatus] = useState<SandboxStatus | null>(null);

  const refresh = () => invoke<SandboxStatus>("sandbox_status").then(setStatus).catch(() => {});

  useEffect(() => {
    getSetting(SANDBOX_KEY)
      .then((v) => setMode(v === "off" || v === "strict" ? v : "auto"))
      .catch(() => {});
    refresh();
  }, []);

  const change = (value: Mode) => {
    const previous = mode;
    setMode(value);
    // Se a gravação falha, o valor visível volta ao que está salvo e o erro aparece.
    setSetting(SANDBOX_KEY, value).then(refresh).catch((e) => {
      setMode(previous);
      AlertaToast(t("settings.sandbox.label"), String(e), "error", 6000);
    });
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-px min-w-0">
          <span className="text-[13px] leading-[18px] text-gray-900 dark:text-gray-100">{t("settings.sandbox.label")}</span>
          <span className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">{t("settings.sandbox.desc")}</span>
        </div>
        {/* Pop-up estilo macOS: el valor y los chevrons apilados a la derecha. */}
        <span className="relative inline-flex shrink-0">
          <PopupSelect
            value={mode}
            onChange={(e) => change(e.target.value as Mode)}
          >
            <option value="off">{t("settings.sandbox.mode.off")}</option>
            <option value="auto">{t("settings.sandbox.mode.auto")}</option>
            <option value="strict">{t("settings.sandbox.mode.strict")}</option>
          </PopupSelect>
        </span>
      </div>
      {status && (
        <span
          className={`text-[11.5px] leading-4 ${status.fsIsolation ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
        >
          {status.fsIsolation
            ? t("settings.sandbox.active", { backend: status.backend })
            : t(`settings.sandbox.reason.${status.reason ?? "disabled"}`)}
        </span>
      )}
    </div>
  );
}
