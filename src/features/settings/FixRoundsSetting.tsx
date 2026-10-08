import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSetting, setSetting } from "@/shared/ipc/settings";

/** A mesma chave que `runs/fixrounds.rs` lê. Sem valor, o teto é 2. */
const KEY = "fix_rounds.max";

/**
 * Teto de correções da mesma entrega, no canvas e na frota. A variável
 * ADE_AGS_MAX_FIX_ROUNDS, se existir, ganha desta chave.
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
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <div className="flex flex-col">
        <span className="text-sm">{t("settings.fixRounds.label")}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{t("settings.fixRounds.desc")}</span>
      </div>
      <input
        type="number"
        min={0}
        max={20}
        value={value}
        onChange={(e) => change(e.target.value)}
        className="w-16 text-xs rounded-md px-2 py-1 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10"
      />
    </div>
  );
}
