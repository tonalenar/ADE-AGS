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
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-px min-w-0">
          <span className="text-[13px] leading-[18px] text-gray-900 dark:text-gray-100">{t("settings.sandbox.label")}</span>
          <span className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">{t("settings.sandbox.desc")}</span>
        </div>
        {/* Pop-up estilo macOS: el valor y los chevrons apilados a la derecha. */}
        <span className="relative inline-flex shrink-0">
          <select
            value={mode}
            onChange={(e) => change(e.target.value as Mode)}
            className="h-7 appearance-none rounded-md pl-2.5 pr-7 text-[13px] text-gray-900 dark:text-gray-100
              bg-gray-200/70 dark:bg-surface-overlay
              focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/25"
          >
            <option value="off">{t("settings.sandbox.mode.off")}</option>
            <option value="auto">{t("settings.sandbox.mode.auto")}</option>
            <option value="strict">{t("settings.sandbox.mode.strict")}</option>
          </select>
          <svg aria-hidden="true" viewBox="0 0 16 16"
            className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2
              fill-none stroke-current stroke-[1.8] text-gray-500 dark:text-white/50">
            <path d="M5 6.2 8 3.4l3 2.8M5 9.8l3 2.8 3-2.8" />
          </svg>
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
