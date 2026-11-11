import { loadChatProjectDefaults, loadChatProjectSettings, saveChatProjectField } from "./chatProjectPrefs";
import { fastModeSupported } from "./chatModel";
import { loadChatPrefs, saveChatPrefs } from "./chatPrefs";

/** Resolve Fast por projeto para cada turno estruturado, herdando a preferência da máquina. */
export function fastModeForThread(thread: { agentId: string; cwd: string }): boolean {
  if (!fastModeSupported(thread.agentId, "chat")) return false;
  return loadChatProjectDefaults(thread.cwd)?.fastMode ?? loadChatPrefs().fastMode;
}

/** Atualiza a preferência que governa esta conversa: o projeto, quando fixa Fast, ou a máquina. */
export function saveFastModeForThread(thread: { agentId: string; cwd: string }, fastMode: boolean): boolean {
  if (!fastModeSupported(thread.agentId, "chat")) return false;
  if (loadChatProjectSettings(thread.cwd).projectFields.includes("fastMode")) {
    return saveChatProjectField(thread.cwd, "fastMode", fastMode);
  }
  saveChatPrefs({ ...loadChatPrefs(), fastMode });
  return true;
}
