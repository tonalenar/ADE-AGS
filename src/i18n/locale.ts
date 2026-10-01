export const LANGUAGE_OPTIONS = [
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
] as const;

export function resolveLocale(saved: string | null, system: string = ""): string {
  const normalized = saved?.toLowerCase();
  if (normalized?.startsWith("pt")) return "pt-BR";
  if (normalized === "en" || normalized === "es") return normalized;
  if (system.toLowerCase().startsWith("pt")) return "pt-BR";
  return "pt-BR";
}

export function persistLocale(storage: Pick<Storage, "setItem">, locale: string): string {
  const selected = resolveLocale(locale);
  storage.setItem("language", selected);
  return selected;
}
