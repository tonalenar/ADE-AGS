export {};

/**
 * Nos testes os três idiomas ficam carregados antes de cada arquivo, como era quando iam estáticos no
 * entry (no app só o ativo vem antes do primeiro pintado, ver `i18n/index.ts`). Só carrega se o
 * arquivo de teste já tiver como importar o i18n (DOM com localStorage); os de lógica pura não usam.
 */
if (typeof localStorage !== "undefined") {
  const { loadLocale } = await import("@/i18n/index");
  await Promise.all(["pt-BR", "en", "es"].map(loadLocale));
}
