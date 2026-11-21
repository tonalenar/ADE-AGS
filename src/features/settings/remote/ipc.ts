import { invoke } from "@tauri-apps/api/core";

/**
 * Chamadas IPC para o servidor MCP HTTP remoto (ver `src-tauri/src/remote/mod.rs`).
 */

export type RemotePreset = "read" | "browser" | "agents" | "all";

export interface RemoteClient {
  id: string;
  name: string;
  preset: RemotePreset;
  folders: string[];
  default_folder: string;
  created_at: number;
  expires_at: number | null;
  last_seen_at: number | null;
  revoked: boolean;
}

export interface RemoteServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  tailscaleIp: string | null;
  bindAddrs: string[];
}

export interface PairedClientResult {
  client: RemoteClient;
  token: string;
}

export const remoteStatus = (): Promise<RemoteServerStatus> =>
  invoke<RemoteServerStatus>("remote_status");

export const remoteSetEnabled = (enabled: boolean, port?: number): Promise<RemoteServerStatus> =>
  invoke<RemoteServerStatus>("remote_set_enabled", { enabled, port: port ?? null });

export const remoteClientsList = (): Promise<RemoteClient[]> =>
  invoke<RemoteClient[]>("remote_clients_list");

export const remoteClientPair = (args: {
  name: string;
  preset: RemotePreset;
  folders: string[];
  defaultFolder: string;
  ttlDays: number | null;
}): Promise<PairedClientResult> =>
  invoke<PairedClientResult>("remote_client_pair", {
    name: args.name,
    preset: args.preset,
    folders: args.folders,
    defaultFolder: args.defaultFolder,
    ttlDays: args.ttlDays,
  });

export const remoteClientRevoke = (id: string): Promise<boolean> =>
  invoke<boolean>("remote_client_revoke", { id });
