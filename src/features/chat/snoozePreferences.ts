/** Opções de adiamento configuráveis nesta máquina, sem sincronizar entre dispositivos. */
export type SnoozePreset =
  | { kind: "duration"; minutes: number }
  | { kind: "time"; time: string };

const KEY = "cc-chat-snooze-options";
const MAX_PRESETS = 12;

export const DEFAULT_SNOOZE_PRESETS: SnoozePreset[] = [
  { kind: "duration", minutes: 60 },
  { kind: "duration", minutes: 180 },
  { kind: "time", time: "09:00" },
];

function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function parseSnoozePresets(value: unknown): SnoozePreset[] {
  if (!Array.isArray(value)) return DEFAULT_SNOOZE_PRESETS.map((preset) => ({ ...preset }));
  return value.flatMap((item): SnoozePreset[] => {
    if (!item || typeof item !== "object") return [];
    const preset = item as Record<string, unknown>;
    if (preset.kind === "duration" && typeof preset.minutes === "number"
      && Number.isInteger(preset.minutes) && preset.minutes >= 1 && preset.minutes <= 525_600) {
      return [{ kind: "duration", minutes: preset.minutes }];
    }
    if (preset.kind === "time" && isClockTime(preset.time)) return [{ kind: "time", time: preset.time }];
    return [];
  }).slice(0, MAX_PRESETS);
}

export function loadSnoozePresets(): SnoozePreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_SNOOZE_PRESETS.map((preset) => ({ ...preset })) : parseSnoozePresets(JSON.parse(raw));
  } catch {
    return DEFAULT_SNOOZE_PRESETS.map((preset) => ({ ...preset }));
  }
}

export function saveSnoozePresets(presets: SnoozePreset[]): void {
  const normalized = parseSnoozePresets(presets);
  try {
    localStorage.setItem(KEY, JSON.stringify(normalized));
  } catch {
    /* A preferência local não impede adiar uma conversa nesta sessão. */
  }
}

/** Horário do dia: hoje quando ainda está por vir; caso contrário, na próxima ocorrência. */
export function snoozePresetDeadline(preset: SnoozePreset, now = Date.now()): number {
  if (preset.kind === "duration") return now + preset.minutes * 60_000;
  const [hours, minutes] = preset.time.split(":").map(Number);
  const deadline = new Date(now);
  deadline.setHours(hours, minutes, 0, 0);
  if (deadline.getTime() <= now) deadline.setDate(deadline.getDate() + 1);
  return deadline.getTime();
}

export function sameSnoozePreset(a: SnoozePreset, b: SnoozePreset): boolean {
  return a.kind === b.kind && (a.kind === "duration"
    ? a.minutes === (b as Extract<SnoozePreset, { kind: "duration" }>).minutes
    : a.time === (b as Extract<SnoozePreset, { kind: "time" }>).time);
}

export function canAddSnoozePreset(presets: SnoozePreset[], candidate: SnoozePreset): boolean {
  return presets.length < MAX_PRESETS && !presets.some((preset) => sameSnoozePreset(preset, candidate));
}
