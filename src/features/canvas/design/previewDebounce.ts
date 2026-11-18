/** Intervalo para o srcdoc da pré-visualização acompanhar o rascunho, sem recarregar a cada tecla. */
export const PREVIEW_DEBOUNCE_MS = 400;

export function scheduleDebounced(handle: { id?: ReturnType<typeof setTimeout> }, wait: number, apply: () => void): void {
  if (handle.id !== undefined) clearTimeout(handle.id);
  handle.id = setTimeout(() => {
    handle.id = undefined;
    apply();
  }, wait);
}
