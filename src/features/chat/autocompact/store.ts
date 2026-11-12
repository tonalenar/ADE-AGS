import { create } from "zustand";

import { chatAutocompactPlans, loadAutoCompactConfig } from "./ipc";
import { DEFAULT_CONFIG, type AutoCompactConfig, type AutoCompactPlan } from "./model";

/** A configuração do autocompact e o mapa de agentes, lidos uma vez e compartilhados pelo medidor e pela tela de Personalização. */
interface AutoCompactState {
  config: AutoCompactConfig;
  loaded: boolean;
  plans: AutoCompactPlan[] | null;
  load: () => Promise<void>;
  set: (config: AutoCompactConfig) => void;
}

let request: Promise<void> | null = null;

export const useAutoCompact = create<AutoCompactState>((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,
  plans: null,
  load: () => {
    if (request) return request;
    request = Promise.all([
      loadAutoCompactConfig().catch(() => null),
      get().plans ? Promise.resolve(get().plans) : chatAutocompactPlans().catch(() => null),
    ])
      .then(([config, plans]) => set({ ...(config ? { config } : {}), ...(plans ? { plans } : {}), loaded: true }))
      .finally(() => { request = null; });
    return request;
  },
  set: (config) => set({ config, loaded: true }),
}));

/** A linha da conversa por protocolo de um agente (`local-acp:<id>` usa a de `local-acp`). */
export function chatPlanOf(plans: AutoCompactPlan[] | null, agentId: string): AutoCompactPlan | null {
  const id = agentId.startsWith("local-acp:") ? "local-acp" : agentId;
  return plans?.find((p) => p.surface === "chat" && p.agentId === id) ?? null;
}
