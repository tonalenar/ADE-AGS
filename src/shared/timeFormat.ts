/**
 * O formato de hora da app (Configurações → Geral → Formato de hora). Um só lugar para o chat, a
 * barra lateral e a timeline, como o `timestampFormat` do T3 Code. Puro: o idioma e o relógio entram
 * como argumento, então o teste não depende da máquina nem do dia.
 */

/** `locale` segue o relógio do sistema; `12-hour` e `24-hour` forçam o formato. */
export type TimeFormat = "locale" | "12-hour" | "24-hour";

export const TIME_FORMATS: readonly TimeFormat[] = ["locale", "12-hour", "24-hour"];

export function isTimeFormat(value: unknown): value is TimeFormat {
  return value === "locale" || value === "12-hour" || value === "24-hour";
}

/** As opções do `Intl.DateTimeFormat` de cada formato. `locale` não mexe em nada: o idioma decide. */
export function timeFormatOptions(format: TimeFormat, base: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  if (format === "locale") return base;
  return { ...base, hour12: format === "12-hour" };
}

/** A hora sozinha, no formato escolhido ("14:05" ou "2:05 PM"). */
export function formatClock(ms: number, format: TimeFormat, language: string | undefined, includeSeconds = false): string {
  return new Intl.DateTimeFormat(language, timeFormatOptions(format, {
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  })).format(new Date(ms));
}

/**
 * Hora de um carimbo: no mesmo dia sai só a hora; em outro dia sai a data curta antes dela. `now` é o
 * relógio de quem chama, para o resultado não depender da hora em que o teste roda.
 */
export function formatTimestamp(ms: number, format: TimeFormat, language: string | undefined, now: number): string {
  const at = new Date(ms);
  const current = new Date(now);
  const sameDay = at.getFullYear() === current.getFullYear()
    && at.getMonth() === current.getMonth()
    && at.getDate() === current.getDate();
  if (sameDay) return formatClock(ms, format, language);
  const date = new Intl.DateTimeFormat(language, { day: "2-digit", month: "short" }).format(at);
  return `${date} ${formatClock(ms, format, language)}`;
}
