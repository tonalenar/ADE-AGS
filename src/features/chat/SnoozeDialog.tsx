import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { loadSnoozePresets, snoozePresetDeadline } from "./snoozePreferences";

function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function SnoozeDialog({ title, onChoose, onClose }: {
  title: string;
  onChoose: (until: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(() => localDateTimeValue(Date.now() + 60 * 60 * 1000));
  const [error, setError] = useState(false);
  const presets = loadSnoozePresets()
    .map((preset) => ({ preset, until: snoozePresetDeadline(preset) }))
    .sort((a, b) => a.until - b.until);
  const formatDuration = (minutes: number) => {
    const parts: string[] = [];
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainder = minutes % 60;
    if (days) parts.push(`${days} ${t("chat.settings.snooze.unitDay")}`);
    if (hours) parts.push(`${hours} ${t("chat.settings.snooze.unitHour")}`);
    if (remainder) parts.push(`${remainder} ${t("chat.settings.snooze.unitMinute")}`);
    return parts.join(" ");
  };
  const presetLabel = (preset: (typeof presets)[number]["preset"], until: number) => {
    if (preset.kind === "duration") {
      return t("chat.sidebar.snoozeForDuration", { duration: formatDuration(preset.minutes) });
    }
    const sameDay = new Date(until).toDateString() === new Date().toDateString();
    return t(sameDay ? "chat.sidebar.snoozeTodayAt" : "chat.sidebar.snoozeTomorrowAt", { time: preset.time });
  };
  const chooseCustom = () => {
    const until = new Date(custom).getTime();
    if (!Number.isFinite(until) || until <= Date.now()) {
      setError(true);
      return;
    }
    onChoose(until);
  };

  return (
    <AppDialog title={t("chat.sidebar.snoozeDialogTitle")} size="sm" onClose={onClose} closeOnEsc
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={chooseCustom}>{t("chat.sidebar.snoozeCustomApply")}</Button>
        </>
      )}>
      <div className="flex flex-col gap-3 text-chat-ui text-gray-800 dark:text-white/85">
        <p className="m-0 text-gray-600 dark:text-white/60">{t("chat.sidebar.snoozeDescription", { title })}</p>
        <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto">
          {presets.map(({ preset, until }, index) => (
            <Button key={`${preset.kind}-${preset.kind === "duration" ? preset.minutes : preset.time}-${index}`}
              variant="outline" onClick={() => onChoose(until)}>{presetLabel(preset, until)}</Button>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-chat-note text-gray-600 dark:text-white/60">
          <span>{t("chat.sidebar.snoozeCustomLabel")}</span>
          <input type="datetime-local" value={custom} min={localDateTimeValue(Date.now() + 60_000)}
            onChange={(event) => { setCustom(event.target.value); setError(false); }}
            className="h-9 px-2.5 rounded-md bg-white dark:bg-white/[0.06] border border-gray-300 dark:border-white/15 text-chat-ui text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-accent-500/60" />
        </label>
        {error && <p role="alert" className="m-0 text-chat-note text-red-600 dark:text-red-400">{t("chat.sidebar.snoozeInvalid")}</p>}
      </div>
    </AppDialog>
  );
}
