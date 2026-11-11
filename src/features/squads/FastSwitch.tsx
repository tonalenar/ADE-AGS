import { useTranslation } from "react-i18next";

import type { RosterModel } from "@/features/runs/types";
import { useHarnessCapability, type HarnessSurface } from "@/features/chat/harnessCapabilities";

import { effectiveModelForEffort, fastModeSupport } from "./modelSelection";

/** Interruptor Fast guiado pela capability da superfície e pelo catálogo do modelo. */
export function FastSwitch({ agentId, surface, checked, model, catalog, onChange }: {
  agentId: string;
  surface: HarnessSurface;
  checked: boolean;
  model: string | null;
  catalog: Pick<RosterModel, "id" | "aliases" | "fastSupported">[];
  onChange: (fast: boolean) => void;
}) {
  const { t } = useTranslation();
  const capability = useHarnessCapability(surface, agentId, "fast_mode");
  const effectiveModel = effectiveModelForEffort(model, catalog);
  const modelSupport = fastModeSupport(effectiveModel, catalog);
  if (capability.support !== "supported") return null;
  return (
    <div className="md:col-span-2 flex flex-col gap-1">
      <label className="flex items-center gap-2 text-[10.5px] text-gray-600 dark:text-white/55">
        <input type="checkbox" role="switch" checked={checked} disabled={modelSupport === "unsupported"} onChange={(event) => onChange(event.target.checked)} />
        <span className="font-semibold">{t("squads.form.fast")}</span>
        <span className="text-gray-400 dark:text-white/35">{t("squads.form.fastHint")}</span>
      </label>
      {checked && modelSupport === "unsupported" && (
        <span role="alert" className="text-[10px] text-amber-700 dark:text-amber-300">{t("squads.form.fastUnsupported")}</span>
      )}
    </div>
  );
}
