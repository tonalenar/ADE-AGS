import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, TrashIcon } from "neogestify-ui-components";

import { SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";

import {
  canAddSnoozePreset, DEFAULT_SNOOZE_PRESETS, loadSnoozePresets, saveSnoozePresets,
  type SnoozePreset,
} from "./snoozePreferences";

function formatDuration(minutes: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  if (days) parts.push(`${days} ${t("chat.settings.snooze.unitDay")}`);
  if (hours) parts.push(`${hours} ${t("chat.settings.snooze.unitHour")}`);
  if (remainder) parts.push(`${remainder} ${t("chat.settings.snooze.unitMinute")}`);
  return parts.join(" ");
}

export function SnoozeOptionsSetting() {
  const { t } = useTranslation();
  const [presets, setPresets] = useState(loadSnoozePresets);
  const [duration, setDuration] = useState("60");
  const [time, setTime] = useState("09:00");

  const commit = (next: SnoozePreset[]) => {
    setPresets(next);
    saveSnoozePresets(next);
  };
  const addDuration = () => {
    const candidate: SnoozePreset = { kind: "duration", minutes: Number(duration) };
    if (!Number.isInteger(candidate.minutes) || candidate.minutes < 1 || candidate.minutes > 525_600
      || !canAddSnoozePreset(presets, candidate)) return;
    commit([...presets, candidate]);
  };
  const addTime = () => {
    const candidate: SnoozePreset = { kind: "time", time };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !canAddSnoozePreset(presets, candidate)) return;
    commit([...presets, candidate]);
  };
  const describe = (preset: SnoozePreset) => preset.kind === "duration"
    ? t("chat.settings.snooze.duration", { duration: formatDuration(preset.minutes, t) })
    : t("chat.settings.snooze.daily", { time: preset.time });

  return (
    <SettingsSection title={t("chat.settings.snooze.title")} description={t("chat.settings.snooze.description")}
      action={<Button variant="outline" size="sm" onClick={() => commit(DEFAULT_SNOOZE_PRESETS.map((preset) => ({ ...preset })))}>
        {t("chat.settings.snooze.reset")}
      </Button>}>
      <SettingsGroup>
        {presets.map((preset, index) => (
          <SettingsRow key={`${preset.kind}-${preset.kind === "duration" ? preset.minutes : preset.time}-${index}`}
            label={describe(preset)}>
            <Button variant="icon" aria-label={t("chat.settings.snooze.remove", { option: describe(preset) })}
              onClick={() => commit(presets.filter((_, itemIndex) => itemIndex !== index))}
              className="cc-t flex items-center justify-center w-7 h-7 rounded-md text-gray-500 dark:text-white/40 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-white/10 p-0">
              <TrashIcon className="w-3.5 h-3.5" />
            </Button>
          </SettingsRow>
        ))}
        {presets.length === 0 && (
          <p className="m-0 px-4 py-3 text-[13px] text-gray-500 dark:text-white/50">{t("chat.settings.snooze.empty")}</p>
        )}
        <div className="flex flex-wrap items-end gap-3 px-4 py-3.5">
          <label className="flex flex-col gap-1 text-[12px] text-gray-600 dark:text-white/60">
            <span>{t("chat.settings.snooze.durationLabel")}</span>
            <input type="number" min={1} max={525600} step={1} value={duration}
              onChange={(event) => setDuration(event.target.value)}
              aria-label={t("chat.settings.snooze.durationLabel")}
              className="h-8 w-28 rounded-md border border-gray-300 bg-white px-2 text-[13px] text-gray-900 outline-none focus:ring-2 focus:ring-accent-500/40 dark:border-white/15 dark:bg-white/[0.06] dark:text-white" />
          </label>
          <Button variant="outline" size="sm" onClick={addDuration}
            disabled={!canAddSnoozePreset(presets, { kind: "duration", minutes: Number(duration) })
              || !Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 525_600}>
            {t("chat.settings.snooze.addDuration")}
          </Button>
          <span aria-hidden="true" className="hidden h-8 w-px bg-gray-200 dark:bg-white/10 sm:block" />
          <label className="flex flex-col gap-1 text-[12px] text-gray-600 dark:text-white/60">
            <span>{t("chat.settings.snooze.timeLabel")}</span>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)}
              aria-label={t("chat.settings.snooze.timeLabel")}
              className="h-8 rounded-md border border-gray-300 bg-white px-2 text-[13px] text-gray-900 outline-none focus:ring-2 focus:ring-accent-500/40 dark:border-white/15 dark:bg-white/[0.06] dark:text-white" />
          </label>
          <Button variant="outline" size="sm" onClick={addTime}
            disabled={!canAddSnoozePreset(presets, { kind: "time", time })}>
            {t("chat.settings.snooze.addTime")}
          </Button>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
