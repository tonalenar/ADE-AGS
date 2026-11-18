import i18next from "i18next";

/**
 * O locale das datas segue o IDIOMA DO APP, não o do sistema: com o Windows em inglês e o app em
 * português, `toLocaleString()` sem argumento mostrava datas no formato errado. Usa o mesmo mapa
 * da memória compartilhada (pt-BR por padrão).
 */
export function dateLocale(): string {
  const language = i18next.language ?? "pt-BR";
  if (language.startsWith("es")) return "es-ES";
  if (language.startsWith("en")) return "en-US";
  return "pt-BR";
}

/** Locale de números segue o idioma do app, separado do das datas. */
export function numberLocale(): string {
  return dateLocale();
}

export function formatNumber(n: number): string {
  return n.toLocaleString(numberLocale());
}
