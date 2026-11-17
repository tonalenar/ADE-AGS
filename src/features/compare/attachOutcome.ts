/** Sem attach, não grava a comparação (as entradas ficariam sem tabId). */
export function comparisonAfterAttach<T>(_prepared: T, attached: T | null): T | null {
  return attached ?? null;
}

export function shouldUpsertComparison<T>(attached: T | null): attached is T {
  return attached != null;
}
