/** O botão fica desativado só enquanto lê, ou quando já está no padrão e a leitura deu certo. */
export function restoreDefaultsDisabled(
  changed: readonly unknown[] | null,
  loadFailed = false,
): boolean {
  if (loadFailed) return false;
  return changed === null || changed.length === 0;
}
