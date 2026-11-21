/**
 * Wrappers IPC para o cofre de logins (`src-tauri/src/vault/mod.rs`).
 *
 * Somente `vaultSecretForFill` devolve a senha, e apenas depois que o backend valida
 * que `pageUrl` corresponde à origem cadastrada.
 */
import { invoke } from "@tauri-apps/api/core";

import type { VaultEntry } from "./types";

export const vaultList = () => invoke<VaultEntry[]>("vault_list");

export const vaultAdd = (origin: string, username: string, label: string, password: string) =>
  invoke<VaultEntry>("vault_add", { origin, username, label, password });

export const vaultUpdate = (
  id: string,
  patch: { username?: string; label?: string; password?: string },
) =>
  invoke<VaultEntry>("vault_update", {
    id,
    username: patch.username ?? null,
    label: patch.label ?? null,
    password: patch.password ?? null,
  });

export const vaultRemove = (id: string) => invoke<void>("vault_remove", { id });

export const vaultAllowAgent = (id: string, agent: string) =>
  invoke<VaultEntry>("vault_allow_agent", { id, agent });

export const vaultRevokeAgent = (id: string, agent: string) =>
  invoke<VaultEntry>("vault_revoke_agent", { id, agent });

export const vaultSecretForFill = (id: string, pageUrl: string) =>
  invoke<string>("vault_secret_for_fill", { id, pageUrl });
