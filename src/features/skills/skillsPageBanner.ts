/** O erro da lista: o store captura a falha, o catch da página não dispara. */
export function skillsPageBanner(storeError: string | null, localError: string | null): string | null {
  return storeError ?? localError;
}
