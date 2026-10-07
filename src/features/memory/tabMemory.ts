import { invoke } from "@tauri-apps/api/core";

import { briefingFor } from "@/features/missions/terminals";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

type TabLike = Pick<Tab, "id" | "agentId" | "memoryBlock">;

/**
 * Mensagem com o índice da memória aprovada para a tab, ou `null` se não deve mandar nada:
 * desligado (padrão), tab de shell (texto não confiável nunca vira entrada de um shell), falha
 * ou índice vazio. O envelope ("DADOS, NAO INSTRUCOES") vem pronto do núcleo (`memory_index`);
 * aqui só se ajusta ao formato da TUI.
 */
export async function tabMemoryMessage(tab: TabLike, workspaceId: string): Promise<string | null> {
  if (!tab.memoryBlock || tab.agentId === SHELL_AGENT_ID) return null;
  try {
    const envelope = await invoke<string>("memory_index", { workspaceId });
    if (!envelope || !envelope.trim()) return null;
    return briefingFor(tab.agentId, envelope.trim());
  } catch {
    return null;
  }
}

/**
 * Tab interativa fora de missão: se `memoryBlock` está ligado (padrão: desligado), manda UMA vez,
 * ao abrir a sessão, o índice da memória aprovada do workspace. Se falhar ou vier vazio, a tab
 * abre normal. Devolve se mandou algo. Quem também tem um prompt inicial deve juntar os dois
 * (`tabMemoryMessage`) e fazer um único `sendWhenReady`.
 */
export async function injectTabMemory(tab: TabLike, workspaceId: string): Promise<boolean> {
  const message = await tabMemoryMessage(tab, workspaceId);
  if (message === null) return false;
  sendWhenReady(tab.id, message);
  return true;
}

/** A memória nunca vai para um shell, mesmo que o interruptor tenha ficado ligado antes de trocar de agente. */
export const memoryBlockFor = (agentId: string, memoryBlock: boolean): boolean => memoryBlock && agentId !== SHELL_AGENT_ID;

/** Memória (dados) primeiro, prompt do usuário por último; um único texto para um único envio. */
export const startupText = (memory: string | null, prompt: string | undefined): string =>
  [memory, prompt].filter((part): part is string => !!part).join("\n\n");
