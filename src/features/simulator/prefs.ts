import { create } from "zustand";

import { SIMULATOR_CATEGORY_IDS } from "./categories";
import { simulatorSettings } from "./ipc";
import { exceptionsForProject, projectKey, withProjectExceptions } from "./prefsModel";

/** Minutos fora de vista até hibernar o aparelho (0 = nunca). */
export const HIBERNATE_OPTIONS = [0, 5, 10, 30] as const;

/** Preferências do simulador nesta máquina (localStorage, chave `cc-simulator`), espelhadas no backend
 *  (`simulator::lifecycle`), que é quem hiberna e acerta a prioridade. */
export interface SimulatorPrefsData {
  /** Modo leve: o iOS com prioridade baixa no pico do boot e fora de vista. */
  light: boolean;
  /** Modo máximo (opcional): além do modo leve, desliga push, compras/StoreKit e universal links no próximo boot. */
  lightMax: boolean;
  hibernateMin: number;
  /** Um aparelho ligado por vez: ligar outro hiberna o anterior. */
  single: boolean;
}

/** O que vai para o `localStorage`: as preferências do backend mais as exceções por categoria. */
interface StoredPrefs extends SimulatorPrefsData {
  /** Categorias que ficam ligadas por padrão quando o modo leve está ativo. */
  exceptions: string[];
  /** Exceções substituídas por projeto, indexadas pelo caminho do canvas. */
  projectExceptions: Record<string, string[]>;
}

interface SimulatorPrefs extends StoredPrefs {
  exceptionsForProject: (cwd: string) => string[];
  setExceptions: (exceptions: string[], cwd: string) => void;
  set: (patch: Partial<SimulatorPrefsData>) => void;
}

const KEY = "cc-simulator";

function readExceptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(SIMULATOR_CATEGORY_IDS);
  return [...new Set(value.filter((id): id is string => typeof id === "string" && ids.has(id)))];
}

function readProjects(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([cwd, exceptions]) => {
    const key = projectKey(cwd);
    return key ? [[key, readExceptions(exceptions)]] : [];
  }));
}

/** Lê e normaliza o JSON salvo em `localStorage`, tolerando campos ausentes ou inválidos. */
export function parseSimulatorPrefs(rawJson: string | null): SimulatorPrefsData {
  try {
    const raw = JSON.parse(rawJson ?? "{}") as Record<string, unknown>;
    const min = Number(raw.hibernateMin);
    return {
      light: raw.light !== false,
      lightMax: raw.lightMax === true,
      hibernateMin: (HIBERNATE_OPTIONS as readonly number[]).includes(min) ? min : 10,
      single: raw.single !== false,
    };
  } catch {
    return { light: true, lightMax: false, hibernateMin: 10, single: true };
  }
}

function read(): StoredPrefs {
  try {
    const rawJson = localStorage.getItem(KEY);
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(rawJson ?? "{}") as Record<string, unknown>;
    } catch {
      // JSON inválido: cai nos padrões.
    }
    return { ...parseSimulatorPrefs(rawJson), exceptions: readExceptions(raw.exceptions), projectExceptions: readProjects(raw.projectExceptions) };
  } catch {
    return { light: true, lightMax: false, hibernateMin: 10, single: true, exceptions: [], projectExceptions: {} };
  }
}

function persist({ light, lightMax, hibernateMin, single, exceptions, projectExceptions }: StoredPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ light, lightMax, hibernateMin, single, exceptions, projectExceptions }));
  } catch {
    // Sem localStorage (janela privada): vale só nesta sessão.
  }
}

export const useSimulatorPrefs = create<SimulatorPrefs>((set, get) => ({
  ...read(),
  exceptionsForProject: (cwd) => exceptionsForProject(get().exceptions, get().projectExceptions, cwd),
  setExceptions: (exceptions, cwd) => {
    const unique = readExceptions(exceptions);
    const next = withProjectExceptions({ global: get().exceptions, projects: get().projectExceptions }, cwd, unique);
    set({ exceptions: next.global, projectExceptions: next.projects });
    persist(get());
  },
  set: (patch) => {
    set(patch);
    persist(get());
    syncSimulatorPrefs();
  },
}));

/** Manda as preferências ao backend (na abertura do primeiro simulador e a cada mudança). */
export function syncSimulatorPrefs() {
  const { light, lightMax, hibernateMin, single } = useSimulatorPrefs.getState();
  simulatorSettings(hibernateMin, single, light, lightMax).catch(() => undefined);
}
