import { useUiStore } from "@/app/uiStore";
import { useChatStore } from "@/features/chat/store";
import { loadChatPrefs } from "@/features/chat/chatPrefs";
import { useStructured } from "@/features/chat/structured/store";
import { useTabsStore } from "@/features/tabs/store";
import { normalizeProjectPath } from "./chatProjectPrefs";

/** Pasta usada para resolver ações e atalhos no contexto atualmente visível. */
export function activeProjectScriptCwd(): string | null {
  const ui = useUiStore.getState();
  const chat = useChatStore.getState();

  if (ui.chatMode && ui.shellMode === "chat") {
    if (chat.thread) {
      return useStructured.getState().threads.find((thread) => thread.id === chat.thread)?.cwd ?? null;
    }
    if (chat.composing) return chat.composeFolder ?? loadChatPrefs().cwd;
  }

  const tabs = useTabsStore.getState();
  return tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.cwd ?? null;
}

/** IDs curtos e seguros para a preferência local, sem expor caminhos no catálogo de atalhos. */
export function projectScriptShortcutId(cwd: string, scriptId: string): string {
  return `script.${stableHash(normalizeProjectPath(cwd))}.${stableHash(scriptId)}.run`;
}

function stableHash(value: string): string {
  // Duas rodadas independentes de FNV-1a formam um namespace estável de 64 bits.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
