import { invoke } from "@tauri-apps/api/core";

import type { AiMemoryHandoff, AiMemoryMigrationRow, AiMemoryMigrationSummary, AiMemoryPage, AiMemoryProbe, AiMemoryProject, AiMemoryRecentPage, AiMemorySession, AiMemoryUntrusted } from "./aiMemory";

/** Leitura do ai-memory externo pelo binário (`src-tauri/src/ai_memory/commands.rs`). `cwd` é a pasta da aba. */
export const aiMemoryProbe = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryProbe>>("ai_memory_probe", { cwd });

export const aiMemoryHandoffs = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryHandoff[]>>("ai_memory_handoffs", { cwd });

export const aiMemoryRecent = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryRecentPage[]>>("ai_memory_recent", { cwd });

export const aiMemoryReadPage = (cwd: string, path: string) =>
  invoke<AiMemoryUntrusted<AiMemoryPage>>("ai_memory_read_page", { cwd, path });

export const aiMemoryProjects = (cwd: string) =>
  invoke<AiMemoryUntrusted<AiMemoryProject[]>>("ai_memory_projects", { cwd });

/** Sessões de um projeto escolhido explicitamente (o servidor não sabe a pasta da aba nesse caminho). */
export const aiMemorySessions = (workspace: string, project: string) =>
  invoke<AiMemoryUntrusted<AiMemorySession[]>>("ai_memory_sessions", { workspace, project });

/** Cópia única e idempotente das memórias aprovadas do ADE para o wiki do ai-memory. */
export const aiMemoryMigrate = (workspaceId: string, cwd: string) =>
  invoke<AiMemoryMigrationSummary>("ai_memory_migrate", { workspaceId, cwd: cwd || null });

export const aiMemoryMigrationReport = (workspaceId: string) =>
  invoke<AiMemoryMigrationRow[]>("ai_memory_migration_report", { workspaceId });
