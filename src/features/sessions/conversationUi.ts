import { create } from "zustand";

/**
 * O que está recolhido na lista de conversas: projetos inteiros e grupos por dia. Fica na máquina (localStorage):
 * é só preferência de tela. Sem localStorage (ou com lixo guardado), tudo começa aberto, menos "Mais antigas".
 */
const KEY = "ade-conversations-collapsed";

interface Collapsed {
  /** Projetos (pela raiz) com a lista toda recolhida. */
  projects: Record<string, boolean>;
  /** Grupos por dia recolhidos (`older`, `week`…). `undefined` = o padrão do grupo. */
  buckets: Record<string, boolean>;
}

/** Lê o guardado: só objetos de booleanos; o resto é lixo e se ignora. Pura. */
export function parseCollapsed(raw: string | null): Collapsed {
  const empty: Collapsed = { projects: {}, buckets: {} };
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const pick = (value: unknown): Record<string, boolean> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>
        : {};
    const obj = parsed as Record<string, unknown>;
    return { projects: pick(obj.projects), buckets: pick(obj.buckets) };
  } catch {
    return empty;
  }
}

/** O grupo começa recolhido? Só os mais antigos: o resto é o que a pessoa quer ver. Pura. */
export function bucketDefaultCollapsed(bucket: string): boolean {
  return bucket === "older";
}

function load(): Collapsed {
  try {
    return parseCollapsed(localStorage.getItem(KEY));
  } catch {
    return { projects: {}, buckets: {} };
  }
}

function save(state: Collapsed): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* não lembrar não impede de usar */
  }
}

interface UiState extends Collapsed {
  toggleProject: (projectKey: string) => void;
  toggleBucket: (bucket: string) => void;
  /** Recolhe (ou abre) todos os projetos de uma vez. */
  setAllProjects: (projectKeys: string[], collapsed: boolean) => void;
}

export const useConversationUi = create<UiState>((set, get) => ({
  ...load(),
  toggleProject: (projectKey) => {
    const projects = { ...get().projects, [projectKey]: !get().projects[projectKey] };
    set({ projects });
    save({ projects, buckets: get().buckets });
  },
  toggleBucket: (bucket) => {
    const current = get().buckets[bucket] ?? bucketDefaultCollapsed(bucket);
    const buckets = { ...get().buckets, [bucket]: !current };
    set({ buckets });
    save({ projects: get().projects, buckets });
  },
  setAllProjects: (projectKeys, collapsed) => {
    const projects = { ...get().projects, ...Object.fromEntries(projectKeys.map((key) => [key, collapsed])) };
    set({ projects });
    save({ projects, buckets: get().buckets });
  },
}));
