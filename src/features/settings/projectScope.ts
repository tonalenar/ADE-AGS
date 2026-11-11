import { create } from "zustand";

import { useUiStore } from "@/app/uiStore";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";

/**
 * O projeto que a página Projetos aplica os ajustes ("Aplicando configurações para …"). `null` é "todos os
 * projetos". Fica numa store, e não no componente, para o atalho do composer ("Padrões por projeto") abrir
 * direto nele: ver `openProjectSettings`.
 */
export interface ProjectScopeState {
  readonly cwd: string | null;
  readonly setCwd: (cwd: string | null) => void;
}

export const useProjectScopeStore = create<ProjectScopeState>((set) => ({
  cwd: null,
  setCwd: (cwd) => set({ cwd }),
}));

/**
 * Ponto de integração para o atalho do composer: escolhe o projeto, abre a página Projetos e rola até o bloco
 * de ajustes dele. Quem chama precisa já ter a tela de Configurações aberta (o modal é do app).
 */
export function openProjectSettings(cwd: string): void {
  useProjectScopeStore.getState().setCwd(cwd);
  useUiStore.getState().setSettingsSection("projects");
  useSettingsTargetStore.getState().goTo({ page: "projects", anchor: "projects-detail" });
}
