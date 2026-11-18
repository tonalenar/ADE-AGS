/** `setTimeout` que dá para cancelar ao desmontar o diálogo. */
export function createCancellableTimeout() {
  let id: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(ms: number, fn: () => void): void {
      if (id != null) clearTimeout(id);
      id = setTimeout(() => {
        id = null;
        fn();
      }, ms);
    },
    clear(): void {
      if (id == null) return;
      clearTimeout(id);
      id = null;
    },
  };
}
