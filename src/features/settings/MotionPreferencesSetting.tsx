import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsToggleRow } from "@/features/settings/SettingsSection";

import { MOTION_DURATION, MOTION_DURATION_KEY, readMotionDuration, saveMotionDuration } from "./motionPreferences";

export function MotionPreferencesSetting() {
  const { t } = useTranslation();
  const [duration, setDuration] = useState(readMotionDuration);
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const updateReduced = () => setSystemReduced(media?.matches === true);
    const storage = (event: StorageEvent) => {
      if (event.key === MOTION_DURATION_KEY) setDuration(readMotionDuration());
    };
    media?.addEventListener?.("change", updateReduced);
    window.addEventListener("storage", storage);
    return () => {
      media?.removeEventListener?.("change", updateReduced);
      window.removeEventListener("storage", storage);
    };
  }, []);

  return (
    <SettingsToggleRow
      checked={duration > 0}
      onChange={(enabled) => setDuration(saveMotionDuration(enabled ? MOTION_DURATION.default : 0))}
      label={t("settings.motion.enabled")}
      description={t("settings.motion.description")}
    >
      <div className="flex items-center gap-3 pt-1">
        <label htmlFor="ade-motion-duration" className="sr-only">{t("settings.motion.duration")}</label>
        <input id="ade-motion-duration" type="range" min={MOTION_DURATION.min} max={MOTION_DURATION.max} step={MOTION_DURATION.step}
          value={duration} onChange={(event) => setDuration(saveMotionDuration(Number(event.target.value)))}
          disabled={duration === 0} className="w-full accent-accent-600 disabled:opacity-45" />
        <output htmlFor="ade-motion-duration" className="w-16 shrink-0 text-right font-mono text-chat-caption tabular-nums text-gray-600 dark:text-white/65">
          {t("settings.motion.milliseconds", { count: duration })}
        </output>
      </div>
      {systemReduced && <p className="mt-2 mb-0 text-chat-caption text-gray-500 dark:text-white/45">{t("settings.motion.systemReduced")}</p>}
    </SettingsToggleRow>
  );
}
