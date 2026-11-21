import { create } from "zustand";

import type {
  VaultConfirmDecision,
  VaultEntry,
  VaultPrompt,
  VaultRegisterResult,
} from "./types";

interface VaultPromptState {
  prompts: VaultPrompt[];
  requestRegister: (input: {
    origin: string;
    reason: string;
    from: string;
    fromId: string;
    timeoutMs: number;
  }) => Promise<VaultRegisterResult>;
  requestConfirm: (input: {
    entry: VaultEntry;
    pageOrigin: string;
    from: string;
    fromId: string;
    timeoutMs?: number;
  }) => Promise<VaultConfirmDecision>;
  resolveRegister: (id: string, result: VaultRegisterResult) => void;
  resolveConfirm: (id: string, decision: VaultConfirmDecision) => void;
  drop: (id: string) => void;
}

export const useVaultPromptStore = create<VaultPromptState>((set, get) => ({
  prompts: [],

  requestRegister: ({ origin, reason, from, fromId, timeoutMs }) =>
    new Promise<VaultRegisterResult>((resolve) => {
      const id = crypto.randomUUID();
      let done = false;
      const finish = (result: VaultRegisterResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: "pending" }), timeoutMs);
      set((s) => ({
        prompts: [
          ...s.prompts,
          {
            mode: "register",
            id,
            origin,
            reason,
            from,
            fromId,
            expiresAt: Date.now() + timeoutMs,
            resolve: finish,
          },
        ],
      }));
    }),

  requestConfirm: ({ entry, pageOrigin, from, fromId, timeoutMs = 300_000 }) =>
    new Promise<VaultConfirmDecision>((resolve) => {
      const id = crypto.randomUUID();
      let done = false;
      const finish = (decision: VaultConfirmDecision) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
        resolve(decision);
      };
      const timer = setTimeout(() => finish("decline"), timeoutMs);
      set((s) => ({
        prompts: [
          ...s.prompts,
          {
            mode: "confirm",
            id,
            entry,
            pageOrigin,
            from,
            fromId,
            expiresAt: Date.now() + timeoutMs,
            resolve: finish,
          },
        ],
      }));
    }),

  resolveRegister: (id, result) => {
    const prompt = get().prompts.find((p) => p.id === id && p.mode === "register");
    if (prompt && prompt.mode === "register") prompt.resolve(result);
  },

  resolveConfirm: (id, decision) => {
    const prompt = get().prompts.find((p) => p.id === id && p.mode === "confirm");
    if (prompt && prompt.mode === "confirm") prompt.resolve(decision);
  },

  drop: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),
}));
