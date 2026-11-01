/**
 * «há 24 minutos» sob a mensagem (como no Claude Code). Usa o `Intl.RelativeTimeFormat` da língua da pessoa; menos de
 * um minuto é «agora». Sem carimbo não há hora. Pura (o relógio entra como argumento).
 */
export function relativeTime(at: number | undefined, now: number, language: string): string | null {
  if (at === undefined || !Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (seconds < 60) return rtf.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}
