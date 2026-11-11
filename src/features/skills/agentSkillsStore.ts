/** Cache das skills que o agente acha no disco, para o menu do `/`. Relê só quando a entrada envelhece. */
import { create } from "zustand";

import { agentSkillsScan } from "./ipc";
import type { AgentSkillScan } from "./types";

/** Quanto a varredura vale: o `/` abre muitas vezes na mesma pasta, e a varredura não precisa repetir. */
const TTL_MS = 30_000;

interface AgentSkillsEntry {
  skills: AgentSkillScan[];
  at: number;
}

interface AgentSkillsState {
  /** Por agente e pasta. */
  entries: Record<string, AgentSkillsEntry>;
  /** Busca em voo, para que abrir o menu duas vezes seguidas não varra duas vezes. */
  pending: Record<string, Promise<AgentSkillScan[]>>;
  load: (cwd: string, agentId: string) => Promise<AgentSkillScan[]>;
}

const keyOf = (cwd: string, agentId: string) => `${agentId}\u0000${cwd}`;

export const useAgentSkillsStore = create<AgentSkillsState>()((set, get) => ({
  entries: {},
  pending: {},
  load: (cwd, agentId) => {
    const key = keyOf(cwd, agentId);
    const cached = get().entries[key];
    if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.skills);
    const inFlight = get().pending[key];
    if (inFlight) return inFlight;

    const request = agentSkillsScan(cwd, agentId)
      .then((skills) => {
        set((state) => ({ entries: { ...state.entries, [key]: { skills, at: Date.now() } } }));
        return skills;
      })
      .finally(() => {
        set((state) => {
          const pending = { ...state.pending };
          delete pending[key];
          return { pending };
        });
      });
    set((state) => ({ pending: { ...state.pending, [key]: request } }));
    return request;
  },
}));
