import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { getSetting, setSetting } from "@/shared/ipc/settings";

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
    setMode(value);
    setSetting(SANDBOX_KEY, value).then(refresh).catch(console.error);
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm">{t("settings.sandbox.label")}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{t("settings.sandbox.desc")}</span>
        </div>
        <select
          value={mode}
          onChange={(e) => change(e.target.value as Mode)}
          className="text-xs rounded-md px-2 py-1 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10"
        >
          <option value="off">{t("settings.sandbox.mode.off")}</option>
          <option value="auto">{t("settings.sandbox.mode.auto")}</option>
          <option value="strict">{t("settings.sandbox.mode.strict")}</option>
        </select>
      </div>
      {status && (
        <span
          className={`text-xs ${status.fsIsolation ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
        >
          {status.fsIsolation
            ? t("settings.sandbox.active", { backend: status.backend })
            : t(`settings.sandbox.reason.${status.reason ?? "disabled"}`)}
        </span>
      )}
    </div>
  );
}
