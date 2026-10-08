/**
 * Pedido para lançar o PTY de uma aba que ainda está só com o scrollback.
 * O watcher e o `peer tell` usam isto em vez de esperar um processo que ninguém montou.
 */
const wanted = new Set<string>();
const listeners = new Set<() => void>();

export function requestPtyLaunch(tabId: string): void {
  if (wanted.has(tabId)) {
    for (const listener of listeners) listener();
    return;
  }
  wanted.add(tabId);
  for (const listener of listeners) listener();
}

export function ptyLaunchRequested(tabId: string): boolean {
  return wanted.has(tabId);
}

export function subscribePtyLaunch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearPtyLaunch(tabId: string): void {
  wanted.delete(tabId);
}
