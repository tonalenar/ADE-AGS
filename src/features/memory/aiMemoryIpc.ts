import { invoke } from "@tauri-apps/api/core";

import type { AiMemoryHandoff, AiMemoryPage, AiMemoryProbe, AiMemoryRecentPage, AiMemoryUntrusted } from "./aiMemory";

/** Leitura do ai-memory externo pelo binário (`src-tauri/src/ai_memory/commands.rs`). `cwd` é a pasta da aba. */
export const aiMemoryProbe = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryProbe>>("ai_memory_probe", { cwd });

export const aiMemoryHandoffs = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryHandoff[]>>("ai_memory_handoffs", { cwd });

export const aiMemoryRecent = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryRecentPage[]>>("ai_memory_recent", { cwd });

export const aiMemoryReadPage = (cwd: string, path: string) =>
  invoke<AiMemoryUntrusted<AiMemoryPage>>("ai_memory_read_page", { cwd, path });
