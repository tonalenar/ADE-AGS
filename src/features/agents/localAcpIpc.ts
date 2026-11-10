import { invoke } from "@tauri-apps/api/core";

export interface LocalAcpProvider {
  id: string;
  label: string;
}

export interface LocalAcpConfig extends LocalAcpProvider {
  command: string;
  args: string[];
}

export type LocalAcpDraft = Omit<LocalAcpConfig, "id"> & { id?: string };

export const listLocalAcp = () => invoke<LocalAcpProvider[]>("local_acp_list");
export const getLocalAcp = (id: string) => invoke<LocalAcpConfig>("local_acp_get", { id });
export const upsertLocalAcp = (draft: LocalAcpDraft) => invoke<LocalAcpProvider>("local_acp_upsert", { draft });
export const deleteLocalAcp = (id: string) => invoke<void>("local_acp_delete", { id });
