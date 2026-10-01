import { invoke } from "@tauri-apps/api/core";

import type { FunctionalRole, Squad, SquadInput } from "./types";

export const listFunctionalRoles = () => invoke<FunctionalRole[]>("functional_roles_list");
export const getFunctionalRole = (roleId: string) => invoke<FunctionalRole>("functional_role_get", { roleId });

export const listSquads = () => invoke<Squad[]>("squad_list");
export const getSquad = (squadId: string) => invoke<Squad>("squad_get", { squadId });
export const createSquad = (input: SquadInput) => invoke<Squad>("squad_create", { input });
export const updateSquad = (squadId: string, input: SquadInput) => invoke<Squad>("squad_update", { squadId, input });
export const deleteSquad = (squadId: string) => invoke<void>("squad_delete", { squadId });
