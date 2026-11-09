import { join } from "@tauri-apps/api/path";

import { fileStat, readFile } from "@/features/editor/ipc";

export type ChatThreadEnvMode = "local" | "worktree";
export type ChatWorkspaceModeSource = "project" | "machine" | "t3" | "legacy" | "builtin" | "conversation";
export type ChatWorktreeSubmodules = "recursive" | "top-level" | "none";
export type ChatWorktreeSubmodulesSource = "project" | "machine" | "t3" | "builtin";

export interface ChatT3WorkspacePrefs {
  threadEnvMode: ChatThreadEnvMode | null;
  worktreeSubmodules: ChatWorktreeSubmodules | null;
}

const MACHINE_DEFAULT_KEY = "cc-chat-thread-env-mode";
const LEGACY_MIGRATION_KEY = "cc-chat-thread-env-mode-migrated";
const LEGACY_CHAT_PREFS_KEY = "cc-chat-prefs";
// O t3.json também pode conter scripts; usa o mesmo teto aceito pela leitura já existente.
const MAX_T3_CONFIG_BYTES = 5 * 1024 * 1024;

export function parseT3ThreadEnvMode(value: unknown): ChatThreadEnvMode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mode = (value as Record<string, unknown>).defaultThreadEnvMode;
  return mode === "local" || mode === "worktree" ? mode : null;
}

export function parseT3WorktreeSubmodules(value: unknown): ChatWorktreeSubmodules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mode = (value as Record<string, unknown>).worktreeSubmodules;
  return mode === "recursive" || mode === "top-level" || mode === "none" ? mode : null;
}

export function parseT3WorkspacePrefs(value: unknown): ChatT3WorkspacePrefs {
  return { threadEnvMode: parseT3ThreadEnvMode(value), worktreeSubmodules: parseT3WorktreeSubmodules(value) };
}

export async function readT3WorkspacePrefs(cwd: string): Promise<ChatT3WorkspacePrefs> {
  const path = await join(cwd, "t3.json");
  const stat = await fileStat(path);
  if (!stat) return { threadEnvMode: null, worktreeSubmodules: null };
  if (stat.size > MAX_T3_CONFIG_BYTES) throw new Error("O t3.json excede o limite de 5 MiB para configurações do projeto.");
  const file = await readFile(path);
  if (file.kind === "tooLarge") throw new Error("O t3.json mudou e excedeu o limite de leitura.");
  if (file.kind !== "text") throw new Error("O t3.json não é um arquivo de texto UTF-8.");
  if (new TextEncoder().encode(file.content).byteLength > MAX_T3_CONFIG_BYTES) {
    throw new Error("O t3.json excede o limite de 5 MiB para configurações do projeto.");
  }
  return parseT3WorkspacePrefs(JSON.parse(file.content));
}

export async function readT3ThreadEnvMode(cwd: string): Promise<ChatThreadEnvMode | null> {
  return (await readT3WorkspacePrefs(cwd)).threadEnvMode;
}

export function resolveChatThreadEnvMode(input: {
  projectOverride: boolean | null;
  machineOverride: ChatThreadEnvMode | null;
  t3Default: ChatThreadEnvMode | null;
  legacyDefault: boolean;
}): { worktree: boolean; source: Exclude<ChatWorkspaceModeSource, "conversation"> } {
  if (input.projectOverride !== null) return { worktree: input.projectOverride, source: "project" };
  if (input.machineOverride !== null) return { worktree: input.machineOverride === "worktree", source: "machine" };
  if (input.t3Default !== null) return { worktree: input.t3Default === "worktree", source: "t3" };
  if (input.legacyDefault) return { worktree: true, source: "legacy" };
  return { worktree: false, source: "builtin" };
}

export function resolveChatWorktreeSubmodules(input: {
  projectOverride: ChatWorktreeSubmodules | null;
  machineOverride: ChatWorktreeSubmodules | null;
  t3Default: ChatWorktreeSubmodules | null;
}): { mode: ChatWorktreeSubmodules; source: ChatWorktreeSubmodulesSource } {
  if (input.projectOverride !== null) return { mode: input.projectOverride, source: "project" };
  if (input.machineOverride !== null) return { mode: input.machineOverride, source: "machine" };
  if (input.t3Default !== null) return { mode: input.t3Default, source: "t3" };
  return { mode: "none", source: "builtin" };
}

export function loadChatThreadEnvMode(): ChatThreadEnvMode | null {
  try {
    const value = localStorage.getItem(MACHINE_DEFAULT_KEY);
    return value === "local" || value === "worktree" ? value : null;
  } catch {
    return null;
  }
}

export function saveChatThreadEnvMode(mode: ChatThreadEnvMode | null): void {
  try {
    localStorage.setItem(LEGACY_MIGRATION_KEY, "1");
    if (mode === null) localStorage.removeItem(MACHINE_DEFAULT_KEY);
    else localStorage.setItem(MACHINE_DEFAULT_KEY, mode);
  } catch {
    // A preferência desta máquina não impede iniciar a conversa.
  }
}

/** Migra apenas o antigo opt-in de worktree; o antigo `false` era também o padrão do app. */
export function loadOrMigrateChatThreadEnvMode(): ChatThreadEnvMode | null {
  try {
    const current = localStorage.getItem(MACHINE_DEFAULT_KEY);
    if (current === "local" || current === "worktree") return current;
    if (localStorage.getItem(LEGACY_MIGRATION_KEY) === "1") return null;
    const legacyRaw = localStorage.getItem(LEGACY_CHAT_PREFS_KEY);
    if (legacyRaw) {
      const legacy: unknown = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
        const value = (legacy as Record<string, unknown>).worktree;
        if (typeof value === "boolean") {
          const mode = value ? "worktree" : null;
          if (mode) localStorage.setItem(MACHINE_DEFAULT_KEY, mode);
          localStorage.setItem(LEGACY_MIGRATION_KEY, "1");
          return mode;
        }
      }
    }
    localStorage.setItem(LEGACY_MIGRATION_KEY, "1");
  } catch {
    // Armazenamento indisponível: conserva o comportamento padrão da conversa.
  }
  return null;
}
