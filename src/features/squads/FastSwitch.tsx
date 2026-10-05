import { useTranslation } from "react-i18next";

import type { RosterModel } from "@/features/runs/types";

import { fastModeSupport } from "./modelSelection";

/** Interruptor do modo Fast do Codex. Quem o renderiza só o mostra para o agente `codex`. */
export function FastSwitch({ checked, model, catalog, onChange }: {
  checked: boolean;
  model: string | null;
  catalog: Pick<RosterModel, "id" | "fastSupported">[];
  onChange: (fast: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="md:col-span-2 flex flex-col gap-1">
      <label className="flex items-center gap-2 text-[10.5px] text-gray-600 dark:text-white/55">
        <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="font-semibold">{t("squads.form.fast")}</span>
        <span className="text-gray-400 dark:text-white/35">{t("squads.form.fastHint")}</span>
      </label>
      {checked && fastModeSupport(model, catalog) === "unsupported" && (
        <span role="alert" className="text-[10px] text-amber-700 dark:text-amber-300">{t("squads.form.fastUnsupported")}</span>
      )}
    </div>
  );
}
