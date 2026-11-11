import { useSyncExternalStore } from "react";

import { normalizeProjectPath } from "@/features/chat/chatProjectPrefs";
import {
  DEFAULT_PROJECT_ORDER_PREFS,
  PROJECT_ORDER_MODES,
  type ProjectOrderMode,
  type ProjectOrderPrefs,
  recordFirstSeen,
} from "@/features/chat/sidebar/projectOrder";

/**
 * A ordem dos projetos é uma preferência deste aparelho (`localStorage`, como a seção Trabalhando). A
 * data de aparecimento e a ordem manual são guardadas ao lado do modo, sem tocar no banco: nada de
 * migração, e apagar a preferência só volta ao padrão de exibição.
 */
export const PROJECT_ORDER_KEY = "cc-project-order";
const MAX_PROJECTS = 500;

const listeners = new Set<() => void>();
let cache: ProjectOrderPrefs | null = null;

function isMode(value: unknown): value is ProjectOrderMode {
  return typeof value === "string" && (PROJECT_ORDER_MODES as readonly string[]).includes(value);
}

/** Lê o que está gravado. Lixo ou armazenamento bloqueado valem o padrão, sem quebrar a barra. */
function parse(raw: string | null): ProjectOrderPrefs {
  if (!raw) return DEFAULT_PROJECT_ORDER_PREFS;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PROJECT_ORDER_PREFS;
    const record = value as Record<string, unknown>;
    const manual = Array.isArray(record.manual)
      ? record.manual.filter((key): key is string => typeof key === "string" && key.length > 0).slice(0, MAX_PROJECTS)
      : [];
    const created: Record<string, number> = {};
    if (record.created && typeof record.created === "object" && !Array.isArray(record.created)) {
      for (const [key, at] of Object.entries(record.created as Record<string, unknown>)) {
        if (typeof at === "number" && Number.isFinite(at) && at > 0) created[key] = at;
      }
    }
    return { mode: isMode(record.mode) ? record.mode : "activity", manual, created };
  } catch {
    return DEFAULT_PROJECT_ORDER_PREFS;
  }
}

function read(): ProjectOrderPrefs {
  try {
    return parse(localStorage.getItem(PROJECT_ORDER_KEY));
  } catch {
    return DEFAULT_PROJECT_ORDER_PREFS;
  }
}

function write(next: ProjectOrderPrefs): void {
  cache = next;
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(next));
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}

/** O valor atual (com cache: a mesma referência enquanto nada muda, como pede o `useSyncExternalStore`). */
export function readProjectOrderPrefs(): ProjectOrderPrefs {
  if (!cache) cache = read();
  return cache;
}

export function saveProjectOrderMode(mode: ProjectOrderMode): void {
  write({ ...readProjectOrderPrefs(), mode });
}

/** Grava a ordem escolhida à mão. As chaves passam pela normalização de pasta, como o resto da barra. */
export function saveManualProjectOrder(keys: readonly string[]): void {
  const manual = [...new Set(keys.map(normalizeProjectPath))].slice(0, MAX_PROJECTS);
  write({ ...readProjectOrderPrefs(), manual });
}

/** Anota quando cada projeto apareceu pela primeira vez. Não faz nada se todos já têm data. */
export function recordProjectsFirstSeen(keys: readonly string[], now: number = Date.now()): void {
  const current = readProjectOrderPrefs();
  const normalized = keys.map(normalizeProjectPath);
  const created = recordFirstSeen(current.created, normalized, now);
  if (Object.keys(created).length === Object.keys(current.created).length) return;
  write({ ...current, created });
}

/** Esquece a ordem manual e a data de um projeto (o "Remover personalização" da página). */
export function forgetProjectOrder(key: string): void {
  const normalized = normalizeProjectPath(key);
  const current = readProjectOrderPrefs();
  const created = Object.fromEntries(Object.entries(current.created).filter(([k]) => k !== normalized));
  write({ ...current, manual: current.manual.filter((k) => k !== normalized), created });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PROJECT_ORDER_KEY || event.key === null) {
      cache = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** O valor reativo: a barra e a página de Configurações ficam de acordo ao mudar a ordem. */
export function useProjectOrderPrefs(): ProjectOrderPrefs {
  return useSyncExternalStore(subscribe, readProjectOrderPrefs, readProjectOrderPrefs);
}
