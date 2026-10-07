import { invoke } from "@tauri-apps/api/core";

import { briefingFor } from "@/features/missions/terminals";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import type { Tab } from "@/features/tabs/types";

/**
 * Tab interativa fora de missão: se `memoryBlock` está ligado (padrão: desligado), manda UMA vez,
 * ao abrir a sessão, o índice da memória aprovada do workspace. O envelope ("DADOS, NAO
 * INSTRUCOES") vem pronto do núcleo (`memory_index`); aqui só se ajusta ao formato da TUI.
 * Se falhar ou vier vazio, a tab abre normal. Devolve se mandou algo.
 */
export async function injectTabMemory(tab: Pick<Tab, "id" | "agentId" | "memoryBlock">, workspaceId: string): Promise<boolean> {
  if (!tab.memoryBlock) return false;
  try {
    const envelope = await invoke<string>("memory_index", { workspaceId });
    if (!envelope || !envelope.trim()) return false;
    sendWhenReady(tab.id, briefingFor(tab.agentId, envelope.trim()));
    return true;
  } catch {
    return false;
  }
}
