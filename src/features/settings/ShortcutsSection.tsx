import { useTranslation } from "react-i18next";

import { SHORTCUTS } from "@/app/shortcuts";
import { SettingsSection } from "@/features/settings/SettingsSection";

/** Cada tecla en su propia caja, como se dibuja una tecla. */
function Chord({ display }: { display: string }) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      {display.split("+").map((key) => (
        <kbd
          key={key}
          className="min-w-5 h-5 px-1.5 rounded-[5px] inline-flex items-center justify-center
            font-mono text-[11px] leading-none tabular-nums
            bg-white dark:bg-surface-overlay
            text-gray-700 dark:text-gray-200
            shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] dark:shadow-[inset_0_-1px_0_rgba(0,0,0,0.45),0_0_0_0.5px_rgba(255,255,255,0.08)]"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Referencia de atajos.
 *
 * Es de solo lectura y aun así vale la pena: un atajo que nadie sabe que existe no
 * existe, y el tooltip de la barra superior solo cubre los que tienen botón — Ctrl+Tab
 * no aparecería en ningún lado.
 */
export function ShortcutsSection() {
  const { t } = useTranslation();

  return (
    <SettingsSection title={t("settings.shortcuts")} description={t("settings.shortcuts.desc")}>

      <ul className="flex flex-col overflow-hidden rounded-xl
        bg-gray-100/70 dark:bg-surface-raised/60
        divide-y divide-gray-200 dark:divide-white/[0.08]">
        {SHORTCUTS.map((s) => (
          <li key={s.display} className="flex items-center justify-between gap-4 min-h-10 px-3 py-2">
            <span className="text-[13px] text-gray-900 dark:text-gray-100 min-w-0 truncate">
              {t(s.labelKey)}
            </span>
            <Chord display={s.display} />
          </li>
        ))}
      </ul>

      {/* Lo que un atajo global le saca a la terminal se dice acá y no se descubre a los
          tres días: son teclas que las TUIs ya usaban. */}
      <p className="px-3 py-2.5 rounded-xl text-[12px] leading-4
        bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300">
        {t("settings.shortcuts.terminalNote")}
      </p>
    </SettingsSection>
  );
}
