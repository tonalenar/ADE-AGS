import { create } from "zustand";
import i18n from "i18next";
import type { SkillSummary } from "@/features/skills/types";
import { createGeneration } from "@/shared/generation";
import { AlertaToast } from "@/shared/ui/alerts";
import * as ipc from "./ipc";
import type { MarketplaceSkillEntry, RegistrySourceType, RegistrySummary } from "./types";

const skillsGen = createGeneration();

function reportMarketplaceError(error: unknown): string {
  const text = String(error);
  void AlertaToast(i18n.t("marketplace.error.title"), text, "error", 6000);
  return text;
}

interface MarketplaceState {
  registries: RegistrySummary[];
  skills: MarketplaceSkillEntry[];
  loading: boolean;
  /** Una búsqueda contra un repo remoto en curso (skills.sh). Es lenta y separada de
   *  `loading`, que solo cubre releer lo que ya está en la base. */
  searchingRemote: boolean;
  refreshingId: string | null;
  installingKey: string | null;
  error: string | null;

  loadRegistries: () => Promise<void>;
  loadSkills: (query?: string, category?: string) => Promise<void>;
  /** Busca en los repos que no se pueden listar de antemano (skills.sh) y refresca la
   *  lista con lo que encuentre. No hace nada si no hay ninguno configurado. */
  searchRemote: (query: string) => Promise<void>;
  /** `id` es opcional pero conviene mandarlo: los eventos de progreso vienen etiquetados
   *  con él, y esta promesa recién resuelve cuando el repo terminó de resolverse. */
  addRegistry: (name: string, sourceType: RegistrySourceType, location: string, id?: string) => Promise<void>;
  renameRegistry: (id: string, name: string) => Promise<void>;
  /** Borra el repo Y sus skills instaladas. Devuelve cuántas skills se llevó. */
  removeRegistry: (id: string) => Promise<number>;
  /** Skills instaladas desde este repo — para listarlas antes de borrarlo. */
  registrySkills: (id: string) => Promise<SkillSummary[]>;
  setRegistryEnabled: (id: string, enabled: boolean) => Promise<void>;
  refreshRegistry: (id: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  installSkill: (registryId: string, skillId: string) => Promise<SkillSummary>;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  registries: [],
  skills: [],
  loading: false,
  searchingRemote: false,
  refreshingId: null,
  installingKey: null,
  error: null,

  loadRegistries: async () => {
    try {
      const registries = await ipc.listRegistries();
      set({ registries, error: null });
    } catch (e) {
      set({ error: reportMarketplaceError(e) });
      throw e;
    }
  },

  loadSkills: async (query, category) => {
    const gen = skillsGen.next();
    set({ loading: true, error: null });
    try {
      const skills = await ipc.listMarketplaceSkills(query, category);
      if (!skillsGen.isCurrent(gen)) return;
      set({ skills });
    } catch (e) {
      if (!skillsGen.isCurrent(gen)) return;
      set({ error: reportMarketplaceError(e) });
    } finally {
      if (skillsGen.isCurrent(gen)) set({ loading: false });
    }
  },

  searchRemote: async (query) => {
    const hasRemote = get().registries.some((r) => r.sourceType === "skillssh" && r.enabled);
    if (!hasRemote || query.trim().length < 2) return;
    set({ searchingRemote: true });
    try {
      await ipc.searchRemoteRegistries(query);
      // El backend deja los resultados en el cache del repo; releerlo es lo que los trae
      // a la grilla. `loadRegistries` además refresca el error del repo (ej. falta Node).
      await get().loadRegistries();
      await get().loadSkills(query);
    } catch (e) {
      reportMarketplaceError(e);
    } finally {
      set({ searchingRemote: false });
    }
  },

  addRegistry: async (name, sourceType, location, id) => {
    try {
      await ipc.addRegistry(name, sourceType, location, id);
      await get().loadRegistries();
      await get().loadSkills();
    } catch (e) {
      reportMarketplaceError(e);
      throw e;
    }
  },

  renameRegistry: async (id, name) => {
    try {
      await ipc.renameRegistry(id, name);
      await get().loadRegistries();
      await get().loadSkills();
    } catch (e) {
      reportMarketplaceError(e);
      throw e;
    }
  },

  removeRegistry: async (id) => {
    const removedSkills = await ipc.removeRegistry(id);
    await get().loadRegistries();
    await get().loadSkills();
    return removedSkills;
  },

  registrySkills: async (id) => ipc.registrySkills(id),

  setRegistryEnabled: async (id, enabled) => {
    try {
      await ipc.setRegistryEnabled(id, enabled);
      await get().loadRegistries();
      await get().loadSkills();
    } catch (e) {
      reportMarketplaceError(e);
      throw e;
    }
  },

  refreshRegistry: async (id) => {
    set({ refreshingId: id });
    try {
      await ipc.refreshRegistry(id);
      await get().loadRegistries();
      await get().loadSkills();
    } catch (e) {
      reportMarketplaceError(e);
      throw e;
    } finally {
      set({ refreshingId: null });
    }
  },

  refreshAll: async () => {
    const { registries } = get();
    const failures: string[] = [];
    for (const r of registries) {
      // Secuencial a propósito: son requests a APIs públicas externas (rate limit anónimo
      // de GitHub incluido) — en paralelo, refrescar varios repos a la vez multiplica el
      // riesgo de pegarle a ese límite en una sola pasada.
      try {
        await get().refreshRegistry(r.id);
      } catch (e) {
        failures.push(`${r.name}: ${String(e)}`);
      }
    }
    if (failures.length) set({ error: failures.join("\n") });
  },

  installSkill: async (registryId, skillId) => {
    const key = `${registryId}:${skillId}`;
    set({ installingKey: key });
    try {
      return await ipc.installMarketplaceSkill(registryId, skillId);
    } finally {
      set({ installingKey: null });
    }
  },
}));
