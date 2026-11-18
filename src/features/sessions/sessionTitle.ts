import { sessionTitle } from "./ipc";
import type { Tab } from "@/features/tabs/types";

/** Fecha a aba sem esperar a leitura do transcript para sempre. */
export const TITLE_REFRESH_MS = 1500;

/** Pide al backend un título legible derivado de la sesión real del agente. */
export async function refreshSessionTitle(tab: Tab): Promise<string> {
  if (tab.titleIsCustom) return tab.title;
  try {
    const result = await Promise.race([
      sessionTitle({
        agentId: tab.agentId,
        cwd: tab.cwd,
        sessionId: tab.sessionId ?? null,
        fallback: tab.title,
        accountId: tab.accountId ?? null,
      }),
      new Promise<{ title: string }>((resolve) => {
        setTimeout(() => resolve({ title: tab.title }), TITLE_REFRESH_MS);
      }),
    ]);
    return result.title;
  } catch {
    return tab.title;
  }
}
