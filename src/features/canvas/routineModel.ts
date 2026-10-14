// Modelo puro das rotinas: os tipos que vêm do backend, o rascunho do formulário e as regras
// que o formulário checa antes de pedir a criação (as mesmas do Rust: `routine_create_ui`).
// Sem React: é o que os testes cobrem.

export type Schedule =
  | { kind: "every"; secs: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] }
  | { kind: "once"; at: number };

export interface Routine {
  id: string;
  name: string;
  text: string;
  targetTab: string | null;
  targetName: string;
  schedule: Schedule;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  lastResult: string;
  runs: number;
  catchUp: boolean;
  missedAt: number | null;
}

export const MAX_NAME = 40;
export const MAX_TEXT = 1000;
/** O menor intervalo de uma rotina que se repete (`routines::MIN_EVERY_SECS` no Rust). */
export const MIN_EVERY_SECS = 5 * 60;
/** A folga mínima de um lembrete único (`routines::MIN_IN_SECS`). */
const MIN_ONCE_SECS = 60;

const DAY_NAMES = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** O horário em palavras, como lo dice `ags routines`. Sem `t` sale em português. */
export function describeSchedule(s: Schedule, t?: Translate): string {
  const say = (key: string, fallback: string, vars: Record<string, string | number> = {}) =>
    (t ? t(`canvas.routines.sched.${key}`, vars) : fallback);
  if (s.kind === "once") return say("once", "uma vez");
  if (s.kind === "every") {
    if (s.secs % 3600 === 0) return say("everyHours", `a cada ${s.secs / 3600} h`, { n: s.secs / 3600 });
    if (s.secs % 60 === 0) return say("everyMinutes", `a cada ${s.secs / 60} min`, { n: s.secs / 60 });
    return say("everySeconds", `a cada ${s.secs} s`, { n: s.secs });
  }
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  if (s.days.length === 0) return say("daily", `todo dia às ${time}`, { time });
  const days = s.days.map((d) => (t ? t(`canvas.routines.sched.day${d}`) : DAY_NAMES[d])).join(", ");
  return say("onDays", `às ${time} (${days})`, { time, days });
}

/** Quando faltar menos de um minuto, ou já passou, a tela diz "agora". */
export function relativeFrom(unix: number, nowMs: number, locale: string): string | null {
  const diff = unix - nowMs / 1000;
  if (diff < 60) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diff >= 86_400) return rtf.format(Math.round(diff / 86_400), "day");
  if (diff >= 3600) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 60), "minute");
}

// ── Rascunho do formulário ──────────────────────────────────────────

export interface Draft {
  name: string;
  text: string;
  kind: Schedule["kind"];
  /** Texto do campo (o usuário digita): número de minutos ou de horas. */
  amount: string;
  unit: "min" | "h";
  hour: number;
  minute: number;
  days: number[];
  /** "YYYY-MM-DDTHH:mm", como o `datetime-local` entrega. */
  onceAt: string;
  /** A id da aba que recebe. `null` = só um lembrete para o usuário. */
  target: string | null;
  catchUp: boolean;
}

/** `Date` → "YYYY-MM-DDTHH:mm" no fuso local (o formato do `datetime-local`). */
export function toLocalInput(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function emptyDraft(nowMs: number, target: string | null): Draft {
  return {
    name: "",
    text: "",
    kind: "daily",
    amount: "30",
    unit: "min",
    hour: 9,
    minute: 0,
    days: [],
    onceAt: toLocalInput(new Date(nowMs + 60 * 60 * 1000)),
    target,
    catchUp: false,
  };
}

/** Chaves de i18n de cada erro (a tela as traduz). */
export interface DraftErrors {
  name?: string;
  text?: string;
  schedule?: string;
}

/** Normaliza como o backend (`clean_text`): uma linha, espaços colapsados. */
export function normalizeText(raw: string): string {
  return raw.replace(/[\r\n\t]/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Checa o rascunho. `schedule` vem `null` quando o horário não serve (o erro fica em
 * `errors.schedule`); os erros de nome e texto não afetam o horário.
 */
export function checkDraft(d: Draft, nowMs: number): { errors: DraftErrors; schedule: Schedule | null } {
  const errors: DraftErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = "canvas.routines.err.name";
  else if ([...name].length > MAX_NAME) errors.name = "canvas.routines.err.nameLong";

  const text = normalizeText(d.text);
  if (!text) errors.text = "canvas.routines.err.text";
  else if ([...text].length > MAX_TEXT) errors.text = "canvas.routines.err.textLong";

  let schedule: Schedule | null = null;
  if (d.kind === "every") {
    const n = Number(d.amount);
    const secs = d.unit === "h" ? n * 3600 : n * 60;
    if (!Number.isInteger(n) || n < 1) errors.schedule = "canvas.routines.err.amount";
    else if (secs < MIN_EVERY_SECS) errors.schedule = "canvas.routines.err.every";
    else schedule = { kind: "every", secs };
  } else if (d.kind === "daily") {
    schedule = { kind: "daily", hour: d.hour, minute: d.minute, days: [...new Set(d.days)].sort((a, b) => a - b) };
  } else {
    const ms = new Date(d.onceAt).getTime();
    if (Number.isNaN(ms)) errors.schedule = "canvas.routines.err.onceEmpty";
    else if (ms / 1000 < nowMs / 1000 + MIN_ONCE_SECS) errors.schedule = "canvas.routines.err.past";
    else schedule = { kind: "once", at: Math.floor(ms / 1000) };
  }
  return { errors, schedule };
}

/**
 * A frase-resumo ao vivo: "Envia “rode os testes” para Claude, todo dia às 09:00." Devolve
 * `null` quando ainda não dá para dizer (sem texto ou com horário inválido).
 */
export function summarize(d: Draft, agentName: string | null, t: Translate, nowMs: number): string | null {
  const { schedule } = checkDraft(d, nowMs);
  const text = normalizeText(d.text);
  if (!schedule || !text) return null;
  const when = schedule.kind === "once"
    ? t("canvas.routines.whenOnceAt", { at: d.onceAt.slice(8, 10) + "/" + d.onceAt.slice(5, 7) + " " + d.onceAt.slice(11, 16) })
    : describeSchedule(schedule, t);
  const clip = text.length > 80 ? text.slice(0, 79) + "…" : text;
  return agentName
    ? t("canvas.routines.sum.toAgent", { text: clip, agent: agentName, when })
    : t("canvas.routines.sum.toMe", { text: clip, when });
}
