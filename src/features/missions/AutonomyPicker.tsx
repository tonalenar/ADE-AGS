import { useState } from "react";
import { useTranslation } from "react-i18next";

import { getAutonomy, setAutonomy, type Autonomy } from "./autonomy";

/** Quántos permisos piden los agentes de las próximas misiones en terminales (se lee al "Iniciar"). */
export function AutonomyPicker() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<Autonomy>(getAutonomy);
  const options: Autonomy[] = ["safe", "ask"];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={level === option}
            onClick={() => { setAutonomy(option); setLevel(option); }}
            className={`cc-t h-7 px-2.5 rounded-md text-[12px] border ${level === option
              ? "border-accent-500/60 bg-accent-500/15 text-accent-700 dark:text-accent-300"
              : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5"}`}>
            {t(`missions.autonomy.${option}`)}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-gray-400 dark:text-white/35">{t(`missions.autonomy.${level}Hint`)}</p>
    </div>
  );
}
