import { useTranslation } from "react-i18next";

import { useDisplayPrefs } from "@/features/settings/displayPreferences";
import { environmentPill } from "@/features/settings/environmentIdentification";

/**
 * O selo do ambiente no rodapé (Configurações → Aparência → Identificação do ambiente). Numa instalação
 * de desenvolvimento diz "Desenvolvimento", para não confundir com o app instalado. Sem selo, não ocupa
 * espaço: o rodapé segue igual.
 */
export function EnvironmentPill() {
  const { t } = useTranslation();
  const mode = useDisplayPrefs().environmentIdentification;
  const pill = environmentPill(mode, import.meta.env.DEV);
  if (!pill) return null;
  return (
    <span
      data-environment-pill={pill}
      className={`shrink-0 rounded px-1.5 py-px font-medium ${pill === "development"
        ? "bg-accent-500/15 text-accent-700 dark:text-accent-300"
        : "bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-white/65"}`}
    >
      {t(pill === "development" ? "settings.environment.dev" : "settings.environment.installed")}
    </span>
  );
}
