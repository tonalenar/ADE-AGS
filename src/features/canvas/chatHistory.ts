import { invoke } from "@tauri-apps/api/core";

const inflight = new Map<string, Promise<unknown>>();

/** Uma leitura de histórico por aba: o watcher de não lidos e o painel compartilham a mesma promessa. */
export function loadChatHistory<T>(tabId: string): Promise<T> {
  const hit = inflight.get(tabId);
  if (hit) return hit as Promise<T>;
  const pending = invoke<T>("chat_history", { tabId }).finally(() => {
    if (inflight.get(tabId) === pending) inflight.delete(tabId);
  });
  inflight.set(tabId, pending);
  return pending;
}

export function resetChatHistoryInflightForTests(): void {
  inflight.clear();
}
