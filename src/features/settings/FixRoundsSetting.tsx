import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSetting, setSetting } from "@/shared/ipc/settings";

/** A mesma chave que `runs/fixrounds.rs` lee. Sin valor, el teto es 2. */
const KEY = "fix_rounds.max";

/**
 * Teto de correcciones de la misma entrega, en el canvas y en la flota. La variable
 * ADE_AGS_MAX_FIX_ROUNDS, si existe, gana a esta clave.
 */
export function FixRoundsSetting() {
  const { t } = useTranslation();
  const [value, setValue] = useState("2");

  useEffect(() => {
    getSetting(KEY)
      .then((stored) => {
        const n = Number(stored);
        if (stored && Number.isInteger(n) && n >= 0 && n <= 20) setValue(String(n));
      })
      .catch(() => {});
  }, []);

  const change = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 20) return;
    setValue(String(n));
    setSetting(KEY, String(n)).catch(console.error);
  };

  return (
    <div className="flex items-center justify-between gap-4 min-h-10 px-3 py-2">
      <div className="flex flex-col gap-px min-w-0">
        <span className="text-[13px] leading-[18px] text-gray-900 dark:text-gray-100">{t("settings.fixRounds.label")}</span>
        <span className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">{t("settings.fixRounds.desc")}</span>
      </div>
      <input
        type="number"
        min={0}
        max={20}
        value={value}
        onChange={(e) => change(e.target.value)}
        className="h-7 w-14 rounded-md bg-gray-200/70 dark:bg-surface-overlay px-2 text-center
          font-mono text-[13px] tabular-nums text-gray-900 dark:text-gray-100
          focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/25"
      />
    </div>
  );
}
